const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

// Initialize config (same as above)
function initConfig() {
    const required = ['FIREBASE_SERVICE_ACCOUNT', 'FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_SECRET_HASH'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error('Missing required env vars:', missing.join(', '));
        throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }

    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
    } catch (err) {
        console.error('Failed to initialize Firebase:', err.message);
        throw new Error('Firebase initialization failed');
    }

    return {
        db: admin.firestore(),
        flwSecret: process.env.FLUTTERWAVE_SECRET_KEY,
        secretHash: process.env.FLUTTERWAVE_SECRET_HASH
    };
}

const config = initConfig();
const db = config.db;
const FLW_SECRET = config.flwSecret;
const FLW_BASE = 'https://api.flutterwave.com/v3';
const SECRET_HASH = config.secretHash;

module.exports = async (req, res) => {
    // Verify webhook signature
    const hash = req.headers['verif-hash'];
    if (!hash || hash !== SECRET_HASH) {
        console.error('❌ Invalid webhook signature');
        return res.status(401).send('Unauthorized');
    }

    const event = req.body;
    const webhookId = event.data?.id || event.data?.tx_ref || `webhook-${Date.now()}`;

    try {
        // Atomic webhook deduplication
        const result = await db.runTransaction(async (transaction) => {
            const eventRef = db.collection('webhook_events').doc(webhookId);
            const eventSnap = await transaction.get(eventRef);

            if (eventSnap.exists) {
                console.log('⚠️ Duplicate webhook ignored:', webhookId);
                return { duplicate: true };
            }

            // Create event record
            transaction.set(eventRef, {
                eventId: webhookId,
                receivedAt: admin.firestore.FieldValue.serverTimestamp(),
                processed: false,
                tx_ref: event.data?.tx_ref,
                event: event.event
            });

            return { duplicate: false };
        });

        if (result.duplicate) {
            return res.status(200).send('OK');
        }

        // Process webhook
        await processWebhook(event);

        // Mark as processed
        await db.collection('webhook_events').doc(webhookId).update({
            processed: true,
            processedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).send('OK');

    } catch (error) {
        console.error('🔥 Webhook error:', error.message);
        // Mark as failed
        try {
            await db.collection('webhook_events').doc(webhookId).update({
                processed: false,
                error: error.message,
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) { /* ignore */ }
        res.status(500).send('Error');
    }
};

async function processWebhook(event) {
    if (event.event !== 'charge.completed') {
        console.log('Ignoring event:', event.event);
        return;
    }

    const { tx_ref, status, amount, currency, id: transactionId } = event.data;

    // Verify transaction with Flutterwave API
    const verifyResponse = await axios.get(
        `${FLW_BASE}/transactions/${transactionId}/verify`,
        { headers: { Authorization: `Bearer ${FLW_SECRET}` } }
    );

    if (verifyResponse.data.status !== 'success') {
        throw new Error('Transaction verification failed');
    }

    const txData = verifyResponse.data.data;

    // Validate transaction details
    if (txData.status !== 'successful') {
        console.warn('Transaction not successful:', txData.status);
        return;
    }

    if (txData.currency !== 'NGN') {
        throw new Error(`Currency mismatch: ${txData.currency}`);
    }

    // Find and update order
    const orderSnapshot = await db.collection('orders')
        .where('flutterwaveRef', '==', tx_ref)
        .limit(1)
        .get();

    if (orderSnapshot.empty) {
        throw new Error('Order not found');
    }

    const doc = orderSnapshot.docs[0];
    const order = doc.data();

    // Idempotent update: only transition from pending
    if (order.status === 'pending' && txData.status === 'successful') {
        // Verify amount matches
        if (Math.abs(order.amount - txData.amount) > 0.01) {
            throw new Error(`Amount mismatch: expected ${order.amount}, got ${txData.amount}`);
        }

        await doc.ref.update({
            status: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            flutterwavePaymentId: transactionId,
            paymentVerified: true,
            paymentData: {
                amount: txData.amount,
                currency: txData.currency,
                customer: txData.customer,
                paymentType: txData.payment_type
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Create ledger entry
        await db.collection('ledger').add({
            orderId: doc.id,
            eventType: 'payment_received',
            amount: order.amount,
            currency: 'NGN',
            timestamp: new Date().toISOString(),
            metadata: { tx_ref, transactionId },
            externalRefs: {
                provider: 'flutterwave',
                providerId: transactionId,
                webhookId: event.data?.id
            }
        });

        console.log('✅ Order paid:', doc.id);
    } else if (order.status === 'pending' && (txData.status === 'failed' || txData.status === 'cancelled')) {
        await doc.ref.update({
            status: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } else {
        console.log(`⚠️ Webhook ignored for order ${doc.id}: status is ${order.status}`);
    }
}

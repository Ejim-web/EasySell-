const admin = require('firebase-admin');
const axios = require('axios');

// Validate environment variables at module load (but gracefully)
function initConfig() {
    const required = ['FIREBASE_SERVICE_ACCOUNT', 'FLUTTERWAVE_SECRET_KEY', 'BASE_URL'];
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
        baseUrl: process.env.BASE_URL,
        commission: parseFloat(process.env.COMMISSION_PERCENT || '10') / 100
    };
}

let config;
try {
    config = initConfig();
} catch (err) {
    console.error('Config initialization failed:', err.message);
    // Will fail in the handler
}

const db = config?.db || admin.firestore();
const FLW_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE = 'https://api.flutterwave.com/v3';
const COMMISSION = parseFloat(process.env.COMMISSION_PERCENT || '10') / 100;

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Verify Firebase token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const buyerUid = decodedToken.uid;

        const { productId, sellerId, amount, email, productTitle } = req.body;
        if (!productId || !sellerId || !amount || !email || !productTitle) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check seller has bank account
        const sellerDoc = await db.collection('users').doc(sellerId).get();
        if (!sellerDoc.exists) return res.status(404).json({ error: 'Seller not found' });
        const seller = sellerDoc.data();
        if (!seller.bankAccount || !seller.bankAccount.accountNumber || !seller.bankAccount.bankCode) {
            return res.status(400).json({ error: 'Seller has not set up a bank account' });
        }

        // Run fraud check (non-blocking)
        const fraudCheck = await checkFraud(buyerUid, productId, amount);

        // Create order
        const orderRef = await db.collection('orders').add({
            productId,
            buyerId: buyerUid,
            sellerId,
            amount: parseFloat(amount),
            commissionRate: COMMISSION,
            commissionAmount: parseFloat(amount) * COMMISSION,
            sellerEarning: parseFloat(amount) * (1 - COMMISSION),
            status: 'pending',
            deliveryStatus: 'pending',
            released: false,
            reviewed: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            productTitle,
            buyerEmail: email,
            flutterwaveRef: null,
            paymentLink: null,
            paymentVerified: false,
            fraudFlags: fraudCheck.flags || [],
            fraudRiskLevel: fraudCheck.riskLevel || 'low',
            fraudAction: fraudCheck.action || 'allow',
            requiresManualReview: fraudCheck.action === 'manual_review'
        });

        const orderId = orderRef.id;

        // Initiate Flutterwave payment
        const txRef = `ES-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const payload = {
            tx_ref: txRef,
            amount: parseFloat(amount),
            currency: 'NGN',
            redirect_url: `${process.env.BASE_URL}/payment-callback`,
            payment_options: 'card, banktransfer, ussd, qr',
            meta: { orderId, productId, buyerId: buyerUid, sellerId },
            customer: { email, name: decodedToken.name || 'Customer' },
            customizations: {
                title: 'EasySell - Order',
                description: productTitle,
                logo: 'https://your-logo-url.com/logo.png',
            },
        };

        const response = await axios.post(`${FLW_BASE}/payments`, payload, {
            headers: { Authorization: `Bearer ${FLW_SECRET}`, 'Content-Type': 'application/json' }
        });

        if (response.data.status !== 'success') {
            throw new Error(response.data.message || 'Flutterwave init failed');
        }

        const paymentLink = response.data.data.link;
        const flutterwaveRef = response.data.data.tx_ref;

        await orderRef.update({
            flutterwaveRef,
            paymentLink,
            status: 'pending',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Log transaction
        await db.collection('transactions').add({
            orderId,
            txRef: flutterwaveRef,
            amount: parseFloat(amount),
            currency: 'NGN',
            status: 'pending',
            buyerId: buyerUid,
            sellerId,
            productId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Create ledger entry
        await db.collection('ledger').add({
            orderId,
            eventType: 'payment_initialized',
            amount: parseFloat(amount),
            currency: 'NGN',
            timestamp: new Date().toISOString(),
            metadata: { flutterwaveRef, buyerId: buyerUid, sellerId },
            externalRefs: {
                provider: 'flutterwave',
                providerId: flutterwaveRef
            }
        });

        return res.status(200).json({ success: true, paymentLink, orderId });

    } catch (error) {
        console.error('Init payment error:', error.message);
        // Clean up any created order
        if (req.body.productId && req.body.sellerId) {
            try {
                const snap = await db.collection('orders')
                    .where('productId', '==', req.body.productId)
                    .where('buyerId', '==', req.decodedToken?.uid || '')
                    .where('status', '==', 'pending')
                    .get();
                snap.forEach(doc => doc.ref.update({ status: 'failed', error: error.message }));
            } catch (e) { /* ignore */ }
        }
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

// Fraud check function (non-blocking)
async function checkFraud(userId, productId, amount) {
    const flags = [];
    let action = 'allow';
    let riskLevel = 'low';

    // Check for suspicious patterns
    // 1. Many failed attempts
    const failedAttempts = await db.collection('orders')
        .where('buyerId', '==', userId)
        .where('status', '==', 'failed')
        .count()
        .get();

    if (failedAttempts.data().count > 5) {
        flags.push('Multiple failed payment attempts');
        riskLevel = 'medium';
        action = 'flag_only';
    }

    // 2. Large transaction amount
    if (amount > 1000000) {
        flags.push('Large transaction amount - manual review recommended');
        riskLevel = 'high';
        action = 'manual_review';
    }

    // 3. First-time buyer large purchase
    const completedOrders = await db.collection('orders')
        .where('buyerId', '==', userId)
        .where('status', '==', 'completed')
        .count()
        .get();

    if (completedOrders.data().count === 0 && amount > 50000) {
        flags.push('First-time buyer making large purchase');
        riskLevel = 'medium';
        if (action !== 'manual_review') action = 'flag_only';
    }

    return { flags, riskLevel, action };
}

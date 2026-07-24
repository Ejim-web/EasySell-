const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

// Init config (same as above)
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
        baseUrl: process.env.BASE_URL
    };
}

const config = initConfig();
const db = config.db;
const FLW_SECRET = config.flwSecret;
const FLW_BASE = 'https://api.flutterwave.com/v3';

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Verify user
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const buyerUid = decodedToken.uid;

        // Get idempotency key
        const idempotencyKey = req.headers['idempotency-key'];
        if (!idempotencyKey) {
            return res.status(400).json({ error: 'Missing Idempotency-Key header' });
        }

        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

        // Atomic: check idempotency and create job
        const result = await db.runTransaction(async (transaction) => {
            // 1. Check idempotency
            const keyRef = db.collection('idempotency_keys').doc(idempotencyKey);
            const keySnap = await transaction.get(keyRef);

            if (keySnap.exists) {
                const data = keySnap.data();
                if (data.status === 'completed') {
                    return { cached: true, result: data.result };
                }
                if (data.status === 'processing') {
                    throw new Error('Request already in progress');
                }
            }

            // 2. Get order
            const orderRef = db.collection('orders').doc(orderId);
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists) throw new Error('Order not found');
            const order = orderSnap.data();

            // 3. Validate order state
            if (order.buyerId !== buyerUid) {
                throw new Error('Only the buyer can confirm delivery');
            }
            if (order.status !== 'paid') {
                throw new Error(`Order is not paid (status: ${order.status})`);
            }
            if (order.released) {
                throw new Error('Funds already released');
            }
            if (order.processing) {
                throw new Error('Payout already in progress');
            }
            if (order.status === 'disputed') {
                throw new Error('Order is under dispute');
            }

            // 4. Mark order as processing
            transaction.update(orderRef, {
                processing: true,
                processingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
                status: 'processing',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 5. Create idempotency key
            transaction.set(keyRef, {
                orderId,
                status: 'processing',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            });

            // 6. Create payout job
            const jobRef = db.collection('payout_jobs').doc();
            transaction.set(jobRef, {
                orderId,
                idempotencyKey,
                status: 'queued',
                priority: order.amount > 100000 ? 'high' : 'normal',
                attempts: 0,
                maxAttempts: 3,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                scheduledFor: admin.firestore.FieldValue.serverTimestamp(),
                lockExpiresAt: null,
                workerId: null
            });

            return { cached: false, jobId: jobRef.id };
        });

        if (result.cached) {
            return res.status(200).json({
                success: true,
                message: 'Payout already processed',
                cached: true,
                result: result.result
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Payout queued successfully',
            jobId: result.jobId
        });

    } catch (error) {
        console.error('Release error:', error.message);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

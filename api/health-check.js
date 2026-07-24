const admin = require('firebase-admin');

// Initialize Firebase (lazy)
let db;
let initialized = false;

function getDb() {
    if (!initialized) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            if (!admin.apps.length) {
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            }
            db = admin.firestore();
            initialized = true;
        } catch (err) {
            console.error('Health check: Firebase init failed:', err.message);
            db = null;
        }
    }
    return db;
}

module.exports = async (req, res) => {
    const status = {
        healthy: true,
        timestamp: new Date().toISOString(),
        services: {},
        queue: {},
        environment: {
            region: process.env.VERCEL_REGION || 'unknown',
            nodeVersion: process.version
        }
    };

    // Check Firebase (read-only, no writes)
    try {
        const db = getDb();
        if (db) {
            await db.collection('orders').limit(1).get();
            status.services.firebase = 'healthy';
        } else {
            throw new Error('Firebase not initialized');
        }
    } catch (err) {
        status.services.firebase = 'unhealthy';
        status.healthy = false;
        status.firebaseError = err.message;
    }

    // Check queue health (read-only)
    try {
        const db = getDb();
        if (db) {
            const queuedJobs = await db.collection('payout_jobs')
                .where('status', '==', 'queued')
                .count()
                .get();
            status.queue.depth = queuedJobs.data().count;

            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const failedJobs = await db.collection('payout_jobs')
                .where('status', '==', 'failed')
                .where('updatedAt', '>=', oneHourAgo)
                .count()
                .get();
            status.queue.recentFailures = failedJobs.data().count;
            if (failedJobs.data().count > 5) {
                status.healthy = false;
                status.reason = 'Too many recent payout failures';
            }
        }
    } catch (err) {
        status.queue.error = err.message;
        status.healthy = false;
    }

    res.status(status.healthy ? 200 : 503).json(status);
};

const admin = require('firebase-admin');
const axios = require('axios');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
}
if (!process.env.FLUTTERWAVE_SECRET_KEY) {
  throw new Error('FLUTTERWAVE_SECRET_KEY missing');
}
if (!process.env.BASE_URL) {
  throw new Error('BASE_URL missing');
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const FLW_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE_URL = 'https://api.flutterwave.com/v3';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
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

    // 1. Create transaction
    const txRef = await db.collection('transactions').add({
      productId,
      buyerId: buyerUid,
      sellerId,
      amount: parseFloat(amount),
      platformFee: parseFloat(amount) * 0.05,
      sellerEarning: parseFloat(amount) * 0.95,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      productTitle,
    });
    const transactionId = txRef.id;

    // 2. Check seller's bank
    const sellerDoc = await db.collection('users').doc(sellerId).get();
    if (!sellerDoc.exists) {
      await txRef.update({ status: 'failed', error: 'Seller not found' });
      return res.status(404).json({ error: 'Seller not found' });
    }
    const sellerData = sellerDoc.data();
    const bank = sellerData.bankAccount;
    if (!bank || !bank.accountNumber || !bank.bankName) {
      await txRef.update({ status: 'failed', error: 'Seller has no bank account' });
      return res.status(400).json({ error: 'Seller has not set up a bank account' });
    }

    // 3. Flutterwave
    const flutterwaveRef = `ES-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const payload = {
      tx_ref: flutterwaveRef,
      amount: parseFloat(amount),
      currency: 'NGN',
      redirect_url: `${process.env.BASE_URL}/payment-callback`,
      payment_options: 'card, banktransfer, ussd, qr',
      meta: { transactionId, productId, buyerId: buyerUid, sellerId },
      customer: { email, name: decodedToken.name || 'Customer' },
      customizations: {
        title: 'EasySell - Purchase',
        description: productTitle || 'Marketplace item',
        logo: 'https://your-logo-url.com/logo.png',
      },
    };

    const response = await axios.post(
      `${FLW_BASE_URL}/payments`,
      payload,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    if (response.data.status !== 'success') {
      throw new Error(response.data.message || 'Flutterwave error');
    }

    const paymentLink = response.data.data.link;
    await txRef.update({ flutterwaveRef, paymentLink });

    return res.status(200).json({ success: true, paymentLink, transactionId });

  } catch (error) {
    console.error('Payment init error:', error.message);
    if (req.body.transactionId) {
      try {
        await db.collection('transactions').doc(req.body.transactionId).update({
          status: 'failed',
          error: error.message,
        });
      } catch (e) {}
    }
    return res.status(500).json({ error: error.message });
  }
};

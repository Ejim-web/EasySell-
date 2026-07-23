const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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

    const { transactionId, amount, email, productTitle, productId, sellerId } = req.body;
    if (!transactionId || !amount || !email || !productId || !sellerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch seller's bank details (Admin SDK has full access)
    const sellerDoc = await db.collection('users').doc(sellerId).get();
    if (!sellerDoc.exists) return res.status(404).json({ error: 'Seller not found' });
    const sellerData = sellerDoc.data();
    const bank = sellerData.bankAccount;
    if (!bank || !bank.accountNumber || !bank.bankName) {
      return res.status(400).json({ error: 'Seller has not set up a bank account' });
    }

    // Prepare Flutterwave payment payload
    const txRef = `ES-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const payload = {
      tx_ref: txRef,
      amount: amount,
      currency: 'NGN',
      redirect_url: `${process.env.BASE_URL}/payment-callback`,
      payment_options: 'card, banktransfer, ussd, qr',
      meta: { transactionId, productId, buyerId: buyerUid, sellerId },
      customer: {
        email: email,
        name: decodedToken.name || 'Customer',
      },
      customizations: {
        title: 'EasySell - Purchase',
        description: productTitle || 'Marketplace item',
        logo: 'https://your-logo-url.com/logo.png', // Change this to your logo URL
      },
    };

    const response = await axios.post(
      `${FLW_BASE_URL}/payments`,
      payload,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    if (response.data.status !== 'success') {
      throw new Error(response.data.message || 'Flutterwave payment initialization failed');
    }

    const paymentLink = response.data.data.link;
    const flutterwaveRef = response.data.data.tx_ref;

    await db.collection('transactions').doc(transactionId).update({
      flutterwaveRef,
      status: 'pending',
      paymentLink,
    });

    return res.status(200).json({ success: true, paymentLink, transactionId });

  } catch (error) {
    console.error('Payment init error:', error);
    if (req.body.transactionId) {
      try {
        await db.collection('transactions').doc(req.body.transactionId).update({
          status: 'failed',
          error: error.message || 'Unknown error',
        });
      } catch (e) { /* ignore */ }
    }
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

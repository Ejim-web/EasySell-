const admin = require('firebase-admin');
const axios = require('axios');

// Validate environment variables
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
if (!process.env.FLUTTERWAVE_SECRET_KEY) throw new Error('Missing FLUTTERWAVE_SECRET_KEY');
if (!process.env.BASE_URL) throw new Error('Missing BASE_URL');
if (!process.env.COMMISSION_PERCENT) process.env.COMMISSION_PERCENT = '10';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const FLW_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE = 'https://api.flutterwave.com/v3';
const COMMISSION = parseFloat(process.env.COMMISSION_PERCENT) / 100;

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

    // Check seller has bank account
    const sellerDoc = await db.collection('users').doc(sellerId).get();
    if (!sellerDoc.exists) return res.status(404).json({ error: 'Seller not found' });
    const seller = sellerDoc.data();
    if (!seller.bankAccount || !seller.bankAccount.accountNumber || !seller.bankAccount.bankCode) {
      return res.status(400).json({ error: 'Seller has not set up a bank account' });
    }

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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      productTitle,
      buyerEmail: email,
      flutterwaveRef: null,
      paymentLink: null,
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
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, paymentLink, orderId });

  } catch (error) {
    console.error('Init payment error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

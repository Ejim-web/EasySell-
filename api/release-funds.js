const admin = require('firebase-admin');
const axios = require('axios');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
if (!process.env.FLUTTERWAVE_SECRET_KEY) throw new Error('Missing FLUTTERWAVE_SECRET_KEY');
if (!process.env.BASE_URL) throw new Error('Missing BASE_URL');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const FLW_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE = 'https://api.flutterwave.com/v3';

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

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderSnap.data();

    if (order.buyerId !== buyerUid) {
      return res.status(403).json({ error: 'Only the buyer can confirm delivery' });
    }

    if (order.status !== 'paid') {
      return res.status(400).json({ error: 'Order is not paid or already completed' });
    }
    if (order.released) {
      return res.status(400).json({ error: 'Funds already released' });
    }

    const sellerDoc = await db.collection('users').doc(order.sellerId).get();
    if (!sellerDoc.exists) return res.status(404).json({ error: 'Seller not found' });
    const seller = sellerDoc.data();
    if (!seller.bankAccount || !seller.bankAccount.accountNumber || !seller.bankAccount.bankCode) {
      return res.status(400).json({ error: 'Seller bank details missing' });
    }

    const sellerAmount = order.sellerEarning || (order.amount * 0.9);

    // Initiate Flutterwave transfer
    const transferPayload = {
      account_bank: seller.bankAccount.bankCode,
      account_number: seller.bankAccount.accountNumber,
      amount: parseFloat(sellerAmount.toFixed(2)),
      narration: `Payment for order ${orderId}`,
      currency: 'NGN',
      reference: `TRF-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      callback_url: `${process.env.BASE_URL}/api/transfer-webhook`,
      debit_currency: 'NGN',
    };

    const transferResponse = await axios.post(
      `${FLW_BASE}/transfers`,
      transferPayload,
      { headers: { Authorization: `Bearer ${FLW_SECRET}`, 'Content-Type': 'application/json' } }
    );

    if (transferResponse.data.status !== 'success') {
      throw new Error(transferResponse.data.message || 'Transfer failed');
    }

    await orderRef.update({
      released: true,
      status: 'completed',
      deliveryStatus: 'delivered',
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      transferReference: transferResponse.data.data.id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, message: 'Payment released to seller' });

  } catch (error) {
    console.error('Release funds error:', error.message);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

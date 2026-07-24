const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;

module.exports = async (req, res) => {
  const hash = req.headers['verif-hash'];
  if (!hash || hash !== secretHash) {
    return res.status(401).send('Unauthorized');
  }

  const event = req.body;
  if (event.event === 'charge.completed') {
    const { tx_ref, status, amount, currency, customer } = event.data;
    const snapshot = await db.collection('orders')
      .where('flutterwaveRef', '==', tx_ref)
      .limit(1)
      .get();

    if (snapshot.empty) return res.status(404).send('Order not found');

    const doc = snapshot.docs[0];
    const order = doc.data();

    if (status === 'successful' && order.status === 'pending') {
      await doc.ref.update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        flutterwavePaymentId: event.data.id,
      });
    } else if (status === 'failed' || status === 'cancelled') {
      await doc.ref.update({
        status: 'failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: 'Payment failed or cancelled',
      });
    }
  }

  res.status(200).send('OK');
};

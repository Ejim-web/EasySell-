const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  // Optionally verify a secret hash
  const event = req.body;
  if (event.event === 'transfer.completed') {
    const { reference, status } = event.data;
    const snapshot = await db.collection('orders')
      .where('transferReference', '==', reference)
      .limit(1)
      .get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      await doc.ref.update({
        transferStatus: status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
  res.status(200).send('OK');
};

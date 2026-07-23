// ================================================================
//  EASYSELL CLOUD FUNCTIONS – Flutterwave Escrow
// ================================================================
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

const FLW_SECRET = functions.config().flutterwave.secret;
const FLW_PUBLIC = functions.config().flutterwave.public;
const FLW_ENCRYPTION = functions.config().flutterwave.encryption;

// 1. Initialize Payment
exports.initializeFlutterwavePayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  const { productId } = data;
  const buyerId = context.auth.uid;

  const productSnap = await db.collection('products').doc(productId).get();
  const product = productSnap.data();
  if (!product) throw new functions.https.HttpsError('not-found', 'Product not found');
  if (product.sellerId === buyerId) throw new functions.https.HttpsError('failed-precondition', 'Cannot buy your own item');
  if (product.status !== 'available') throw new functions.https.HttpsError('failed-precondition', 'Item not available');

  const sellerSnap = await db.collection('users').doc(product.sellerId).get();
  const seller = sellerSnap.data();
  if (!seller.bankAccount || !seller.bankAccount.accountNumber) {
    throw new functions.https.HttpsError('failed-precondition', 'Seller has not added bank details.');
  }

  const amount = parseFloat(product.price);
  const fee = Math.round(amount * 0.10 * 100) / 100;
  const sellerEarning = amount - fee;
  const txRef = `ES-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const txData = {
    productId,
    buyerId,
    sellerId: product.sellerId,
    amount,
    platformFee: fee,
    sellerEarning,
    flutterwaveTxRef: txRef,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  const txRefDoc = await db.collection('transactions').add(txData);

  try {
    const response = await axios.post('https://api.flutterwave.com/v3/payments', {
      tx_ref: txRef,
      amount: amount,
      currency: 'NGN',
      redirect_url: 'https://yourapp.com/payment-callback',
      payment_options: 'card, banktransfer, ussd',
      meta: { transactionId: txRefDoc.id },
      customer: {
        email: context.auth.token.email,
        name: context.auth.token.name || 'Customer'
      },
      customizations: {
        title: `EasySell - ${product.title}`,
        description: `Buy: ${product.title}`
      }
    }, {
      headers: { Authorization: `Bearer ${FLW_SECRET}` }
    });

    await txRefDoc.update({
      flutterwaveLink: response.data.data.link,
      flutterwaveTransactionId: response.data.data.id
    });

    return {
      paymentLink: response.data.data.link,
      transactionId: txRefDoc.id,
      amount,
      fee
    };
  } catch (err) {
    console.error('Flutterwave init error:', err.response?.data || err.message);
    throw new functions.https.HttpsError('internal', 'Payment initialization failed');
  }
});

// 2. Webhook
exports.flutterwaveWebhook = functions.https.onRequest(async (req, res) => {
  const signature = req.headers['verif-hash'];
  // if (signature !== FLW_ENCRYPTION) { res.sendStatus(401); return; }

  const event = req.body;
  console.log('Webhook received:', event.event, event.data?.status);

  if (event.event === 'charge.completed' && event.data.status === 'successful') {
    const txRef = event.data.tx_ref;

    const txSnapshot = await db.collection('transactions')
      .where('flutterwaveTxRef', '==', txRef)
      .limit(1)
      .get();

    if (!txSnapshot.empty) {
      const doc = txSnapshot.docs[0];
      await doc.ref.update({
        status: 'paid_held',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        flutterwaveTransactionId: event.data.id
      });
      console.log(`✅ Transaction ${txRef} updated to paid_held`);
    } else {
      console.log(`❌ Transaction ${txRef} not found`);
    }
  }
  res.sendStatus(200);
});

// 3. Release Funds
exports.releaseFundsToSeller = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  const { transactionId } = data;
  const buyerId = context.auth.uid;

  const txRef = db.collection('transactions').doc(transactionId);
  const txSnap = await txRef.get();
  const tx = txSnap.data();

  if (!txSnap.exists) throw new functions.https.HttpsError('not-found', 'Transaction not found');
  if (tx.buyerId !== buyerId) throw new functions.https.HttpsError('permission-denied', 'Not your transaction');
  if (tx.status === 'completed') return { message: 'Already completed' };
  if (tx.status !== 'paid_held') throw new functions.https.HttpsError('failed-precondition', 'Payment not held');

  const sellerSnap = await db.collection('users').doc(tx.sellerId).get();
  const seller = sellerSnap.data();
  if (!seller.bankAccount) {
    throw new functions.https.HttpsError('failed-precondition', 'Seller bank details missing');
  }

  const transferAmount = Math.round(tx.sellerEarning * 100) / 100;
  const reference = `TRF-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  try {
    const transferResponse = await axios.post('https://api.flutterwave.com/v3/transfers', {
      account_bank: seller.bankAccount.bankCode,
      account_number: seller.bankAccount.accountNumber,
      amount: transferAmount,
      currency: 'NGN',
      narration: `Payment for order ${transactionId}`,
      reference: reference,
      beneficiary_name: seller.displayName || 'Seller'
    }, {
      headers: { Authorization: `Bearer ${FLW_SECRET}` }
    });

    if (transferResponse.data.status !== 'success') {
      throw new Error('Transfer failed: ' + transferResponse.data.message);
    }

    await txRef.update({
      status: 'completed',
      sellerPaidAt: admin.firestore.FieldValue.serverTimestamp(),
      flutterwaveTransferReference: reference
    });

    await db.collection('products').doc(tx.productId).update({ status: 'sold' });

    return { message: `₦${transferAmount.toFixed(2)} released to seller!` };
  } catch (err) {
    console.error('Transfer error:', err.response?.data || err.message);
    throw new functions.https.HttpsError('internal', 'Failed to release funds');
  }
});

// 4. Get Balances
exports.getSellerBalances = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');

  try {
    const response = await axios.get('https://api.flutterwave.com/v3/balances', {
      headers: { Authorization: `Bearer ${FLW_SECRET}` }
    });

    if (response.data.status !== 'success') {
      throw new Error('Failed to fetch balances');
    }

    return {
      balances: response.data.data.map(b => ({
        currency: b.currency,
        balance: parseFloat(b.available_balance) || 0,
        ledgerBalance: parseFloat(b.ledger_balance) || 0
      }))
    };
  } catch (err) {
    console.error('Balance fetch error:', err.response?.data || err.message);
    throw new functions.https.HttpsError('internal', 'Failed to fetch balances');
  }
});

// 5. Get Transactions
exports.getSellerTransactions = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  const uid = context.auth.uid;
  const { limit = 20 } = data;

  const txSnapshot = await db.collection('transactions')
    .where('sellerId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  const transactions = [];
  txSnapshot.forEach(doc => {
    const tx = doc.data();
    transactions.push({
      id: doc.id,
      ...tx,
      amount: parseFloat(tx.amount) || 0,
      sellerEarning: parseFloat(tx.sellerEarning) || 0,
      createdAt: tx.createdAt?.toDate?.() || new Date()
    });
  });

  const enriched = await Promise.all(transactions.map(async (tx) => {
    if (tx.productId) {
      const prodSnap = await db.collection('products').doc(tx.productId).get();
      return { ...tx, productTitle: prodSnap.exists ? prodSnap.data().title : 'Deleted item' };
    }
    return { ...tx, productTitle: 'Unknown item' };
  }));

  return { transactions: enriched.slice(0, limit) };
});

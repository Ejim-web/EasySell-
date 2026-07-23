// api/test.js
module.exports = (req, res) => {
  res.status(200).json({
    message: 'Backend is alive!',
    env: {
      hasFirebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      hasFlutterwave: !!process.env.FLUTTERWAVE_SECRET_KEY,
      baseUrl: process.env.BASE_URL || 'not set',
    }
  });
};

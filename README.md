# EasySell Marketplace

A secure, escrow-based marketplace platform.

## Features

- ✅ Firebase Authentication (email + Google)
- ✅ Product listings with image/video upload
- ✅ Search and filters (category, price, condition)
- ✅ Wishlist
- ✅ Escrow payment system (Flutterwave)
- ✅ Seller payouts with queue
- ✅ Reviews and ratings
- ✅ Featured listings
- ✅ Admin dashboard
- ✅ Fraud detection
- ✅ Reconciliation and audit logging

## Architecture

- **Frontend**: HTML/CSS/JS (hosted on Vercel)
- **Backend**: Serverless functions (Vercel)
- **Database**: Firestore (Firebase)
- **Auth**: Firebase Auth
- **Payments**: Flutterwave
- **Media**: Cloudinary
- **Queue**: Firestore-backed (migratable to Cloud Tasks)

## Setup

1. Copy `.env.example` to `.env` and fill in your values
2. Install dependencies: `npm install`
3. Deploy to Vercel
4. Set environment variables in Vercel dashboard
5. Set up Firestore indexes
6. Configure Flutterwave webhooks

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON |
| `FLUTTERWAVE_SECRET_KEY` | Flutterwave live secret key |
| `FLUTTERWAVE_SECRET_HASH` | Webhook verification hash |
| `BASE_URL` | Your app URL |
| `COMMISSION_PERCENT` | Platform commission (default: 10) |
| `ALLOWED_ORIGIN` | CORS allowed origin |
| `CRON_SECRET` | Secret for cron endpoints |

## Production Readiness

- ✅ Atomic state transitions
- ✅ Idempotency keys
- ✅ Webhook deduplication
- ✅ Distributed circuit breaker
- ✅ Queue with lease tokens
- ✅ Reconciliation
- ✅ Audit logging
- ✅ Fraud detection

## License

MIT

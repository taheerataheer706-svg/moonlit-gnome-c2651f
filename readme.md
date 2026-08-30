# DAHIRU MAN D DATA — payment + VTU integration

This version is wired for **Paystack wallet funding** and **VTpass data delivery**.

## What is connected
- Paystack transaction initialization + verification + webhook crediting.
- VTpass sandbox/live mode for MTN, Airtel, Glo and 9mobile data.
- Wallet balance stored server-side in `data.json` for this starter build.
- Data purchase deducts the customer's selling price only after VTpass reports delivery.
- `DATA_MARKUP_PERCENT` controls your selling markup.

Paystack requires the secret key to stay on the backend; do not put it in browser code. See official docs: https://paystack.com/docs/api/transaction/ and https://paystack.com/docs/payments/webhooks/

VTpass requires API keys in request headers and supports the data services above. See: https://vtpass.com/documentation/authentication/ and https://vtpass.com/documentation/buying-services/

## Run
1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Add your Paystack test secret key and VTpass sandbox keys.
4. Run `npm install` then `npm start`.
5. Open `http://localhost:3000`.

For production, replace `data.json` with a real database, add proper user authentication, rate limiting, idempotency/locking and HTTPS.

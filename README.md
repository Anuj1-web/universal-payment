# Universal Razorpay Frontend — v1.0.0

This is the standalone frontend layer for the Universal Razorpay + Supabase project.

## Current status

The included `demo.html` uses `mode: "mock"`.

It deliberately does NOT connect to Razorpay or Supabase yet. This lets the frontend contract and UI be tested independently before the backend is created.

## Files

- `universal-razorpay.js` — main SDK
- `universal-razorpay.css` — isolated checkout UI
- `universal-razorpay-config.js` — configuration template
- `demo.html` — standalone test website

## Important security rule

Never put `RAZORPAY_KEY_SECRET` in frontend code.

Only the Razorpay public Key ID belongs in the browser. The secret will later live in Supabase Edge Function secrets.

## Real backend contract planned

`create-razorpay-order` will receive:

```json
{
  "amount": 499,
  "currency": "INR",
  "orderReference": "ORD-1001",
  "customer": {},
  "items": [],
  "metadata": {}
}
```

It must return an object containing an `order` object with the Razorpay order ID.

`verify-razorpay-payment` will receive:

```json
{
  "orderReference": "ORD-1001",
  "razorpayOrderId": "...",
  "razorpayPaymentId": "...",
  "razorpaySignature": "...",
  "metadata": {}
}
```

It must return:

```json
{
  "verified": true,
  "payment": {}
}
```

The backend will perform all secret-key work and signature verification.

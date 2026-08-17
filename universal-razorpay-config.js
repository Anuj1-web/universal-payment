/*
 * Universal Razorpay Frontend SDK
 * Configuration template.
 *
 * IMPORTANT:
 * - The Razorpay Key Secret must NEVER be placed here.
 * - The Supabase anon/publishable key is intentionally frontend-safe,
 *   provided your Supabase RLS/function permissions are configured correctly.
 */

window.UniversalRazorpayConfig = {
  // Set these when connecting the real Supabase backend.
  supabaseUrl: "",
  supabaseAnonKey: "",

  // Backend function names. Keep these stable across projects if possible.
  functions: {
    createOrder: "create-razorpay-order",
    verifyPayment: "verify-razorpay-payment"
  },

  // Razorpay public key. The secret stays in Supabase Edge Function secrets.
  razorpayKeyId: "",

  currency: "INR",

  // "mock" is used by the included demo until the Supabase backend is connected.
  mode: "mock",

  // Optional defaults.
  theme: {
    color: "#111827"
  },

  behavior: {
    autoCloseOnSuccess: true,
    allowRetry: true,
    preventDoubleSubmit: true
  }
};

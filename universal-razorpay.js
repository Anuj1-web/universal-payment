/*!
 * Universal Razorpay Frontend SDK
 * Version: 1.0.0
 *
 * Frontend responsibilities:
 * - validate payment input
 * - normalize orders/customers
 * - call the Supabase Edge Functions
 * - load Razorpay Checkout only when needed
 * - handle checkout lifecycle
 * - expose predictable callbacks/events
 *
 * Security:
 * - NEVER put RAZORPAY_KEY_SECRET in this file.
 * - The backend must create Razorpay orders and verify signatures.
 */

(function (global) {
  "use strict";

  const VERSION = "1.0.0";
  const DEFAULTS = {
    currency: "INR",
    mode: "mock",
    functions: {
      createOrder: "create-razorpay-order",
      verifyPayment: "verify-razorpay-payment"
    },
    behavior: {
      autoCloseOnSuccess: true,
      allowRetry: true,
      preventDoubleSubmit: true
    },
    theme: {
      color: "#111827"
    }
  };

  const STATES = Object.freeze({
    IDLE: "idle",
    VALIDATING: "validating",
    CREATING_ORDER: "creating_order",
    READY: "ready",
    CHECKOUT_OPEN: "checkout_open",
    VERIFYING: "verifying",
    SUCCESS: "success",
    FAILED: "failed",
    CANCELLED: "cancelled"
  });

  let config = deepMerge(DEFAULTS, global.UniversalRazorpayConfig || {});
  let state = STATES.IDLE;
  let activePayment = null;
  let overlay = null;
  let modal = null;
  let callbacks = {};
  let events = {};

  function deepMerge(base, extra) {
    const output = Array.isArray(base) ? base.slice() : { ...base };
    if (!extra || typeof extra !== "object") return output;

    Object.keys(extra).forEach(function (key) {
      const value = extra[key];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        output[key] &&
        typeof output[key] === "object" &&
        !Array.isArray(output[key])
      ) {
        output[key] = deepMerge(output[key], value);
      } else {
        output[key] = value;
      }
    });
    return output;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function safeNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function resolve(value) {
    return typeof value === "function" ? value() : value;
  }

  async function resolveAsync(value) {
    return typeof value === "function" ? await value() : value;
  }

  function normalizeAmount(amount) {
    const value = safeNumber(amount);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("A valid payment amount greater than 0 is required.");
    }

    // Public API uses major currency units: ₹499.99.
    // Backend/Razorpay integration converts to the smallest unit.
    return Math.round(value * 100) / 100;
  }

  function createExternalReference(prefix) {
    const p = prefix || "URP";
    const random = Math.random().toString(36).slice(2, 10).toUpperCase();
    return p + "-" + Date.now().toString(36).toUpperCase() + "-" + random;
  }

  function normalizeCustomer(customer) {
    if (!customer) return null;
    if (!isPlainObject(customer)) {
      throw new Error("Customer must be an object.");
    }

    const output = {
      name: customer.name ? String(customer.name).trim() : "",
      email: customer.email ? String(customer.email).trim() : "",
      phone: customer.phone ? String(customer.phone).trim() : "",
      externalCustomerId: customer.externalCustomerId
        ? String(customer.externalCustomerId)
        : null
    };

    if (output.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(output.email)) {
      throw new Error("Customer email is not valid.");
    }

    return output;
  }

  function normalizeItems(items) {
    if (items == null) return [];

    if (!Array.isArray(items)) {
      throw new Error("Items must be an array.");
    }

    return items.map(function (item, index) {
      if (!isPlainObject(item)) {
        throw new Error("Item " + (index + 1) + " is invalid.");
      }

      const quantity = safeNumber(item.quantity == null ? 1 : item.quantity);
      const price = safeNumber(item.price);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Item " + (index + 1) + " has an invalid quantity.");
      }

      if (price !== 0 && (!Number.isFinite(price) || price < 0)) {
        throw new Error("Item " + (index + 1) + " has an invalid price.");
      }

      return {
        id: item.id != null ? String(item.id) : null,
        sku: item.sku != null ? String(item.sku) : null,
        name: item.name != null ? String(item.name) : "Item",
        quantity: quantity,
        price: Number.isFinite(price) ? price : null,
        variantId: item.variantId != null ? String(item.variantId) : null,
        metadata: isPlainObject(item.metadata) ? item.metadata : {}
      };
    });
  }

  function setState(nextState, data) {
    state = nextState;
    emit("state", {
      state: state,
      data: data || null
    });
  }

  function emit(name, payload) {
    const list = events[name] || [];
    list.slice().forEach(function (handler) {
      try {
        handler(payload);
      } catch (error) {
        console.error("[UniversalRazorpay] Event handler error:", error);
      }
    });

    if (typeof callbacks[name] === "function") {
      try {
        callbacks[name](payload);
      } catch (error) {
        console.error("[UniversalRazorpay] Callback error:", error);
      }
    }
  }

  function on(name, handler) {
    if (typeof handler !== "function") {
      throw new Error("Event handler must be a function.");
    }
    if (!events[name]) events[name] = [];
    events[name].push(handler);

    return function unsubscribe() {
      events[name] = (events[name] || []).filter(function (fn) {
        return fn !== handler;
      });
    };
  }

  function requireConfigForLive() {
    if (!config.supabaseUrl) {
      throw new Error("Supabase URL is missing.");
    }

    if (!config.supabaseAnonKey) {
      throw new Error("Supabase anon/publishable key is missing.");
    }

    if (!config.razorpayKeyId) {
      throw new Error("Razorpay public Key ID is missing.");
    }
  }

  function supabaseFunctionUrl(functionName) {
    return config.supabaseUrl.replace(/\/+$/, "") +
      "/functions/v1/" + encodeURIComponent(functionName);
  }

  async function callEdgeFunction(functionName, body) {
    const url = supabaseFunctionUrl(functionName);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.supabaseAnonKey,
        "apikey": config.supabaseAnonKey
      },
      body: JSON.stringify(body)
    });

    let payload = null;
    const text = await response.text();

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_) {
      payload = { raw: text };
    }

    if (!response.ok) {
      const message =
        payload && (payload.error || payload.message) ||
        "Payment backend returned HTTP " + response.status + ".";

      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function ensureStyles() {
    if (document.getElementById("urpay-sdk-style")) return;

    const style = document.createElement("style");
    style.id = "urpay-sdk-style";
    style.textContent = `
      .urpay-root,.urpay-root *{box-sizing:border-box}
      .urpay-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.56);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);opacity:0;visibility:hidden;transition:opacity .18s ease,visibility .18s ease}
      .urpay-backdrop.urpay-open{opacity:1;visibility:visible}
      .urpay-modal{width:min(100%,430px);max-height:min(760px,calc(100vh - 40px));overflow:auto;border:1px solid #e5e7eb;border-radius:22px;background:#fff;color:#111827;box-shadow:0 24px 80px rgba(0,0,0,.18);transform:translateY(10px) scale(.985);transition:transform .18s ease;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .urpay-open .urpay-modal{transform:translateY(0) scale(1)}
      .urpay-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:22px 22px 14px}
      .urpay-title{margin:0;font-size:20px;line-height:1.25;font-weight:750;letter-spacing:-.02em}
      .urpay-subtitle{margin:6px 0 0;color:#6b7280;font-size:13px}
      .urpay-close{width:34px;height:34px;border:0;border-radius:50%;background:#f3f4f6;color:#374151;cursor:pointer;font-size:20px;line-height:1}
      .urpay-body{padding:8px 22px 22px}
      .urpay-amount{margin:8px 0 18px;padding:18px;border:1px solid #e5e7eb;border-radius:16px;background:#fafafa;text-align:center}
      .urpay-amount-label{color:#6b7280;font-size:12px;margin-bottom:5px}
      .urpay-amount-value{font-size:32px;line-height:1.1;font-weight:800;letter-spacing:-.035em}
      .urpay-order{margin:14px 0;color:#6b7280;font-size:12px;text-align:center;word-break:break-word}
      .urpay-action{width:100%;min-height:50px;border:0;border-radius:13px;padding:13px 18px;background:${config.theme.color || "#111827"};color:#fff;font:inherit;font-weight:700;cursor:pointer}
      .urpay-action:disabled{opacity:.55;cursor:not-allowed}
      .urpay-secondary{margin-top:10px;width:100%;border:1px solid #e5e7eb;border-radius:13px;padding:11px 16px;background:#fff;color:#111827;font:inherit;font-weight:650;cursor:pointer}
      .urpay-status{display:none;padding:12px 0 0;font-size:13px;line-height:1.5;text-align:center}
      .urpay-status.visible{display:block}
      .urpay-status.success{color:#15803d}
      .urpay-status.error{color:#b91c1c}
      .urpay-status.info{color:#6b7280}
      .urpay-spinner{width:18px;height:18px;margin:0 auto 9px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:urpay-spin .7s linear infinite}
      @keyframes urpay-spin{to{transform:rotate(360deg)}}
      .urpay-icon{width:62px;height:62px;margin:4px auto 14px;display:grid;place-items:center;border-radius:50%;font-size:30px;font-weight:800}
      .urpay-icon.success{background:#dcfce7;color:#15803d}
      .urpay-icon.error{background:#fee2e2;color:#b91c1c}
      @media(max-width:480px){.urpay-backdrop{padding:12px;align-items:flex-end}.urpay-modal{width:100%;max-height:calc(100vh - 24px);border-radius:20px}.urpay-header{padding:18px 18px 12px}.urpay-body{padding:8px 18px 18px}.urpay-amount-value{font-size:29px}}
      @media(prefers-reduced-motion:reduce){.urpay-backdrop,.urpay-modal{transition:none}.urpay-spinner{animation:none}}
    `;
    document.head.appendChild(style);
  }

  function buildModal(payment) {
    ensureStyles();

    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.className = "urpay-root urpay-backdrop";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Payment");

    overlay.innerHTML = `
      <div class="urpay-modal">
        <div class="urpay-header">
          <div>
            <h2 class="urpay-title">Complete payment</h2>
            <p class="urpay-subtitle">Secure payment powered by Razorpay</p>
          </div>
          <button class="urpay-close" type="button" aria-label="Close payment">&times;</button>
        </div>
        <div class="urpay-body">
          <div class="urpay-amount">
            <div class="urpay-amount-label">Amount to pay</div>
            <div class="urpay-amount-value">${formatCurrency(payment.amount, payment.currency)}</div>
          </div>
          <div class="urpay-order">Order reference: ${escapeHtml(payment.orderReference)}</div>
          <div class="urpay-status" aria-live="polite"></div>
          <button class="urpay-action" type="button">Continue to payment</button>
          <button class="urpay-secondary" type="button">Cancel</button>
        </div>
      </div>
    `;

    modal = overlay.querySelector(".urpay-modal");

    const close = function () {
      if (state === STATES.CREATING_ORDER || state === STATES.VERIFYING) return;
      setState(STATES.CANCELLED);
      emit("cancelled", {
        orderReference: payment.orderReference
      });
      closeUI();
    };

    overlay.querySelector(".urpay-close").addEventListener("click", close);
    overlay.querySelector(".urpay-secondary").addEventListener("click", close);

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });

    document.body.appendChild(overlay);

    requestAnimationFrame(function () {
      overlay.classList.add("urpay-open");
    });

    return {
      root: overlay,
      action: overlay.querySelector(".urpay-action"),
      status: overlay.querySelector(".urpay-status")
    };
  }

  function setModalStatus(text, type) {
    if (!overlay) return;
    const element = overlay.querySelector(".urpay-status");
    if (!element) return;

    element.className = "urpay-status visible " + (type || "info");
    element.textContent = text || "";
  }

  function closeUI() {
    if (!overlay) return;

    overlay.classList.remove("urpay-open");

    const current = overlay;
    setTimeout(function () {
      if (current && current.parentNode) current.remove();
      if (overlay === current) {
        overlay = null;
        modal = null;
      }
    }, 190);
  }

  function openUI() {
    if (!overlay) return;
    overlay.classList.add("urpay-open");
  }

  function loadRazorpaySDK() {
    if (global.Razorpay) return Promise.resolve(global.Razorpay);

    return new Promise(function (resolve, reject) {
      const existing = document.querySelector(
        'script[data-universal-razorpay-sdk="true"]'
      );

      if (existing) {
        existing.addEventListener("load", function () {
          global.Razorpay ? resolve(global.Razorpay) :
            reject(new Error("Razorpay Checkout failed to initialize."));
        });
        existing.addEventListener("error", function () {
          reject(new Error("Unable to load Razorpay Checkout."));
        });
        return;
      }

      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.dataset.universalRazorpaySdk = "true";

      script.onload = function () {
        if (global.Razorpay) resolve(global.Razorpay);
        else reject(new Error("Razorpay Checkout loaded without the SDK."));
      };

      script.onerror = function () {
        reject(new Error("Unable to load Razorpay Checkout."));
      };

      document.head.appendChild(script);
    });
  }

  async function createBackendOrder(payment) {
    if (config.mode === "mock") {
      await delay(500);

      return {
        ok: true,
        mock: true,
        order: {
          id: "mock_" + Date.now().toString(36),
          reference: payment.orderReference,
          amount: Math.round(payment.amount * 100),
          currency: payment.currency
        }
      };
    }

    requireConfigForLive();

    return callEdgeFunction(config.functions.createOrder, {
      amount: payment.amount,
      currency: payment.currency,
      orderReference: payment.orderReference,
      customer: payment.customer,
      items: payment.items,
      metadata: payment.metadata
    });
  }

  async function verifyBackendPayment(payment, razorpayResponse) {
    if (config.mode === "mock") {
      await delay(500);

      return {
        ok: true,
        verified: true,
        mock: true,
        payment: {
          id: "mock_pay_" + Date.now().toString(36),
          orderId: payment.backendOrderId,
          status: "captured"
        }
      };
    }

    requireConfigForLive();

    return callEdgeFunction(config.functions.verifyPayment, {
      orderReference: payment.orderReference,
      razorpayOrderId: razorpayResponse.razorpay_order_id,
      razorpayPaymentId: razorpayResponse.razorpay_payment_id,
      razorpaySignature: razorpayResponse.razorpay_signature,
      metadata: payment.metadata
    });
  }

  async function openRazorpayCheckout(payment) {
    await loadRazorpaySDK();

    if (!global.Razorpay) {
      throw new Error("Razorpay Checkout is unavailable.");
    }

    const options = {
      key: config.razorpayKeyId,
      amount: Math.round(payment.amount * 100),
      currency: payment.currency,
      name: payment.brandName || "Payment",
      description: payment.description || "Payment",
      order_id: payment.backendOrderId,
      prefill: {
        name: payment.customer && payment.customer.name || "",
        email: payment.customer && payment.customer.email || "",
        contact: payment.customer && payment.customer.phone || ""
      },
      notes: payment.metadata || {},
      theme: {
        color: payment.themeColor || config.theme.color || "#111827"
      },
      modal: {
        ondismiss: function () {
          if (state !== STATES.SUCCESS && state !== STATES.VERIFYING) {
            setState(STATES.CANCELLED);
            emit("cancelled", {
              orderReference: payment.orderReference,
              reason: "razorpay_checkout_dismissed"
            });
          }
        }
      },
      handler: async function (response) {
        await handleRazorpaySuccess(payment, response);
      }
    };

    const checkout = new global.Razorpay(options);

    checkout.on("payment.failed", function (response) {
      const errorData = response && response.error ? response.error : {};
      const error = new Error(
        errorData.description ||
        errorData.reason ||
        "Razorpay reported that the payment failed."
      );

      error.code = errorData.code;
      error.reason = errorData.reason;
      error.metadata = errorData.metadata;

      setState(STATES.FAILED, error);
      emit("failed", {
        error: error,
        orderReference: payment.orderReference
      });

      if (overlay) {
        setModalStatus(error.message, "error");
        const action = overlay.querySelector(".urpay-action");
        if (action) {
          action.disabled = false;
          action.textContent = config.behavior.allowRetry
            ? "Try again"
            : "Close";
        }
      }
    });

    checkout.open();
    setState(STATES.CHECKOUT_OPEN);
    emit("checkout_opened", {
      orderReference: payment.orderReference
    });
  }

  async function handleRazorpaySuccess(payment, response) {
    if (
      !response ||
      !response.razorpay_order_id ||
      !response.razorpay_payment_id ||
      !response.razorpay_signature
    ) {
      const error = new Error(
        "Razorpay returned an incomplete payment response."
      );

      setState(STATES.FAILED, error);
      emit("failed", {
        error: error,
        orderReference: payment.orderReference
      });

      setModalStatus(error.message, "error");
      return;
    }

    setState(STATES.VERIFYING);

    if (overlay) {
      const action = overlay.querySelector(".urpay-action");
      if (action) {
        action.disabled = true;
        action.innerHTML = '<span class="urpay-spinner"></span>Verifying payment...';
      }
      setModalStatus("Verifying your payment securely…", "info");
    }

    try {
      const result = await verifyBackendPayment(payment, response);

      if (!result || result.verified !== true) {
        throw new Error(
          (result && (result.error || result.message)) ||
          "Payment could not be verified."
        );
      }

      setState(STATES.SUCCESS, result);

      const successPayload = {
        orderReference: payment.orderReference,
        razorpayOrderId: response.razorpay_order_id,
        razorpayPaymentId: response.razorpay_payment_id,
        result: result
      };

      emit("success", successPayload);

      if (overlay) {
        const body = overlay.querySelector(".urpay-body");
        if (body) {
          body.innerHTML = `
            <div class="urpay-icon success">✓</div>
            <div style="text-align:center;font-size:21px;font-weight:800">Payment successful</div>
            <div class="urpay-order">${escapeHtml(payment.orderReference)}</div>
            <div class="urpay-status visible success">Your payment has been verified successfully.</div>
            <button class="urpay-action" type="button">Done</button>
          `;

          body.querySelector(".urpay-action").addEventListener(
            "click",
            function () {
              closeUI();
            }
          );
        }
      }

      if (config.behavior.autoCloseOnSuccess) {
        // We intentionally keep the confirmation visible. The customer can
        // close it; host applications receive the success callback immediately.
      }

      return successPayload;
    } catch (error) {
      setState(STATES.FAILED, error);

      emit("failed", {
        error: error,
        orderReference: payment.orderReference,
        razorpayPaymentId: response.razorpay_payment_id
      });

      if (overlay) {
        const action = overlay.querySelector(".urpay-action");
        if (action) {
          action.disabled = false;
          action.textContent = config.behavior.allowRetry
            ? "Retry verification"
            : "Close";
        }

        setModalStatus(
          error.message || "Payment verification failed.",
          "error"
        );
      }

      throw error;
    }
  }

  async function preparePayment(input) {
    if (!isPlainObject(input)) {
      throw new Error("Payment options are required.");
    }

    const rawAmount = await resolveAsync(input.amount);

    const payment = {
      amount: normalizeAmount(rawAmount),
      currency: String(
        input.currency ||
        config.currency ||
        "INR"
      ).toUpperCase(),
      orderReference: String(
        input.orderId ||
        input.orderReference ||
        createExternalReference("ORD")
      ),
      customer: normalizeCustomer(await resolveAsync(input.customer)),
      items: normalizeItems(await resolveAsync(input.items)),
      metadata: isPlainObject(await resolveAsync(input.metadata))
        ? await resolveAsync(input.metadata)
        : {},
      description: input.description
        ? String(input.description)
        : "Payment",
      brandName: input.brandName
        ? String(input.brandName)
        : "Payment",
      themeColor: input.themeColor || config.theme.color
    };

    if (!/^[A-Z]{3}$/.test(payment.currency)) {
      throw new Error("Currency must be a valid 3-letter currency code.");
    }

    if (payment.orderReference.length < 1 || payment.orderReference.length > 100) {
      throw new Error("Order reference must contain 1–100 characters.");
    }

    return payment;
  }

  async function pay(input) {
    if (
      config.behavior.preventDoubleSubmit &&
      activePayment &&
      (
        state === STATES.CREATING_ORDER ||
        state === STATES.CHECKOUT_OPEN ||
        state === STATES.VERIFYING
      )
    ) {
      throw new Error("A payment is already in progress.");
    }

    setState(STATES.VALIDATING);

    let payment;

    try {
      payment = await preparePayment(input);

      activePayment = payment;

      callbacks = {
        success: input.onSuccess,
        failed: input.onFailure,
        cancelled: input.onCancel,
        checkout_opened: input.onCheckoutOpened
      };

      setState(STATES.CREATING_ORDER);

      const ui = buildModal(payment);
      ui.action.disabled = true;
      ui.action.textContent = "Preparing payment…";
      setModalStatus("Creating a secure payment order…", "info");

      const orderResult = await createBackendOrder(payment);

      if (!orderResult || !orderResult.order) {
        throw new Error(
          (orderResult && (orderResult.error || orderResult.message)) ||
          "Payment order creation failed."
        );
      }

      payment.backendOrderId =
        orderResult.order.id ||
        orderResult.order.razorpayOrderId ||
        orderResult.order.razorpay_order_id;

      if (!payment.backendOrderId) {
        throw new Error("Backend did not return a payment order ID.");
      }

      emit("order_created", {
        orderReference: payment.orderReference,
        backendOrderId: payment.backendOrderId,
        result: orderResult
      });

      setState(STATES.READY, orderResult);

      if (config.mode === "mock") {
        ui.action.disabled = false;
        ui.action.textContent = "Simulate successful payment";
        setModalStatus("Demo mode is active. No real payment will be made.", "info");

        ui.action.onclick = async function () {
          if (ui.action.disabled) return;

          ui.action.disabled = true;
          ui.action.innerHTML = '<span class="urpay-spinner"></span>Processing…';

          try {
            const result = await verifyBackendPayment(payment, {
              razorpay_order_id: payment.backendOrderId,
              razorpay_payment_id: "mock_pay_" + Date.now().toString(36),
              razorpay_signature: "mock_signature"
            });

            setState(STATES.SUCCESS, result);

            emit("success", {
              orderReference: payment.orderReference,
              razorpayOrderId: payment.backendOrderId,
              razorpayPaymentId: result.payment.id,
              result: result
            });

            const body = overlay.querySelector(".urpay-body");
            body.innerHTML = `
              <div class="urpay-icon success">✓</div>
              <div style="text-align:center;font-size:21px;font-weight:800">Payment successful</div>
              <div class="urpay-order">${escapeHtml(payment.orderReference)}</div>
              <div class="urpay-status visible success">Demo payment verified successfully.</div>
              <button class="urpay-action" type="button">Done</button>
            `;
            body.querySelector(".urpay-action").onclick = closeUI;
          } catch (error) {
            setState(STATES.FAILED, error);
            emit("failed", {
              error: error,
              orderReference: payment.orderReference
            });

            ui.action.disabled = false;
            ui.action.textContent = "Try again";
            setModalStatus(error.message, "error");
          }
        };

        ui.action.disabled = false;
      } else {
        ui.action.disabled = false;
        ui.action.textContent = "Continue to payment";
        ui.action.onclick = async function () {
          ui.action.disabled = true;
          ui.action.textContent = "Opening Razorpay…";

          try {
            await openRazorpayCheckout(payment);
          } catch (error) {
            setState(STATES.FAILED, error);
            emit("failed", {
              error: error,
              orderReference: payment.orderReference
            });

            ui.action.disabled = false;
            ui.action.textContent = "Try again";
            setModalStatus(error.message, "error");
          }
        };
      }

      return {
        orderReference: payment.orderReference,
        backendOrderId: payment.backendOrderId
      };
    } catch (error) {
      setState(STATES.FAILED, error);

      emit("failed", {
        error: error,
        orderReference: payment ? payment.orderReference : null
      });

      if (overlay) {
        setModalStatus(error.message || "Unable to start payment.", "error");

        const action = overlay.querySelector(".urpay-action");
        if (action) {
          action.disabled = false;
          action.textContent = "Close";
          action.onclick = closeUI;
        }
      }

      activePayment = null;
      throw error;
    }
  }

  function attach(selectorOrElement, options) {
    const element = typeof selectorOrElement === "string"
      ? document.querySelector(selectorOrElement)
      : selectorOrElement;

    if (!element || !(element instanceof Element)) {
      throw new Error("Payment button element was not found.");
    }

    const opts = options || {};

    element.addEventListener("click", async function (event) {
      event.preventDefault();

      if (element.dataset.urpayBusy === "true") return;

      element.dataset.urpayBusy = "true";
      const originalText = element.innerHTML;

      try {
        element.disabled = true;

        const result = await pay({
          amount: opts.amount,
          currency: opts.currency,
          orderId: opts.orderId,
          customer: opts.customer,
          items: opts.items,
          metadata: opts.metadata,
          description: opts.description,
          brandName: opts.brandName,
          themeColor: opts.themeColor,
          onSuccess: opts.onSuccess,
          onFailure: opts.onFailure,
          onCancel: opts.onCancel,
          onCheckoutOpened: opts.onCheckoutOpened
        });

        return result;
      } catch (error) {
        if (typeof opts.onFailure === "function") {
          opts.onFailure({ error: error });
        }
      } finally {
        element.disabled = false;
        element.dataset.urpayBusy = "false";
        element.innerHTML = originalText;
      }
    });

    return function detach() {
      // DOM EventListener removal requires the original handler reference.
      // Use destroy() for SDK-wide cleanup; attach is intentionally simple.
    };
  }

  function autoAttach() {
    document.querySelectorAll("[data-universal-razorpay]").forEach(function (element) {
      if (element.dataset.urpayAttached === "true") return;

      element.dataset.urpayAttached = "true";

      const amountSource = element.getAttribute("data-payment-amount");
      const orderSource = element.getAttribute("data-payment-order");
      const description = element.getAttribute("data-payment-description");

      attach(element, {
        amount: function () {
          if (amountSource) {
            const source = document.querySelector(amountSource);
            if (source) {
              const value = source.value != null ? source.value : source.textContent;
              return Number(String(value).replace(/[^\d.-]/g, ""));
            }
          }

          return Number(element.getAttribute("data-payment-value") || 0);
        },
        orderId: function () {
          return orderSource
            ? ((document.querySelector(orderSource) || {}).value || "")
            : null;
        },
        description: description || "Payment"
      });
    });
  }

  function init(options) {
    if (options && isPlainObject(options)) {
      config = deepMerge(config, options);
    }

    ensureStyles();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", autoAttach, { once: true });
    } else {
      autoAttach();
    }

    return api;
  }

  function getState() {
    return state;
  }

  function getConfig() {
    const copy = deepMerge({}, config);
    if (copy.supabaseAnonKey) {
      // Keep returned configuration usable without exposing unnecessary secrets.
      copy.supabaseAnonKey = "[configured]";
    }
    return copy;
  }

  function close() {
    if (state === STATES.CREATING_ORDER || state === STATES.VERIFYING) {
      return false;
    }

    closeUI();
    return true;
  }

  function destroy() {
    closeUI();
    activePayment = null;
    state = STATES.IDLE;
    events = {};
    callbacks = {};
  }

  function formatCurrency(amount, currency) {
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: currency || "INR",
        maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      return String(currency || "INR") + " " + Number(amount).toFixed(2);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  const api = {
    version: VERSION,
    states: STATES,
    init: init,
    pay: pay,
    attach: attach,
    autoAttach: autoAttach,
    close: close,
    destroy: destroy,
    getState: getState,
    getConfig: getConfig,
    on: on
  };

  global.UniversalRazorpay = api;

})(window);

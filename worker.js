// Dask Everyday Clothing – payment backend (Cloudflare Workers, free tier) + Razorpay
// Secrets (never in frontend): RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, ADMIN_TOKEN (optional)

// ⚠️ SERVER-SIDE PRICE LIST (in ₹ INR). Customer can't tamper with prices – amount is computed here.
// Keep ids/prices in sync with your website products. New product added on the site => add it here too.
const PRODUCTS = {
  1: { name: "Heavyweight tee", price: 28 },
  2: { name: "Boxy hoodie", price: 64 },
  3: { name: "Linen shirt", price: 52 },
  4: { name: "Straight jeans", price: 78 },
  5: { name: "Pleated trousers", price: 70 },
  6: { name: "Cargo shorts", price: 48 },
  7: { name: "Rain shell", price: 110 },
  8: { name: "Wool overcoat", price: 190 },
  9: { name: "Rib beanie", price: 22 },
  10: { name: "Canvas tote", price: 26 },
};
const SIZES = ["XS", "S", "M", "L", "XL"];
const enc = new TextEncoder();

const json = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...h } });

function corsHeaders(env, req) {
  const o = req.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean);
  return o && allowed.includes(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization", Vary: "Origin" }
    : {};
}
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) { // constant-time compare
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const newId = () => "DK-" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const getOrder = async (env, id) => { const v = await env.ORDERS.get("order:" + id); return v ? JSON.parse(v) : null; };
const saveOrder = (env, o) => env.ORDERS.put("order:" + o.id, JSON.stringify(o));

// ---- status machine: PENDING -> PAID | FAILED ; FAILED -> PAID ; PAID is final ----
async function markPaid(env, o, paymentId) {
  if (o.status === "PAID") {
    if (paymentId && paymentId !== o.paymentId && !(o.extraPayments || []).includes(paymentId)) {
      o.extraPayments = [...(o.extraPayments || []), paymentId]; // duplicate payment -> refund manually
      await saveOrder(env, o);
    }
    return o;
  }
  o.status = "PAID"; o.paymentId = paymentId; o.paidAt = new Date().toISOString();
  await saveOrder(env, o);
  return o;
}
async function markFailed(env, o) {
  if (o.status !== "PENDING") return o; // never downgrade PAID
  o.status = "FAILED"; o.failedAt = new Date().toISOString();
  await saveOrder(env, o);
  return o;
}

async function createOrder(env, body) {
  const idem = String(body.idem || "");
  if (!/^[\w-]{16,64}$/.test(idem)) return json({ error: "Invalid request" }, 400);
  const c = body.customer || {};
  const name = String(c.name || "").trim(), mobile = String(c.mobile || "").trim(),
    address = String(c.address || "").trim(), pin = String(c.pin || "").trim(), city = String(c.city || "").trim();
  if (name.length < 2 || name.length > 60 || !/^\d{10}$/.test(mobile) || address.length < 5 || address.length > 300 ||
      !/^\d{6}$/.test(pin) || city.length < 2 || city.length > 80) return json({ error: "Please check your name, mobile, address, PIN and city." }, 400);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) return json({ error: "Cart is empty" }, 400);

  let total = 0; const items = [];
  for (const it of body.items) {
    const p = PRODUCTS[it.id], q = Number(it.q);
    if (!p || !SIZES.includes(it.size) || !Number.isInteger(q) || q < 1 || q > 20) return json({ error: "Invalid product in cart" }, 400);
    total += p.price * q; items.push({ id: Number(it.id), name: p.name, size: it.size, q, price: p.price });
  }
  const amount = Math.round(total * 100); // paise

  // duplicate protection: same idempotency key => same order (no second order / second payment link)
  const existingId = await env.ORDERS.get("idem:" + idem);
  if (existingId) {
    const ex = await getOrder(env, existingId);
    if (ex) return json({ orderId: ex.id, rzpOrderId: ex.rzpOrderId, amount: ex.amount, currency: "INR", keyId: env.RAZORPAY_KEY_ID, status: ex.status, paymentId: ex.paymentId || null });
  }
  const id = newId();
  const r = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET) },
    body: JSON.stringify({ amount, currency: "INR", receipt: id, notes: { orderId: id } }),
  });
  if (!r.ok) return json({ error: "Payment gateway error. Please try again." }, 502);
  const rz = await r.json();
  const order = { id, rzpOrderId: rz.id, amount, status: "PENDING", items, customer: { name, mobile, address, pin, city }, createdAt: new Date().toISOString() };
  await saveOrder(env, order);
  await env.ORDERS.put("rzp:" + rz.id, id);
  await env.ORDERS.put("idem:" + idem, id, { expirationTtl: 7 * 86400 });
  return json({ orderId: id, rzpOrderId: rz.id, amount, currency: "INR", keyId: env.RAZORPAY_KEY_ID, status: "PENDING" });
}

// Backend signature check of the checkout response (authentic only if signed with your key secret)
async function verify(env, body) {
  const o = await getOrder(env, String(body.orderId || ""));
  if (!o || o.rzpOrderId !== body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature) return json({ error: "Invalid" }, 400);
  const exp = await hmacHex(env.RAZORPAY_KEY_SECRET, o.rzpOrderId + "|" + body.razorpay_payment_id);
  if (!safeEq(exp, body.razorpay_signature)) return json({ error: "Signature mismatch" }, 400);
  const u = await markPaid(env, o, body.razorpay_payment_id);
  return json({ status: u.status });
}

async function webhook(env, req) {
  const raw = await req.text();
  const sig = req.headers.get("X-Razorpay-Signature") || "";
  const exp = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!safeEq(exp, sig)) return json({ error: "Bad signature" }, 400); // fake webhooks rejected here
  const evId = req.headers.get("x-razorpay-event-id");
  if (evId) { if (await env.ORDERS.get("evt:" + evId)) return json({ ok: true, duplicate: true }); await env.ORDERS.put("evt:" + evId, "1", { expirationTtl: 3 * 86400 }); }
  let ev; try { ev = JSON.parse(raw); } catch { return json({ error: "Bad body" }, 400); }
  const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  if (!pay || !pay.order_id) return json({ ok: true });
  const oid = await env.ORDERS.get("rzp:" + pay.order_id);
  const o = oid && (await getOrder(env, oid));
  if (!o) return json({ ok: true });
  if ((ev.event === "payment.captured" || ev.event === "order.paid") && pay.status === "captured") {
    if (pay.amount !== o.amount || pay.currency !== "INR") { o.amountMismatch = true; await saveOrder(env, o); return json({ ok: true }); }
    await markPaid(env, o, pay.id);
  } else if (ev.event === "payment.failed") await markFailed(env, o);
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), cors = corsHeaders(env, req);
    const reply = (res) => { Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v)); return res; };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === "/create-order" && req.method === "POST") return reply(await createOrder(env, await req.json()));
      if (url.pathname === "/verify" && req.method === "POST") return reply(await verify(env, await req.json()));
      if (url.pathname === "/webhook" && req.method === "POST") return webhook(env, req);
      if (url.pathname === "/status" && req.method === "GET") {
        const o = await getOrder(env, url.searchParams.get("id") || "");
        return reply(o ? json({ status: o.status, paymentId: o.status === "PAID" ? o.paymentId : null }) : json({ error: "Not found" }, 404));
      }
      if (url.pathname === "/admin/orders" && env.ADMIN_TOKEN) {
        if (!safeEq(req.headers.get("Authorization") || "", "Bearer " + env.ADMIN_TOKEN)) return json({ error: "Unauthorized" }, 401);
        const list = await env.ORDERS.list({ prefix: "order:", limit: 200 });
        const orders = (await Promise.all(list.keys.map((k) => env.ORDERS.get(k.name)))).map((v) => JSON.parse(v));
        return json({ orders: orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      }
      return reply(json({ error: "Not found" }, 404));
    } catch (e) {
      return reply(json({ error: "Server error" }, 500));
    }
  },
};

# Dask Everyday Clothing – Secure Online Payment (Razorpay)

## Kaise kaam karta hai
1. Customer cart banata hai → naam, mobile, address bharta hai → **Pay online** chunta hai.
2. Website backend ko sirf product id / size / qty bhejti hai. **Amount backend khud calculate karta hai** (price tamper nahi ho sakta). Unique Order ID (`DK-XXXXXXXX`) banta hai, status **PENDING**.
3. Razorpay ki secure window khulti hai (UPI / Card / NetBanking).
4. Payment ke baad backend **signature verify** karta hai (checkout response + Razorpay **webhook**). Sirf verified payment par status **PAID** hota hai. Fake/manual UTR ka koi option hi nahi hai.
5. Sirf **PAID** hone par "Order on WhatsApp" button unlock hota hai. Fail/cancel par clear message + "Try payment again".
6. COD option pehle jaisa chalta hai (WhatsApp me "PAYMENT PENDING").

Status: `PENDING → PAID`, `PENDING → FAILED`, `FAILED → PAID` (retry). `PAID` final hai – kabhi downgrade nahi hota.
Duplicate protection: same cart par double-click = same Order ID; webhook dobara aaye to ignore; ek order par 2 payments aaye to `extraPayments` me flag hota hai (manual refund ke liye).

## Files
- `index.html` – aapki website (design/products same, sirf payment flow badla)
- `backend/worker.js` – Cloudflare Worker (free) – order, verify, webhook
- `backend/wrangler.toml` – config

## Setup (step by step)

### 1) Razorpay account
1. https://razorpay.com par account banao. Pehle **Test Mode** me kaam karo.
2. Dashboard → Settings → API Keys → **Generate Key**. `Key ID` (rzp_test_...) aur `Key Secret` copy karo. **Secret kisi ko mat do, HTML me mat daalo.**
3. Settings → Payment Capture → **Automatic capture** rakho.

### 2) Backend deploy (Cloudflare Workers – free)
```bash
npm install -g wrangler
wrangler login
cd backend
wrangler kv namespace create ORDERS      # output me id milegi -> wrangler.toml me paste karo
```
`wrangler.toml` me badlo: `ALLOWED_ORIGIN` (apna `https://USERNAME.github.io`), `RAZORPAY_KEY_ID`, aur KV `id`.

Secrets set karo (ye sirf server par rehte hain):
```bash
wrangler secret put RAZORPAY_KEY_SECRET       # Razorpay Key Secret
wrangler secret put RAZORPAY_WEBHOOK_SECRET   # koi lamba random text (step 3 me wahi daalna hai)
wrangler secret put ADMIN_TOKEN               # optional: orders dekhne ke liye
wrangler deploy
```
Deploy ke baad URL milega, jaise `https://dask-pay.yourname.workers.dev`.

**Prices:** `backend/worker.js` ke upar `PRODUCTS` list me apne products ki real ₹ prices daalo (id wahi jo website me hain). Razorpay sirf INR leta hai. Website ke Edit store me bhi wahi price rakho, nahi to customer ko alag amount dikhega. Naya product add karo to worker.js me bhi add karke dobara `wrangler deploy` karo.

### 3) Webhook set karo
Razorpay Dashboard → Settings → Webhooks → Add:
- URL: `https://dask-pay.yourname.workers.dev/webhook`
- Secret: wahi jo `RAZORPAY_WEBHOOK_SECRET` me daala
- Events: `payment.captured`, `order.paid`, `payment.failed`

### 4) Frontend (GitHub Pages)
1. `index.html` me ye line dhundo aur apna Worker URL daalo:
   `const API_BASE="https://dask-pay.YOUR-SUBDOMAIN.workers.dev";`
2. GitHub repo me `index.html` upload karo → Settings → Pages → Branch `main` / root → Save.
3. (Existing website me merge karna ho to: `/* ===== Online payment ... */` wala block, `startOnline(d)` ki line checkout handler me, aur "Pay online" radio copy karo.)

### 5) Test (Test Mode)
- UPI: `success@razorpay` = success, `failure@razorpay` = fail
- Card: `4111 1111 1111 1111`, koi bhi future expiry, CVV `123`
- Success par "Payment verified – PAID" + WhatsApp button aana chahiye; fail par button nahi aana chahiye.

### 6) Live jao
Razorpay KYC complete karo → Live keys banao → `RAZORPAY_KEY_ID` (wrangler.toml) aur `RAZORPAY_KEY_SECRET` (secret) badlo → live webhook banao → `wrangler deploy`.

## Sabke orders dekhna
```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://dask-pay.yourname.workers.dev/admin/orders
```
Isme har order ka status, paymentId, customer details, aur `extraPayments` (duplicate payment) dikhta hai. Website ka Admin panel abhi bhi sirf usi browser ke orders dikhata hai.

## Dhyan rakhne wali baatein
- Free tier limits: Cloudflare Workers ~100k requests/din, KV ~1000 writes/din – chhoti dukaan ke liye kaafi.
- Purane "UPI QR / UPI ID / UTR" fields ab payment me use nahi hote (Edit store me dikhte rahenge, ignore karo).
- Razorpay ke charges (fee) lagte hain; free sirf hosting hai.
- Agar customer payment ke beech page reload kar de, to wo dubara pay karne se pehle `Order ID` ke saath store se confirm kare; server par status verify hota rehta hai.

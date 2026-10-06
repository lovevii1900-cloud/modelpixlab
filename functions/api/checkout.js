// ModelPixLab Waffo checkout session creator (Cloudflare Pages Function)
// POST /api/checkout  { productId, productType: 'onetime'|'subscription' }
// Returns { checkoutUrl, sessionId }
// Requires login (uses session cookie to get user). Env: WAFFO_MERCHANT_ID, WAFFO_PRIVATE_KEY

const WAFFO_API = 'https://api.waffo.ai';

// Product catalog: maps our plan IDs to Waffo product IDs + credit grants.
// Product IDs are filled in after creating products in Waffo dashboard.
const PRODUCTS = {
  // Subscriptions
  'basic':    { waffoId: null, type: 'subscription', credits: 250 },
  'pro':      { waffoId: null, type: 'subscription', credits: 700 },
  'studio':   { waffoId: null, type: 'subscription', credits: 1600 },
  // One-time credit packs
  'starter':  { waffoId: null, type: 'onetime', credits: 100 },
  'creator':  { waffoId: null, type: 'onetime', credits: 300 },
  'studio-pack': { waffoId: null, type: 'onetime', credits: 800 },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Import RSA private key (PEM) for Web Crypto
async function importPrivateKey(pem) {
  // Normalize: handle escaped newlines, headers
  let clean = pem.replace(/\\n/g, '\n').trim();
  if (!clean.includes('-----BEGIN')) {
    // Raw base64, wrap it
    clean = `-----BEGIN PRIVATE KEY-----\n${clean}\n-----END PRIVATE KEY-----`;
  }
  const b64 = clean
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    binary,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function sha256base64(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function signRequest(method, path, body, timestamp, privateKey) {
  const bodyHash = await sha256base64(body);
  const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  const data = new TextEncoder().encode(canonical);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Get user from session cookie (reuse auth logic pattern)
async function getUserId(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/mpl_session=([^;]+)/);
  if (!match) return null;
  const sessionId = match[1];
  try {
    const db = env.DB;
    const sess = await db.prepare('SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?')
      .bind(sessionId, Date.now()).first();
    return sess ? sess.user_id : null;
  } catch { return null; }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Require login
  const userId = await getUserId(request, env);
  if (!userId) return json({ error: 'login_required' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const planId = (body.planId || '').toString();
  const product = PRODUCTS[planId];
  if (!product) return json({ error: 'invalid_plan' }, 400);
  if (!product.waffoId) return json({ error: 'product_not_configured' }, 503);

  const merchantId = env.WAFFO_MERCHANT_ID;
  const privateKeyPem = env.WAFFO_PRIVATE_KEY;
  if (!merchantId || !privateKeyPem) {
    return json({ error: 'payment_not_configured' }, 503);
  }

  // Get user email for pre-fill
  let buyerEmail = '';
  try {
    const db = env.DB;
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
    if (user) buyerEmail = user.email || '';
  } catch {}

  const path = '/v1/actions/checkout/create-session';
  const timestamp = new Date().toISOString();
  const reqBody = JSON.stringify({
    productId: product.waffoId,
    productType: product.type,
    currency: 'USD',
    ...(buyerEmail ? { buyerEmail } : {}),
    successUrl: 'https://modelpixlab.com/pricing/?paid=1',
    metadata: { userId, planId, credits: String(product.credits) },
  });

  try {
    const privateKey = await importPrivateKey(privateKeyPem);
    const signature = await signRequest('POST', path, reqBody, timestamp, privateKey);

    const resp = await fetch(WAFFO_API + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': merchantId,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
      body: reqBody,
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Waffo checkout error:', resp.status, JSON.stringify(data).slice(0, 500));
      return json({ error: 'checkout_failed', detail: data }, 502);
    }

    // Response: { checkoutUrl, sessionId, expiresAt }
    return json({
      checkoutUrl: data.checkoutUrl,
      sessionId: data.sessionId,
    });
  } catch (e) {
    console.error('Checkout exception:', e.message);
    return json({ error: 'checkout_error' }, 500);
  }
}

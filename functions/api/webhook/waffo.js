// ModelPixLab Waffo webhook handler (Cloudflare Pages Function)
// POST /api/webhook/waffo
// Verifies RSA-SHA256 signature, adds credits on successful payment.
// Events: order.completed (one-time), subscription.activated / subscription.payment_succeeded

// Waffo test-mode webhook public key (embedded from @waffo/pancake-ts SDK)
const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxnmRY6yMMA3lVqmAU6ZG
b1sjL/+r/z6E+ZjkXaDAKiqOhk9rpazni0bNsGXwmftTPk9jy2wn+j6JHODD/WH/
SCnSfvKkLIjy4Hk7BuCgB174C0ydan7J+KgXLkOwgCAxxB68t2tezldwo74ZpXgn
F49opzMvQ9prEwIAWOE+kV9iK6gx/AckSMtHIHpUesoPDkldpmFHlB2qpf1vsFTZ
5kD6DmGl+2GIVK01aChy2lk8pLv0yUMu18v44sLkO5M44TkGPJD9qG09wrvVG2wp
OTVCn1n5pP8P+HRLcgzbUB3OlZVfdFurn6EZwtyL4ZD9kdkQ4EZE/9inKcp3c1h4
xwIDAQAB
-----END PUBLIC KEY-----`;

// TODO: replace with prod key after going live (from SDK prod bundle)
const PROD_PUBLIC_KEY = '';

const TOLERANCE_MS = 45 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function importPublicKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'spki',
    binary,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifySignature(rawBody, sigHeader, env) {
  if (!sigHeader) throw new Error('missing signature header');
  const m = sigHeader.match(/t=(\d+).*?v1=([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error('malformed signature header');
  const [, t, v1] = m;

  // Replay protection
  const age = Date.now() - Number(t);
  if (age > TOLERANCE_MS || age < -60000) throw new Error('timestamp outside tolerance');

  const input = `${t}.${rawBody}`;
  const data = new TextEncoder().encode(input);
  const sig = b64ToBytes(v1);

  // Try test key first, then prod key (or env override)
  const keys = [env.WAFFO_WEBHOOK_PUBLIC_KEY, TEST_PUBLIC_KEY, PROD_PUBLIC_KEY].filter(Boolean);
  for (const pem of keys) {
    try {
      const key = await importPublicKey(pem);
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
      if (ok) return true;
    } catch { /* try next key */ }
  }
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  // MUST read raw text for signature verification
  const rawBody = await request.text();
  const sigHeader = request.headers.get('x-waffo-signature');

  let verified = false;
  try {
    verified = await verifySignature(rawBody, sigHeader, env);
  } catch (e) {
    console.error('Webhook verify error:', e.message);
  }
  if (!verified) {
    console.error('Waffo webhook: invalid signature');
    return new Response('Invalid signature', { status: 401 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  // Idempotency: dedupe by delivery ID
  const deliveryId = event.id;
  if (deliveryId && db) {
    try {
      await db.prepare(`CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY, event_type TEXT, received_at INTEGER
      )`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY, user_id TEXT, waffo_order_id TEXT, event_type TEXT,
        credits INTEGER, amount REAL, currency TEXT, created_at INTEGER
      )`).run();
      const existing = await db.prepare(
        'SELECT id FROM webhook_events WHERE id = ?'
      ).bind(deliveryId).first();
      if (existing) return new Response('OK'); // already processed
      await db.prepare(
        'INSERT INTO webhook_events (id, event_type, received_at) VALUES (?, ?, ?)'
      ).bind(deliveryId, event.eventType || '', Date.now()).run();
    } catch (e) {
      console.error('webhook_events table error:', e.message);
    }
  }

  const type = event.eventType;
  const data = event.data || {};

  // Fulfill: add credits
  if (type === 'order.completed' || type === 'subscription.activated' || type === 'subscription.payment_succeeded') {
    const meta = data.orderMetadata || data.metadata || {};
    const userId = meta.userId;
    const credits = parseInt(meta.credits || '0', 10);

    if (userId && credits > 0 && db) {
      try {
        // Ensure credits row exists
        await db.prepare(
          'INSERT INTO credits (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING'
        ).bind(userId, 0).run();
        await db.prepare(
          'UPDATE credits SET balance = balance + ? WHERE user_id = ?'
        ).bind(credits, userId).run();
        // Record the purchase
        await db.prepare(
          'INSERT INTO purchases (id, user_id, waffo_order_id, event_type, credits, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          deliveryId || `wh_${Date.now()}`,
          userId,
          data.orderId || '',
          type,
          credits,
          data.amount || 0,
          data.currency || 'USD',
          Date.now()
        ).run();
        console.log(`Waffo: granted ${credits} credits to user ${userId} (${type})`);
      } catch (e) {
        console.error('Credit grant failed:', e.message);
        return new Response('OK'); // ack anyway to avoid redelivery loop; investigate manually
      }
    } else {
      console.error('Waffo webhook: missing userId/credits in metadata', JSON.stringify(meta).slice(0, 200));
    }
  }

  // Subscription lifecycle (log for now; access control can be added later)
  if (type === 'subscription.canceled' || type === 'subscription.past_due') {
    console.log(`Waffo: ${type} for order ${data.orderId}`);
  }

  return new Response('OK');
}

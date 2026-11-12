// ModelPixLab image generation proxy (Cloudflare Pages Function)
// POST /api/generate  { prompt, model?, size?, version?, locale? }
// Secrets (set in Pages project settings, never in code):
//   IMAGE_API_KEY      - preferred generic key (works for OpenAI or APIMart relay)
//   OPENAI_API_KEY     - paid/main pool key (official OpenAI)
//   OPENAI_API_KEY_FREE - free pool key with its own low cap on provider side
//   WAFFO_MERCHANT_ID  - Waffo Pancake Merchant ID for Prompt Sift compliance scan
//   WAFFO_PRIVATE_KEY  - Waffo Pancake RSA private key (PKCS#8 PEM or base64)
// Optional env:
//   IMAGE_API_BASE     - e.g. https://api.apimart.ai/v1  (default https://api.openai.com/v1)
//   IMAGE_MODEL        - e.g. gpt-image-2.5-ext for APIMart, gpt-image-2.5 for official naming in site copy
//   IMAGE_ASYNC        - "1" forces APIMart-style async submit+poll; auto-on when base contains "apimart"

const WAFFO_API = 'https://api.waffo.ai';
const WAFFO_SCAN_PATH = '/v1/actions/verification/scan-prompt';

const MODEL_MAP = {
  'GPT Image 2.5': 'gpt-image-2.5',
  'gpt-image-2.5': 'gpt-image-2.5',
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 50000;
const SUBMIT_TIMEOUT_MS = 25000;
const POLL_REQ_TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Waffo Prompt Sift (Content Safety Scan) Helpers ---
async function importWaffoPrivateKey(pem) {
  let clean = pem.replace(/\\n/g, '\n').trim();
  if (!clean.includes('-----BEGIN')) {
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

async function signWaffoRequest(method, path, body, timestamp, privateKey) {
  const bodyHash = await sha256base64(body);
  const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  const data = new TextEncoder().encode(canonical);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function scanPromptWithWaffo(prompt, env, locale) {
  const merchantId = env.WAFFO_MERCHANT_ID;
  const rawKey = env.WAFFO_MODE === 'test'
    ? (env.WAFFO_TEST_PRIVATE_KEY || env.WAFFO_PRIVATE_KEY)
    : env.WAFFO_PRIVATE_KEY;

  if (!merchantId || !rawKey) {
    return { skipped: true, action: 'allow' };
  }

  const payload = { prompt: prompt.slice(0, 10000) };
  if (locale) payload.locale = String(locale).slice(0, 16);
  const payloadStr = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));

  const privateKey = await importWaffoPrivateKey(rawKey);
  const signature = await signWaffoRequest('POST', WAFFO_SCAN_PATH, payloadStr, timestamp, privateKey);

  const res = await fetchWithTimeout(`${WAFFO_API}${WAFFO_SCAN_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Merchant-Id': merchantId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    body: payloadStr,
  }, 8000);

  const result = await res.json().catch(() => null);
  const d = (result && result.data) ? result.data : (result || {});
  const action = d.action || (res.ok ? 'allow' : 'review');
  return {
    action,
    reasonCode: d.reasonCode || '',
    requestId: d.requestId || '',
    status: res.status,
  };
}

function toApimartSize(pixelSize) {
  const map = {
    '1024x1024': { size: '1:1', resolution: '1K' },
    '1536x1024': { size: '3:2', resolution: '1K' },
    '1024x1536': { size: '2:3', resolution: '1K' },
    '2048x2048': { size: '1:1', resolution: '2K' },
    '3840x2160': { size: '16:9', resolution: '4K' },
    '2160x3840': { size: '9:16', resolution: '4K' },
  };
  return map[pixelSize] || { size: '1:1', resolution: '1K' };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const prompt = (body.prompt || '').toString().trim().slice(0, 2000);
  if (!prompt) return json({ error: 'empty_prompt' }, 400);

  const tsSecret = env.TURNSTILE_SECRET_KEY;
  if (tsSecret) {
    const tsToken = (body.turnstileToken || '').toString();
    if (!tsToken) return json({ error: 'turnstile_required' }, 403);
    let tsOk = false;
    try {
      const vr = await fetchWithTimeout(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: tsSecret, response: tsToken }).toString(),
        },
        8000
      );
      const vj = await vr.json().catch(() => ({}));
      tsOk = !!(vj && vj.success);
    } catch { tsOk = false; }
    if (!tsOk) return json({ error: 'turnstile_failed' }, 403);
  }

  const modelId = env.IMAGE_MODEL || MODEL_MAP[body.model] || 'gpt-image-2.5';
  const key = env.IMAGE_API_KEY || env.OPENAI_API_KEY_FREE || env.OPENAI_API_KEY;
  if (!key) return json({ error: 'api_not_configured' }, 503);

  if (!env.DB) return json({ error: 'db_not_configured' }, 503);
  const cookie = request.headers.get('Cookie') || '';
  const sm = cookie.match(/mpl_session=([A-Za-z0-9\-_\.]+)/);
  if (!sm) return json({ error: 'auth_required' }, 401);
  const db = env.DB;
  const nowSec = Math.floor(Date.now() / 1000);
  let userId;
  try {
    const sess = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').bind(sm[1]).first();
    if (!sess || sess.expires_at < nowSec) return json({ error: 'auth_required' }, 401);
    userId = sess.user_id;
    const cred = await db.prepare('SELECT balance FROM credits WHERE user_id = ?').bind(userId).first();
    const balance = cred ? cred.balance : 0;
    if (balance < 1) return json({ error: 'out_of_credits', balance }, 402);
  } catch {
    return json({ error: 'db_error' }, 500);
  }

  // ---- Waffo Prompt Sift compliance scan BEFORE calling upstream image model ----
  try {
    const scan = await scanPromptWithWaffo(prompt, env, body.locale);
    if (scan.action === 'block') {
      return json({
        error: 'prompt_blocked',
        message: 'This prompt violates content safety guidelines. Please modify your prompt and try again.',
        requestId: scan.requestId,
      }, 400);
    }
    if (scan.action === 'review') {
      return json({
        error: 'prompt_review',
        message: 'Prompt safety check requires temporary review. Please try again in a moment.',
        requestId: scan.requestId,
      }, 429);
    }
  } catch (err) {
    return json({ error: 'prompt_scan_failed', message: 'Content safety scan unavailable, please retry.' }, 503);
  }

  const base = (env.IMAGE_API_BASE || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isApimart = /apimart/i.test(base) || env.IMAGE_ASYNC === '1';
  const authHeaders = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };

  let image = null;

  if (isApimart) {
    const { size, resolution } = toApimartSize((body.size || '1024x1024').toString());
    const submitBody = { model: modelId, prompt, size, resolution, n: 1 };
    if (/gpt-image-2\.5-ext/i.test(modelId)) {
      submitBody.version = (body.version || 'flare').toString().toLowerCase() === 'sunburst' ? 'sunburst' : 'flare';
    }

    let submit;
    try {
      submit = await fetchWithTimeout(`${base}/images/generations`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(submitBody),
      }, SUBMIT_TIMEOUT_MS);
    } catch {
      return json({ error: 'upstream_timeout', stage: 'submit' }, 504);
    }
    if (!submit.ok) {
      const detail = await submit.text().catch(() => '');
      return json({ error: 'upstream_error', status: submit.status, detail: detail.slice(0, 300) }, 502);
    }
    const submitData = await submit.json().catch(() => null);
    const taskId =
      (submitData && submitData.data && submitData.data[0] && submitData.data[0].task_id) ||
      (submitData && submitData.task && submitData.task.id) ||
      (submitData && submitData.task_id) || null;

    image = extractImage(submitData);
    if (!image && !taskId) return json({ error: 'no_image_returned', detail: 'submit returned neither image nor task_id' }, 502);

    if (!image && taskId) {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let poll;
        try {
          poll = await fetchWithTimeout(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers: { 'Authorization': `Bearer ${key}` } }, POLL_REQ_TIMEOUT_MS);
        } catch {
          continue;
        }
        if (!poll.ok) continue;
        const pollData = await poll.json().catch(() => null);
        image = extractImage(pollData);
        if (image) break;
        const status = pollData && pollData.data && pollData.data.status;
        if (status === 'failed') {
          const msg = (pollData.data.error && pollData.data.error.message) || 'upstream task failed';
          return json({ error: 'upstream_error', detail: String(msg).slice(0, 300), task_id: taskId }, 502);
        }
      }
      if (!image) return json({ error: 'task_pending', task_id: taskId }, 504);
    }
  } else {
    let upstream;
    try {
      upstream = await fetchWithTimeout(`${base}/images/generations`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ model: modelId, prompt, size: body.size || '1024x1024', n: 1 }),
      }, SUBMIT_TIMEOUT_MS);
    } catch {
      return json({ error: 'upstream_timeout', stage: 'submit' }, 504);
    }
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return json({ error: 'upstream_error', status: upstream.status, detail: detail.slice(0, 300) }, 502);
    }
    const data = await upstream.json().catch(() => null);
    image = extractImage(data);
    if (!image) return json({ error: 'no_image_returned' }, 502);
  }

  try {
    await db.batch([
      db.prepare('UPDATE credits SET balance = balance - 1 WHERE user_id = ? AND balance > 0').bind(userId),
      db.prepare('INSERT INTO generations (id, user_id, prompt, image_url, cost_credits, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(
          Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join(''),
          userId, prompt.slice(0, 500), image, Math.floor(Date.now() / 1000)
        ),
    ]);
  } catch {}

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  return new Response(JSON.stringify({ image }), { status: 200, headers });
}

function extractImage(data) {
  if (!data) return null;
  const d = data.data || data;
  if (Array.isArray(d) && d[0]) {
    if (d[0].url) return d[0].url;
    if (d[0].b64_json) return `data:image/png;base64,${d[0].b64_json}`;
  }
  const images = d && d.result && d.result.images;
  if (Array.isArray(images) && images[0]) {
    const u = images[0].url;
    if (Array.isArray(u) && u[0]) return u[0];
    if (typeof u === 'string' && u) return u;
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

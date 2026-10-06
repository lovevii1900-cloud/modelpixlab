// ModelPixLab image generation proxy (Cloudflare Pages Function)
// POST /api/generate  { prompt, model?, size?, version? }
// Secrets (set in Pages project settings, never in code):
//   IMAGE_API_KEY        — preferred generic key (works for OpenAI or APIMart relay)
//   OPENAI_API_KEY       — paid/main pool key (official OpenAI)
//   OPENAI_API_KEY_FREE  — free pool key with its own low cap on provider side
// Optional env:
//   IMAGE_API_BASE       — e.g. https://api.apimart.ai/v1  (default https://api.openai.com/v1)
//   IMAGE_MODEL          — e.g. gpt-image-2.5-ext for APIMart, gpt-image-2.5 for official naming in site copy
//   IMAGE_ASYNC          — "1" forces APIMart-style async submit+poll; auto-on when base contains "apimart"
// Until keys are configured this returns 503 and the frontend falls back to demo renders.
//
// APIMart note (verified 2026-10-05 against docs.apimart.ai GPT-Image-2.5 / 2.5-ext pages):
// APIMart does NOT return an image in the POST response. It returns an async task
// (data[0].task_id, or task.id). Poll GET {base}/tasks/{task_id} every 2–5s until
// status is completed/failed; the image is at data.result.images[0].url[0]
// (url may be an array or a string). Free generations are locked to 1K.

const MODEL_MAP = {
  'GPT Image 2.5': 'gpt-image-2.5',
  'gpt-image-2.5': 'gpt-image-2.5',
};

// (free quota is now per-account in D1, granted at signup)
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 50000; // stay inside a single request; on timeout we surface task_id instead of silently failing
const SUBMIT_TIMEOUT_MS = 25000; // submit must answer fast; APIMart normally responds in <10s
const POLL_REQ_TIMEOUT_MS = 12000; // each poll request bounded so one hung poll can't stall the loop

// fetch with a hard wall-clock timeout: a hung upstream must degrade to a
// JSON error, never hang the function past the edge gateway timeout.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Frontend sends pixel sizes (1024x1024 / 1536x1024 / 1024x1536). APIMart wants ratio + resolution tier.
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

  // Turnstile bot check — runs before the free quota is touched.
  // Skipped gracefully if TURNSTILE_SECRET_KEY isn't configured yet.
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

  // ---- Account auth (required): Google sign-in, 3 free images for new accounts ----
  if (!env.DB) return json({ error: 'db_not_configured' }, 503);
  const cookie = request.headers.get('Cookie') || '';
  const sm = cookie.match(/mpl_session=([A-Za-z0-9\-_]+)/);
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

  const base = (env.IMAGE_API_BASE || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isApimart = /apimart/i.test(base) || env.IMAGE_ASYNC === '1';
  const authHeaders = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };

  let image = null;

  if (isApimart) {
    // --- Async submit + poll (APIMart) ---
    const { size, resolution } = toApimartSize((body.size || '1024x1024').toString());
    const submitBody = { model: modelId, prompt, size, resolution, n: 1 };
    // gpt-image-2.5-ext selects Flare/Sunburst via `version`; direct -flare/-sunburst models ignore it.
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

    // Some relays still answer synchronously with an image — accept that too.
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
          continue; // hung poll: treat as transient, keep trying until deadline
        }
        if (!poll.ok) continue; // transient poll errors: keep trying until deadline
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
    // --- Synchronous path (official OpenAI-style) ---
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

  // Deduct 1 credit + record the generation (only on success)
  try {
    await db.batch([
      db.prepare('UPDATE credits SET balance = balance - 1 WHERE user_id = ? AND balance > 0').bind(userId),
      db.prepare('INSERT INTO generations (id, user_id, prompt, image_url, cost_credits, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(
          Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join(''),
          userId, prompt.slice(0, 500), image, Math.floor(Date.now() / 1000)
        ),
    ]);
  } catch { /* credit bookkeeping must not fail the response */ }

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  return new Response(JSON.stringify({ image }), { status: 200, headers });
}

// Accepts both the OpenAI sync shape (data[0].url / b64_json) and the APIMart
// completed-task shape (data.result.images[0].url[0] | .url).
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

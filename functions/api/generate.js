// ModelPixLab image generation proxy (Cloudflare Pages Function)
// POST /api/generate  { prompt, model?, size? }
// Secrets (set in Pages project settings, never in code):
//   OPENAI_API_KEY       — paid/main pool key
//   OPENAI_API_KEY_FREE  — free pool key with its own low daily cap on OpenAI side
// Until keys are configured this returns 503 and the frontend falls back to demo renders.

const MODEL_MAP = {
  'GPT Image 2.5': 'gpt-image-2.5',
  'gpt-image-2.5': 'gpt-image-2.5',
};

const FREE_LIMIT = 5; // one-time welcome grant per new account (cookie stand-in until accounts launch)

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const prompt = (body.prompt || '').toString().trim().slice(0, 2000);
  if (!prompt) return json({ error: 'empty_prompt' }, 400);

  const modelId = MODEL_MAP[body.model] || 'gpt-image-2.5';
  const key = env.OPENAI_API_KEY_FREE || env.OPENAI_API_KEY;
  if (!key) return json({ error: 'api_not_configured' }, 503);

  // Soft per-visitor daily cap via cookie counter (UX layer; real enforcement: CF rate-limit rules)
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/mpl_free=(\d+)/);
  const used = m ? parseInt(m[1], 10) : 0;
  if (used >= FREE_DAILY_LIMIT) {
    return json({ error: 'free_limit_reached', limit: FREE_LIMIT }, 429);
  }

  const upstream = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, prompt, size: body.size || '1024x1024', n: 1 }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: 'upstream_error', status: upstream.status, detail: detail.slice(0, 300) }, 502);
  }
  const data = await upstream.json();
  const item = (data.data && data.data[0]) || {};
  const image = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
  if (!image) return json({ error: 'no_image_returned' }, 502);

  const headers = {
    'Content-Type': 'application/json',
    'Set-Cookie': `mpl_free=${used + 1}; Path=/; Max-Age=86400; SameSite=Lax`,
    'Cache-Control': 'no-store',
  };
  return new Response(JSON.stringify({ image }), { status: 200, headers });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

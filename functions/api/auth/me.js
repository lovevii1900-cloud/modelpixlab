// ModelPixLab auth: current user + credits
// GET /api/auth/me → { user: {name, email, avatar}, credits: n } or 401

function nowSec() { return Math.floor(Date.now() / 1000); }

export async function onRequestGet(context) {
  const { request, env } = context;
  const json = (o, s = 200) => new Response(JSON.stringify(o), {
    status: s, headers: { 'Content-Type': 'application/json' },
  });
  if (!env.DB) return json({ error: 'db_not_configured' }, 503);

  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/mpl_session=([A-Za-z0-9\-_]+)/);
  if (!m) return json({ error: 'not_logged_in' }, 401);

  const db = env.DB;
  const sess = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').bind(m[1]).first();
  if (!sess || sess.expires_at < nowSec()) {
    return json({ error: 'session_expired' }, 401);
  }
  const user = await db.prepare('SELECT name, email, avatar FROM users WHERE id = ?').bind(sess.user_id).first();
  const cred = await db.prepare('SELECT balance FROM credits WHERE user_id = ?').bind(sess.user_id).first();
  return json({
    user: { name: user?.name || '', email: user?.email || '', avatar: user?.avatar || '' },
    credits: cred ? cred.balance : 0,
  });
}

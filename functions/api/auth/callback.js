// ModelPixLab auth: Google OAuth callback
// GET /api/auth/callback?code=...&state=... → verify, create user, set session, redirect home

const FREE_GRANT = 3; // one-time free images for new accounts
const SESSION_DAYS = 30;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function rid() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}
function nowSec() { return Math.floor(Date.now() / 1000); }

export async function onRequestGet(context) {
  const { request, env } = context;
  const fail = (msg) => Response.redirect('https://modelpixlab.com/?auth=' + encodeURIComponent(msg), 302);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return fail('missing_code');

  // Verify state CSRF token
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/mpl_oauth_state=([A-Za-z0-9\-_]+)/);
  if (!m || m[1] !== state) return fail('bad_state');

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !env.DB) return fail('not_configured');

  // Exchange code for tokens
  let tokens;
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'https://modelpixlab.com/api/auth/callback',
        grant_type: 'authorization_code',
      }).toString(),
    });
    tokens = await tr.json();
  } catch { return fail('token_exchange_failed'); }
  if (!tokens.access_token) return fail('token_exchange_failed');

  // Get user info
  let info;
  try {
    const ir = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    info = await ir.json();
  } catch { return fail('userinfo_failed'); }
  if (!info.sub || !info.email) return fail('userinfo_failed');

  // Upsert user + grant free credits for new accounts
  const db = env.DB;
  const now = nowSec();
  try {
    let user = await db.prepare('SELECT id FROM users WHERE google_sub = ?').bind(info.sub).first();
    let userId;
    if (user) {
      userId = user.id;
      await db.prepare('UPDATE users SET email = ?, name = ?, avatar = ? WHERE id = ?')
        .bind(info.email, info.name || '', info.picture || '', userId).run();
    } else {
      userId = rid();
      await db.prepare('INSERT INTO users (id, google_sub, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, info.sub, info.email, info.name || '', info.picture || '', now).run();
      await db.prepare('INSERT INTO credits (user_id, balance, granted_free) VALUES (?, ?, 1)')
        .bind(userId, FREE_GRANT).run();
    }

    // Create session
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const exp = now + SESSION_DAYS * 86400;
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(token, userId, exp).run();

    const headers = new Headers();
    headers.set('Location', 'https://modelpixlab.com/?auth=ok');
    headers.append('Set-Cookie', `mpl_session=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
    headers.append('Set-Cookie', 'mpl_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return fail('db_error');
  }
}

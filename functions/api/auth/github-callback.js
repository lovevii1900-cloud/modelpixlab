// ModelPixLab auth: GitHub OAuth callback
// GET /api/auth/github-callback?code=...&state=... → verify, create user, set session, redirect home

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

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret || !env.DB) return fail('not_configured');

  // Exchange code for access token
  let tokenData;
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: 'https://modelpixlab.com/api/auth/github-callback',
      }),
    });
    tokenData = await tr.json();
  } catch { return fail('token_exchange_failed'); }
  if (!tokenData.access_token) return fail('token_exchange_failed');

  const ghHeaders = {
    'Authorization': `Bearer ${tokenData.access_token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ModelPixLab',
  };

  // Get GitHub user profile
  let profile;
  try {
    const pr = await fetch('https://api.github.com/user', { headers: ghHeaders });
    profile = await pr.json();
  } catch { return fail('userinfo_failed'); }
  if (!profile.id) return fail('userinfo_failed');

  // Get primary verified email (profile.email is often null)
  let email = profile.email || '';
  try {
    const er = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
    const emails = await er.json();
    if (Array.isArray(emails)) {
      const primary = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) || emails[0];
      if (primary && primary.email) email = primary.email;
    }
  } catch { /* keep profile email */ }

  const githubId = String(profile.id);
  const name = profile.name || profile.login || '';
  const avatar = profile.avatar_url || '';
  // Fallback identifier if no email: use login-based placeholder
  const emailVal = email || `${profile.login}@github.local`;

  // Upsert user + grant free credits for new accounts
  const db = env.DB;
  const now = nowSec();
  try {
    let user = await db.prepare('SELECT id FROM users WHERE github_id = ?').bind(githubId).first();
    let userId;
    if (user) {
      userId = user.id;
      await db.prepare('UPDATE users SET email = ?, name = ?, avatar = ? WHERE id = ?')
        .bind(emailVal, name, avatar, userId).run();
    } else {
      userId = rid();
      await db.prepare('INSERT INTO users (id, github_id, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, githubId, emailVal, name, avatar, now).run();
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

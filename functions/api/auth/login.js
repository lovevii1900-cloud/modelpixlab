// ModelPixLab auth: Google OAuth login
// GET /api/auth/login → redirect to Google consent screen

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestGet(context) {
  const { env } = context;
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response(JSON.stringify({ error: 'oauth_not_configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
  // CSRF state token, verified in callback
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const redirectUri = 'https://modelpixlab.com/api/auth/callback';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      // state cookie: short-lived, HttpOnly
      'Set-Cookie': `mpl_oauth_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

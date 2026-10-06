// ModelPixLab auth: GitHub OAuth login
// GET /api/auth/github → redirect to GitHub authorization

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestGet(context) {
  const { env } = context;
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return new Response('GitHub login not configured', { status: 500 });
  }

  // CSRF state token in HttpOnly cookie
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://modelpixlab.com/api/auth/github-callback',
    scope: 'read:user user:email',
    state,
  });

  const headers = new Headers();
  headers.set('Location', 'https://github.com/login/oauth/authorize?' + params.toString());
  headers.append('Set-Cookie', `mpl_oauth_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

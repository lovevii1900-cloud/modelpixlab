// ModelPixLab auth: logout
// POST /api/auth/logout → delete session, clear cookie

export async function onRequestPost(context) {
  const { request, env } = context;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/mpl_session=([A-Za-z0-9\-_]+)/);
  if (m && env.DB) {
    try {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(m[1]).run();
    } catch {}
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'mpl_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    },
  });
}

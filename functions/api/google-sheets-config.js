export function onRequestGet(context) {
    return Response.json({
        clientId: String(context.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
    }, { headers: { 'Cache-Control': 'no-store' } });
}

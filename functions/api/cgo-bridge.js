// Reads the CGO PLAN sheet through the Apps Script bridge.
//
// The AirAsia Google Cloud organization enforces
// `iam.disableServiceAccountKeyCreation`, so the Worker cannot hold a Google
// service-account key. Instead it calls a small Apps Script web app that runs as
// an account which already has access to the sheet (see
// integrations/cgo-bridge/Code.gs) and authenticates with a shared token.
//
// Required configuration:
//   CGO_BRIDGE_URL    the Apps Script web-app /exec URL
//   CGO_BRIDGE_TOKEN  the same token configured in the script's properties (a secret)
//
// The token is sent as a query parameter because an Apps Script web app cannot
// read request headers and a POST body does not survive Google's 302 redirect.
// That means the token can appear in request logs on either side, so it is
// treated as rotatable: change it in the script and in Cloudflare together.

const BRIDGE_HOST = 'script.google.com';

// A misconfigured URL is refused rather than fetched: without this the Worker
// would happily POST its bridge token to whatever host an env var named.
export function sanitizeBridgeUrl(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) {
    throw new Error('CGO sync is not configured: set the CGO_BRIDGE_URL variable in Cloudflare Pages to the Apps Script /exec URL, then redeploy.');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('CGO_BRIDGE_URL is not a valid URL. Paste the full https://script.google.com/macros/s/.../exec address.');
  }
  if (parsed.protocol !== 'https:') throw new Error('CGO_BRIDGE_URL must be an https URL.');
  if (parsed.hostname !== BRIDGE_HOST) {
    throw new Error(`CGO_BRIDGE_URL must point at ${BRIDGE_HOST}. Paste the /exec URL from the Apps Script deployment.`);
  }
  if (!parsed.pathname.endsWith('/exec')) {
    throw new Error('CGO_BRIDGE_URL must be the /exec deployment URL, not the /dev URL or the editor link.');
  }
  return parsed;
}

export async function readBridgeValues(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const url = sanitizeBridgeUrl(env && env.CGO_BRIDGE_URL);
  const token = String((env && env.CGO_BRIDGE_TOKEN) || '').trim();
  if (!token) {
    throw new Error('CGO sync is not configured: set the CGO_BRIDGE_TOKEN secret in Cloudflare Pages, then redeploy.');
  }

  // The token is appended verbatim; the script compares it in constant time.
  const target = `${url.toString()}${url.search ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const response = await fetchImpl(target, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // A deployment whose access is not "Anyone" answers with a Google sign-in
    // page and HTTP 200, so this message is the one that actually helps.
    throw new Error('The CGO bridge did not return JSON. Check that the Apps Script deployment has "Who has access: Anyone" and that CGO_BRIDGE_URL is its /exec URL.');
  }
  if (!payload || payload.ok !== true) {
    const detail = payload && payload.error ? payload.error : 'unknown error';
    if (/unauthorized/i.test(detail)) {
      throw new Error('The CGO bridge rejected the token. CGO_BRIDGE_TOKEN must match CGO_BRIDGE_TOKEN in the Apps Script project properties.');
    }
    throw new Error(`The CGO bridge could not read the sheet: ${detail}`);
  }
  if (!Array.isArray(payload.values)) {
    throw new Error('The CGO bridge returned no sheet values. Check that the Apps Script points at the CGO PLAN spreadsheet.');
  }
  return {
    values: payload.values,
    sheetName: payload.sheetName || null,
    readAt: payload.readAt || null,
    fetchedAt: now
  };
}

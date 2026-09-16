const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = '__Host-awq_session';
const CSRF_COOKIE = 'awq_csrf';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const raw = String(value);
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((raw.length + 3) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Invalid email');
  return email;
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.get('Cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

async function digestText(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: base64UrlToBytes(salt), iterations, hash: 'SHA-256' }, key, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

async function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Password must be 12-256 characters');
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToBase64Url(saltBytes);
  return { hash: await derivePassword(password, salt), salt, iterations: PBKDF2_ITERATIONS, algorithm: 'PBKDF2-SHA-256' };
}

export async function verifyPassword(password, row) {
  if (!row || typeof password !== 'string') return false;
  return constantTimeEqual(await derivePassword(password, row.password_salt, Number(row.password_iterations)), row.password_hash);
}

function cookieHeader(name, value, options) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Lax'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

export function clearAuthCookies(headers) {
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }));
  headers.append('Set-Cookie', cookieHeader(CSRF_COOKIE, '', { maxAge: 0 }));
}

export async function getRequestUser(context) {
  const token = parseCookies(context.request)[SESSION_COOKIE];
  if (!token) return null;
  const row = await context.env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.expires_at, u.email_normalized, u.email_display,
            u.role, u.must_change_password, u.is_active
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL LIMIT 1`
  ).bind(await digestText(token)).first();
  if (!row || Number(row.is_active) !== 1 || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { id: Number(row.user_id), email: row.email_display, normalizedEmail: row.email_normalized, role: row.role, mustChangePassword: Number(row.must_change_password) === 1, sessionId: Number(row.session_id) };
}

export function requireCsrf(context) {
  const cookies = parseCookies(context.request);
  const header = context.request.headers.get('X-AWQ-CSRF') || '';
  if (!header || !cookies[CSRF_COOKIE] || header !== cookies[CSRF_COOKIE]) return 'Invalid CSRF token';
  return null;
}

export async function createSession(context, userId) {
  const token = randomToken();
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await context.env.DB.prepare('INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)').bind(userId, await digestText(token), expiresAt).run();
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, token, { httpOnly: true }));
  headers.append('Set-Cookie', cookieHeader(CSRF_COOKIE, csrf, {}));
  return { headers, expiresAt };
}

export async function revokeCurrentSession(context, user) {
  if (user) await context.env.DB.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL').bind(user.sessionId).run();
}

export async function revokeUserSessions(context, userId) {
  await context.env.DB.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').bind(userId).run();
}

export async function audit(context, actorUserId, action, targetUserId, result, changeSummary = null) {
  try {
    await context.env.DB.prepare('INSERT INTO auth_audit_log (actor_user_id, action, target_user_id, request_id, result, change_summary) VALUES (?, ?, ?, ?, ?, ?)').bind(actorUserId || null, action, targetUserId || null, context.request.headers.get('CF-Ray') || null, result, changeSummary ? String(changeSummary).slice(0, 500) : null).run();
  } catch (error) {
    console.error('[AUTH] audit failed:', error.message);
  }
}

export { normalizeEmail };

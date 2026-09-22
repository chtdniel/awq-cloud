import { getRequestUser } from './auth.js';
import { resolveRouteForFlight } from '../../shared/routegeom.mjs';
import { computeRouteHits, fromWarningRow, DEFAULT_BUFFER_NM } from '../../shared/wxwarning.mjs';
import { flightLegWindows, parseTafValidity, tafValidityLabel, validityCoversWindow } from '../../shared/wxtime.mjs';

const ASSIST_ORIGINS = new Set([
  'https://assist.christiandaniel.my.id',
  'https://awq-dispatch-assist.ciz-awq.workers.dev'
]);
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hashToken(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function redirectNoStore(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache'
    }
  });
}

function bearer(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function parseIds(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 500);
  } catch {
    return [];
  }
}

function parseFlightIdentity(callsign) {
  const value = String(callsign || '').trim().toUpperCase();
  const match = value.match(/^([A-Z]{2,3})\s*(\d{1,4})$/);
  if (!match) return { operator: null, flightNumber: null };
  return { operator: match[1], flightNumber: match[2] };
}

async function assistUserFromBearer(context, request) {
  const rawToken = bearer(request);
  if (!rawToken) return null;
  return context.env.DB.prepare(
    `SELECT t.user_id
       FROM assist_tokens t
       JOIN auth_users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND t.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
      LIMIT 1`
  ).bind(await hashToken(rawToken)).first();
}

async function auditDispatch(context, userId, action, resourceType, resourceId, detail = null) {
  try {
    await context.env.DB.prepare(
      'INSERT INTO dispatch_audit_events (user_id, action, resource_type, resource_id, detail) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId || null, action, resourceType, resourceId == null ? null : String(resourceId), detail).run();
  } catch (error) {
    console.warn('[ASSIST] audit write failed:', error.message);
  }
}

function assistantTokens(question) {
  return [...new Set(String(question || '').toUpperCase().match(/[A-Z0-9]{3,}/g) || [])].slice(0, 8);
}

function fallbackAssistant(question, rows, flight) {
  const excerpts = rows.slice(0, 4).map(row => ({
    document: row.file_name,
    category: row.category,
    excerpt: row.content.slice(0, 700)
  }));
  return {
    answer: excerpts.length
      ? `I found ${excerpts.length} relevant manual excerpt${excerpts.length === 1 ? '' : 's'}. Review the cited excerpts before making an operational decision.`
      : 'No indexed manual excerpt matched the question. Verify the source manual directly before making an operational decision.',
    source: 'extractive-fallback',
    flight: flight || null,
    citations: excerpts
  };
}

async function handleDispatchAssistant(context, request) {
  const user = await assistUserFromBearer(context, request);
  if (!user) return json({ ok: false, code: 'SSO_REQUIRED', message: 'A valid Dispatch Assist session is required.', data: null }, 401);
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'A JSON request body is required.' }, 400); }
  const question = String(payload?.question || '').trim().slice(0, 500);
  if (question.length < 3) return json({ error: 'Enter an operational question.' }, 400);
  const flightId = Number(payload?.flightId || 0);
  let flight = null;
  if (flightId > 0) {
    const board = await context.env.DB.prepare('SELECT row_ids FROM user_board_state WHERE user_id = ?').bind(user.user_id).first();
    if (!parseIds(board?.row_ids).includes(flightId)) return json({ error: 'The selected flight is not available on the active board.' }, 403);
    flight = await context.env.DB.prepare(
      'SELECT id, callsign, dep, dest, alt, enr1, enr2, enr3, etd, eta, dof FROM flights WHERE id = ? LIMIT 1'
    ).bind(flightId).first();
  }
  const tokens = assistantTokens(question);
  let rows = [];
  if (tokens.length) {
    const clauses = tokens.map(() => 'UPPER(c.content) LIKE ?').join(' OR ');
    const binds = tokens.map(token => `%${token}%`);
    const result = await context.env.DB.prepare(
      `SELECT c.content, d.file_name, d.category
         FROM reference_document_chunks c
         JOIN reference_documents d ON d.id = c.reference_document_id
        WHERE ${clauses}
        ORDER BY d.created_at DESC, c.chunk_index ASC
        LIMIT 8`
    ).bind(...binds).all();
    rows = result.results || [];
  }
  const fallback = fallbackAssistant(question, rows, flight);
  const key = context.env.GEMINI_API_KEY;
  if (!key) {
    await auditDispatch(context, user.user_id, 'assistant_query', 'flight', flightId || null, 'fallback');
    return json({ ok: true, data: fallback });
  }
  const contextText = rows.map((row, index) => `[${index + 1}] ${row.file_name} (${row.category})\n${row.content.slice(0, 1800)}`).join('\n\n');
  const flightText = flight ? JSON.stringify(flight) : 'No flight selected.';
  const body = {
    system_instruction: { parts: [{ text: 'You are AWQ Dispatch Assist. Answer only from the provided manual excerpts and flight context. If evidence is missing, say so. Do not invent procedures. Include citation markers like [1]. This is decision support, not an authorization to dispatch.' }] },
    contents: [{ parts: [{ text: `QUESTION:\n${question}\n\nFLIGHT CONTEXT:\n${flightText}\n\nMANUAL EXCERPTS:\n${contextText || 'No matching excerpts.'}` }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 700 }
  };
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = response.ok ? await response.json() : null;
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (answer) {
      await auditDispatch(context, user.user_id, 'assistant_query', 'flight', flightId || null, 'gemini');
      return json({ ok: true, data: { answer, source: 'gemini', flight, citations: rows.slice(0, 8).map(row => ({ document: row.file_name, category: row.category })) } });
    }
  } catch (error) {
    console.warn('[ASSIST] assistant provider failed:', error.message);
  }
  await auditDispatch(context, user.user_id, 'assistant_query', 'flight', flightId || null, 'fallback-provider-error');
  return json({ ok: true, data: fallback });
}

function alternateList(value, limit) {
  return String(value || '').trim().toUpperCase().split(/[\s,;/]+/).filter(Boolean).slice(0, limit);
}

function routeImpactSeverity(nm) {
  if (!Number.isFinite(nm)) return 'Advisory';
  if (nm <= 25) return 'Critical';
  if (nm <= 50) return 'Warning';
  return 'Advisory';
}

async function handleStart(context, url) {
  const returnOrigin = url.searchParams.get('return') || '';
  if (!ASSIST_ORIGINS.has(returnOrigin)) return json({ error: 'Unsupported return origin.' }, 400);
  const user = await getRequestUser(context);
  if (!user) return json({ error: 'AWQ Cloud login is required before connecting Dispatch Assist.', code: 'AUTH_REQUIRED' }, 401);

  const code = randomToken(32);
  await context.env.DB.prepare(
    'INSERT INTO assist_auth_codes (token_hash, user_id, return_origin, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(await hashToken(code), user.id, returnOrigin, new Date(Date.now() + CODE_TTL_MS).toISOString()).run();

  const redirect = new URL('/auth/callback', returnOrigin);
  redirect.searchParams.set('code', code);
  return redirectNoStore(redirect.toString());
}

async function handleExchange(context, url) {
  const code = url.searchParams.get('code') || '';
  if (!code) return json({ error: 'Authorization code is required.' }, 400);
  const tokenHash = await hashToken(code);
  const row = await context.env.DB.prepare(
    `SELECT c.user_id, c.return_origin
       FROM assist_auth_codes c
       JOIN auth_users u ON u.id = c.user_id
      WHERE c.token_hash = ? AND c.used_at IS NULL
        AND c.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
      LIMIT 1`
  ).bind(tokenHash).first();
  if (!row) return json({ error: 'Authorization code is invalid or expired.', code: 'INVALID_CODE' }, 401);

  const used = await context.env.DB.prepare(
    'UPDATE assist_auth_codes SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL'
  ).bind(tokenHash).run();
  if (!Number(used.meta?.changes || 0)) return json({ error: 'Authorization code has already been used.', code: 'INVALID_CODE' }, 401);

  const token = randomToken(32);
  await context.env.DB.prepare(
    'INSERT INTO assist_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(await hashToken(token), row.user_id, new Date(Date.now() + TOKEN_TTL_MS).toISOString()).run();
  return json({ ok: true, token, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() });
}

/**
 * Shape one flight row for the dispatch-assist board.
 *
 * Why the schedule is normalised here
 *   `etd`/`eta` are stored as published and may carry only a clock time, or an ISO
 *   instant whose date is stale by weeks — see the note on `flightInstant` in
 *   shared/wxtime.mjs, where a production row carried `dof=20260917` with an
 *   `etd` of `2026-09-08`. Handing those values straight to a consumer forced the
 *   consumer to guess the date, and an overnight sector arrived before it departed.
 *   The absolute instants are therefore computed here, from `dof` plus the clock,
 *   reusing the same `flightLegWindows` the weather path already applies.
 *
 * What the fields mean
 *   `std` / `sta`        absolute ISO instants, or null when no date can be established
 *   `publishedStd` / `publishedSta`  the stored values, so nothing is lost when the instant is null
 *   `dof`                the operator-controlled date of flight, echoed to the consumer
 *
 * Exported for testing: the normalisation is the part that was silently wrong, so it
 * is pinned by a unit test rather than only exercised through a D1 mock.
 */
export function boardFlightRow(item) {
  const identity = parseFlightIdentity(item.callsign);
  const schedule = flightLegWindows(item.etd, item.eta, item.dof);
  const instant = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    id: Number(item.id),
    callsign: item.callsign || null,
    operator: identity.operator,
    flightNumber: identity.flightNumber,
    origin: item.dep || null,
    destination: item.dest || null,
    std: instant(schedule.stdMs),
    sta: instant(schedule.staMs),
    publishedStd: item.etd || null,
    publishedSta: item.eta || null,
    dof: item.dof || null,
    aircraft: { type_code: item.type_code || null, registration: item.registration || null },
    destinationAlternates: alternateList(item.alt, 2),
    enrouteAlternates: [item.enr1, item.enr2, item.enr3].map(value => String(value || '').trim().toUpperCase()).filter(Boolean).slice(0, 3)
  };
}

async function handleFlightBoard(context, request) {
  const rawToken = bearer(request);
  if (!rawToken) return json({ ok: false, code: 'SSO_REQUIRED', message: 'AWQ Cloud SSO is required before active flight data can be requested.', data: null }, 401);
  const row = await context.env.DB.prepare(
    `SELECT t.user_id
       FROM assist_tokens t
       JOIN auth_users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND t.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
      LIMIT 1`
  ).bind(await hashToken(rawToken)).first();
  if (!row) return json({ ok: false, code: 'SSO_REQUIRED', message: 'The Dispatch Assist session is invalid or expired.', data: null }, 401);

  const board = await context.env.DB.prepare('SELECT row_ids FROM user_board_state WHERE user_id = ?').bind(row.user_id).first();
  const ids = parseIds(board?.row_ids);
  if (!ids.length) return json({ ok: true, data: { flights: [], fetchedAt: new Date().toISOString() } });
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await context.env.DB.prepare(
    `SELECT f.id, f.callsign, f.dep, f.dest, f.etd, f.eta, f.dof, f.alt, f.enr1, f.enr2, f.enr3,
            f.ac_type AS registration, a.type_code
       FROM flights f
       LEFT JOIN aircraft a ON a.registration = f.ac_type
      WHERE f.id IN (${placeholders})`
  ).bind(...ids).all();
  const byId = new Map((results || []).map(item => [Number(item.id), item]));
  const flights = ids.map(id => byId.get(id)).filter(Boolean).map(boardFlightRow);
  return json({ ok: true, data: { flights, fetchedAt: new Date().toISOString() } });
}

async function handleFlightWeather(context, request, url) {
  const rawToken = bearer(request);
  if (!rawToken) return json({ ok: false, code: 'SSO_REQUIRED', message: 'AWQ Cloud SSO is required before weather data can be requested.', data: null }, 401);
  const user = await context.env.DB.prepare(
    `SELECT t.user_id
       FROM assist_tokens t
       JOIN auth_users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND t.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
      LIMIT 1`
  ).bind(await hashToken(rawToken)).first();
  if (!user) return json({ ok: false, code: 'SSO_REQUIRED', message: 'The Dispatch Assist session is invalid or expired.', data: null }, 401);

  const flightId = Number(url.searchParams.get('flight_id'));
  if (!Number.isInteger(flightId) || flightId <= 0) return json({ ok: false, code: 'INVALID_FLIGHT', message: 'A valid flight_id is required.', data: null }, 400);
  const board = await context.env.DB.prepare('SELECT row_ids FROM user_board_state WHERE user_id = ?').bind(user.user_id).first();
  if (!parseIds(board?.row_ids).includes(flightId)) return json({ ok: false, code: 'FLIGHT_NOT_AVAILABLE', message: 'The selected flight is not available on the active board.', data: null }, 403);

  const flight = await context.env.DB.prepare(
    'SELECT id, dep, dest, alt, enr1, enr2, enr3, etd, eta, dof FROM flights WHERE id = ? LIMIT 1'
  ).bind(flightId).first();
  if (!flight) return json({ ok: false, code: 'FLIGHT_NOT_FOUND', message: 'The selected flight was not found.', data: null }, 404);

  const stationRoles = [
    ['Departure', flight.dep],
    ['Destination', flight.dest],
    ['Destination alternate', flight.alt],
    ['Enroute alternate 1', flight.enr1],
    ['Enroute alternate 2', flight.enr2],
    ['Enroute alternate 3', flight.enr3]
  ].map(([role, station]) => ({ role, station: String(station || '').trim().toUpperCase() })).filter(item => item.station);
  const stations = [...new Set(stationRoles.map(item => item.station))];
  const legWindows = flightLegWindows(flight.etd, flight.eta, flight.dof);
  const windowForRole = {
    Departure: legWindows.dep,
    Destination: legWindows.arr,
    'Destination alternate': legWindows.alt
  };
  const tafMap = new Map();
  if (stations.length) {
    const placeholders = stations.map(() => '?').join(',');
    const { results } = await context.env.DB.prepare(
      `SELECT station, raw_text, issue_time FROM tafs WHERE station IN (${placeholders}) ORDER BY issue_time DESC`
    ).bind(...stations).all();
    for (const row of results || []) {
      const station = String(row.station || '').trim().toUpperCase();
      if (station && !tafMap.has(station)) tafMap.set(station, row);
    }
  }

  const { results: routeRows } = await context.env.DB.prepare('SELECT * FROM routes').all();
  const { results: latlongRows } = await context.env.DB.prepare('SELECT * FROM latlong').all();
  const route = resolveRouteForFlight(flight, { routes: routeRows || [], latlong: latlongRows || [] });
  const { results: warningRows } = await context.env.DB.prepare('SELECT * FROM wx_warnings ORDER BY kind ASC, dtg DESC').all();
  const warnings = (warningRows || []).map(fromWarningRow).filter(Boolean);
  const routeHits = computeRouteHits(warnings, route.coords, DEFAULT_BUFFER_NM);
  const relevantWarnings = warnings.map(warning => ({
    source: warning.source || null,
    kind: warning.kind || null,
    title: warning.title || null,
    fir: warning.fir || null,
    dtg: warning.dtg || null,
    validFrom: warning.validFrom || null,
    validTo: warning.validTo || null,
    sourceUrl: warning.sourceUrl || null,
    fetchedAt: warning.fetchedAt || null,
    impact: (() => {
      const impact = routeHits[String(warning.id)] || { nm: null, hit: false, reason: 'NO ROUTE' };
      return { ...impact, severity: impact.hit ? routeImpactSeverity(impact.nm) : null };
    })()
  }));
  const fetchedAt = warnings.reduce((latest, warning) => warning.fetchedAt && (!latest || warning.fetchedAt > latest) ? warning.fetchedAt : latest, null);
  const ageHours = fetchedAt ? Math.max(0, (Date.now() - new Date(fetchedAt).getTime()) / 3600000) : null;

  return json({
    ok: true,
    data: {
      flightId,
      taf: stationRoles.map(item => {
        const row = tafMap.get(item.station);
        const issueMs = row?.issue_time ? new Date(row.issue_time).getTime() : NaN;
        const validity = row ? parseTafValidity(row.raw_text, issueMs) : null;
        const now = Date.now();
        const status = !row ? 'Missing' : !validity ? 'Unknown' : now >= validity.startMs && now < validity.endMs ? 'Current' : 'Expired';
        const window = windowForRole[item.role];
        const coverage = !window ? 'Not evaluated' : !validity ? 'Unknown' : validityCoversWindow(validity, window[0], window[1]) ? 'Covered' : 'Outside flight window';
        return {
          role: item.role,
          station: item.station,
          raw: row?.raw_text || null,
          issueTime: row?.issue_time || null,
          status,
          coverage,
          validity: validity ? { label: tafValidityLabel(validity), validFrom: new Date(validity.startMs).toISOString(), validTo: new Date(validity.endMs).toISOString() } : null
        };
      }),
      route: { routeId: route.routeId || null, waypoints: route.waypoints, missing: route.missing, hasRoute: route.coords.length >= 2 },
      weatherMonitoring: {
        warnings: relevantWarnings,
        warningCount: relevantWarnings.length,
        affectingCount: relevantWarnings.filter(warning => warning.impact.hit).length,
        fetchedAt,
        ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
        freshness: ageHours === null ? 'Unavailable' : ageHours <= 6 ? 'Fresh' : 'Stale',
        bufferNm: DEFAULT_BUFFER_NM
      }
    }
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  try {
    if (url.searchParams.get('mode') === 'start') return await handleStart(context, url);
    if (url.searchParams.get('mode') === 'exchange') return await handleExchange(context, url);
    if (url.searchParams.get('mode') === 'flight-board') return await handleFlightBoard(context, context.request);
    if (url.searchParams.get('mode') === 'flight-weather') return await handleFlightWeather(context, context.request, url);
    return json({ error: 'Unknown assist mode.' }, 404);
  } catch (error) {
    console.error('[ASSIST] request failed:', error.message);
    return json({ error: 'Dispatch Assist authorization failed.' }, 500);
  }
}

export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  try {
    if (url.searchParams.get('mode') === 'dispatch-assistant') return await handleDispatchAssistant(context, context.request);
    return json({ error: 'Unknown assist mode.' }, 404);
  } catch (error) {
    console.error('[ASSIST] POST request failed:', error.message);
    return json({ error: 'Dispatch Assist request failed.' }, 500);
  }
}

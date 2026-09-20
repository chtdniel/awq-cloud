// Receives the CGO PLAN snapshot pushed by the Apps Script side.
//
// The AirAsia Workspace blocks Apps Script web apps from being deployed as
// "Anyone", so the Worker can never call the script — but outbound UrlFetchApp
// from the script is unrestricted. The direction is therefore reversed: the
// script reads the sheet on a schedule and POSTs the grid here, and the board's
// Sync CGO Data action works from the snapshot this endpoint stores.
//
// This is a server-to-server route: there is no operator session and no Origin
// header. The shared token in X-AWQ-CGO-Token is the whole authentication.

import { CGO_SNAPSHOT_KEY, parseCgoSheet } from '../../shared/cgo.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 60;

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

// The grid arrives from Apps Script as display values. Anything that is not a
// row of scalars is dropped rather than stored, so a malformed push cannot put
// junk in front of the operator later.
function normalizeGrid(values) {
  const rows = [];
  for (const row of values.slice(0, MAX_ROWS)) {
    if (!Array.isArray(row)) continue;
    rows.push(row.slice(0, MAX_COLUMNS).map(cell => (cell === null || cell === undefined ? '' : String(cell))));
  }
  return rows;
}

export async function onRequestPost(context) {
  try {
    const expected = String(context.env.CGO_BRIDGE_TOKEN || '').trim();
    if (!expected) {
      return Response.json({
        ok: false,
        error: 'CGO_BRIDGE_TOKEN is not configured in Cloudflare Pages, so this endpoint cannot authenticate Apps Script.'
      }, { status: 503 });
    }
    const provided = String(context.request.headers.get('X-AWQ-CGO-Token') || '').trim();
    if (!constantTimeEquals(provided, expected)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const raw = await context.request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json({ ok: false, error: `payload too large (${raw.length} bytes, limit ${MAX_BODY_BYTES})` }, { status: 413 });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ ok: false, error: 'body is not JSON' }, { status: 400 });
    }
    if (!body || !Array.isArray(body.values)) {
      return Response.json({ ok: false, error: 'body.values must be the sheet grid' }, { status: 400 });
    }

    const values = normalizeGrid(body.values);
    // Validated here rather than at sync time: a push that cannot be parsed is
    // refused loudly, and the previous good snapshot stays in place instead of
    // being replaced by something the board cannot use.
    const plan = parseCgoSheet(values);
    if (plan.error) {
      return Response.json({ ok: false, error: plan.error }, { status: 422 });
    }

    const receivedAt = new Date().toISOString();
    const snapshot = {
      values,
      sheetName: body.sheetName ? String(body.sheetName).slice(0, 120) : null,
      sheetId: body.sheetId ? String(body.sheetId).slice(0, 120) : null,
      pushedAt: body.pushedAt ? String(body.pushedAt).slice(0, 40) : null,
      receivedAt,
      rowCount: values.length,
      entryCount: plan.entries.length,
      headerRow: plan.headerRow
    };
    await context.env.DB.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(CGO_SNAPSHOT_KEY, JSON.stringify(snapshot)).run();

    console.log(`[CGO] snapshot received: ${snapshot.rowCount} rows, ${snapshot.entryCount} usable plan entries from "${snapshot.sheetName || 'unknown sheet'}"`);
    return Response.json({
      ok: true,
      receivedAt,
      sheetName: snapshot.sheetName,
      rowCount: snapshot.rowCount,
      entryCount: snapshot.entryCount,
      headerRow: snapshot.headerRow
    });
  } catch (error) {
    console.error('[CGO] ingest failed:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

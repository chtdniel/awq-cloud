function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

export function previewWaypoints(rawText, orderMode = 'column') {
  if (typeof rawText !== 'string' || !rawText.trim()) invalid('Paste text is empty.');
  if (!['column', 'row'].includes(orderMode)) invalid('Invalid scan order.');
  const pattern = /\b([A-Z0-9]{2,10})\s+([NS])\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s+([EW])\s+(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)(?![\d.])/gi;
  const rows = [], left = [], right = [];
  let skipped = 0;
  for (const [index, line] of rawText.replace(/\r/g, '').split('\n').entries()) {
    if (!line.trim()) continue;
    const matches = [...line.matchAll(pattern)];
    if (!matches.length) { skipped++; continue; }
    for (const [column, match] of matches.entries()) {
      const [, name, ns, latDeg, latMin, ew, lonDeg, lonMin] = match;
      if (+latDeg > 90 || +lonDeg > 180 || +latMin >= 60 || +lonMin >= 60 ||
          (+latDeg === 90 && +latMin !== 0) || (+lonDeg === 180 && +lonMin !== 0)) {
        invalid(`Invalid coordinates for ${name.toUpperCase()} on line ${index + 1}.`);
      }
      const waypoint = name.toUpperCase();
      const latStr = `${ns.toUpperCase()} ${latDeg.padStart(2, '0')} ${latMin}`;
      const lonStr = `${ew.toUpperCase()} ${lonDeg.padStart(3, '0')} ${lonMin}`;
      const entry = { waypoint, latStr, lonStr, display: `${waypoint} ${latStr} ${lonStr}`, sourceLine: index + 1 };
      rows.push(entry);
      (column === 0 ? left : right).push(entry);
    }
  }
  const ordered = orderMode === 'column' ? [...left, ...right] : rows;
  const unique = new Map();
  for (const entry of ordered) if (!unique.has(entry.waypoint)) unique.set(entry.waypoint, entry);
  const entries = [...unique.values()];
  if (!entries.length) invalid('No valid waypoints found. Expected: NAME S DD MM.M E DDD MM.M (e.g. WADD S 08 44.8 E 115 10.2).');
  return { ok: true, entries, count: entries.length, rawCount: rows.length, dedupedCount: entries.length,
    skipped, dupCount: rows.length - entries.length, orderMode, leftCount: left.length, rightCount: right.length };
}

export async function saveWaypoints(DB, payload) {
  if (!payload || typeof payload !== 'object') invalid('No payload.');
  const rawText = payload.rawText || payload.text || '';
  const mode = String(payload.mode || 'replace').toLowerCase();
  const orderMode = String(payload.orderMode || 'column').toLowerCase();
  const routeId = String(payload.routeId || '').trim().toUpperCase();
  if (!routeId) invalid('ROUTE ID required.');
  if (!['replace', 'append', 'merge'].includes(mode)) invalid('Invalid update mode.');
  const parsed = previewWaypoints(rawText, orderMode);
  const { results: existingRows } = mode === 'replace'
    ? { results: [] }
    : await DB.prepare('SELECT route_id, waypoint, latitude, longitude FROM latlong WHERE UPPER(TRIM(route_id)) = ? ORDER BY sequence_order ASC, id ASC')
      .bind(routeId).all();
  const statements = [];
  if (mode === 'replace') statements.push(DB.prepare('DELETE FROM latlong'));
  const existingWaypoints = new Set(existingRows.map(row => String(row.waypoint).trim().toUpperCase()));
  const entries = mode === 'merge'
    ? [
        ...parsed.entries,
        ...existingRows
          .filter(row => !parsed.entries.some(entry => entry.waypoint === String(row.waypoint).trim().toUpperCase()))
          .map(row => ({ waypoint: String(row.waypoint).trim().toUpperCase(), latStr: row.latitude, lonStr: row.longitude }))
      ]
    : parsed.entries;
  if (mode === 'merge') {
    statements.push(DB.prepare('DELETE FROM latlong WHERE UPPER(TRIM(route_id)) = ?').bind(routeId));
  }
  const startOrder = mode === 'append' ? existingRows.length : 0;
  for (const [index, entry] of entries.entries()) {
    statements.push(DB.prepare('INSERT INTO latlong (route_id, waypoint, latitude, longitude, sequence_order) VALUES (?, ?, ?, ?, ?)')
      .bind(routeId, entry.waypoint, entry.latStr, entry.lonStr, startOrder + index + 1));
  }
  // D1 batch rolls back the entire update if any statement fails.
  const results = await DB.batch(statements);
  const inserted = mode === 'merge'
    ? parsed.entries.filter(entry => !existingWaypoints.has(entry.waypoint)).length
    : parsed.count;
  return { ok: true, count: parsed.count, inserted, updated: parsed.count - inserted,
    skipped: parsed.skipped, dupCount: parsed.dupCount, mode, orderMode, routeId };
}

export async function deleteWaypoint(DB, waypoint, rowId) {
  if (!Number.isSafeInteger(rowId) || rowId <= 0 || typeof waypoint !== 'string' || !waypoint.trim()) invalid('Waypoint row ID and name are required. Refresh the waypoint list.');
  const result = await DB.prepare('DELETE FROM latlong WHERE id = ? AND UPPER(TRIM(waypoint)) = ?')
    .bind(rowId, waypoint.trim().toUpperCase()).run();
  return { ok: true, deleted: result.meta.changes };
}

export async function clearWaypoints(DB) {
  const result = await DB.prepare('DELETE FROM latlong').run();
  return { ok: true, cleared: result.meta.changes };
}

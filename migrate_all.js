const fs = require('fs');
const path = require('path');

function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (c === '"') {
            if (inQuotes && next === '"') {
                currentCell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            currentRow.push(currentCell.trim());
            currentCell = '';
        } else if ((c === '\r' || c === '\n') && !inQuotes) {
            if (c === '\r' && next === '\n') i++;
            currentRow.push(currentCell.trim());
            if (currentRow.some(cell => cell.length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentCell = '';
        } else {
            currentCell += c;
        }
    }
    if (currentCell.length > 0 || currentRow.length > 0) {
        currentRow.push(currentCell.trim());
        if (currentRow.some(cell => cell.length > 0)) {
            rows.push(currentRow);
        }
    }
    return rows;
}

function escapeSql(val) {
    if (val === null || val === undefined) return 'NULL';
    const s = String(val).replace(/'/g, "''");
    return `'${s}'`;
}

function parseNotamDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})(\d{2})$/);
    if (m) {
        const [_, mm, dd, yyyy, hh, min] = m;
        return `${yyyy}-${mm}-${dd}T${hh}:${min}:00.000Z`;
    }
    return null;
}

// 1. Process routes.csv
console.log('--- Processing routes.csv ---');
const routesRows = parseCSV(fs.readFileSync(path.join(__dirname, 'routes.csv'), 'utf8'));
const routeSqlStatements = [
    `DROP TABLE IF EXISTS routes;`,
    `CREATE TABLE routes (
    id TEXT PRIMARY KEY,
    dep_airport TEXT NOT NULL,
    arr_airport TEXT NOT NULL,
    dep_rwy TEXT,
    sid TEXT,
    waypoint_seq TEXT,
    star TEXT,
    arr_rwy TEXT,
    route_string TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`
];

for (let i = 1; i < routesRows.length; i++) {
    const r = routesRows[i];
    let id = r[0] || '';
    const dep = r[1] || '';
    const arr = r[2] || '';
    const depRwy = r[3] || '';
    const sid = r[4] || '';
    const wpSeq = r[5] || '';
    const star = r[6] || '';
    const arrRwy = r[7] || '';
    const routeStr = r[8] || '';

    // Fix Row 3 typo: WADDWIII10 with DEP=WIII and ARR=WADD -> WIIIWADD10
    if (id === 'WADDWIII10' && dep === 'WIII' && arr === 'WADD') {
        id = 'WIIIWADD10';
    }

    if (!id || !dep || !arr) continue;

    routeSqlStatements.push(`INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES (${escapeSql(id)}, ${escapeSql(dep)}, ${escapeSql(arr)}, ${escapeSql(depRwy)}, ${escapeSql(sid)}, ${escapeSql(wpSeq)}, ${escapeSql(star)}, ${escapeSql(arrRwy)}, ${escapeSql(routeStr)});`);
}
fs.writeFileSync(path.join(__dirname, 'seed_routes.sql'), routeSqlStatements.join('\n'), 'utf8');
console.log(`Generated seed_routes.sql with ${routeSqlStatements.length - 2} routes.`);

// 2. Process latlong.csv
console.log('--- Processing latlong.csv ---');
const latlongRows = parseCSV(fs.readFileSync(path.join(__dirname, 'latlong.csv'), 'utf8'));
const latlongSqlStatements = [
    `DROP TABLE IF EXISTS latlong;`,
    `CREATE TABLE latlong (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT,
    waypoint TEXT,
    latitude TEXT,
    longitude TEXT
);`,
    `CREATE INDEX IF NOT EXISTS idx_latlong_route ON latlong(route_id);`
];

for (let i = 1; i < latlongRows.length; i++) {
    const r = latlongRows[i];
    const routeId = r[0] || '';
    const wp = r[1] || '';
    const lat = r[2] || '';
    const lon = r[3] || '';

    if (!routeId && !wp) continue;

    latlongSqlStatements.push(`INSERT INTO latlong (route_id, waypoint, latitude, longitude) VALUES (${escapeSql(routeId)}, ${escapeSql(wp)}, ${escapeSql(lat)}, ${escapeSql(lon)});`);
}
fs.writeFileSync(path.join(__dirname, 'seed_latlong.sql'), latlongSqlStatements.join('\n'), 'utf8');
console.log(`Generated seed_latlong.sql with ${latlongSqlStatements.length - 3} waypoints.`);

// 3. Process firs.csv (NOTAMs)
console.log('--- Processing firs.csv (NOTAMs) ---');
const notamRows = parseCSV(fs.readFileSync(path.join(__dirname, 'firs.csv'), 'utf8'));
const notamSqlStatements = [
    `DROP TABLE IF EXISTS notams;`,
    `CREATE TABLE notams (
    id TEXT PRIMARY KEY,
    location TEXT NOT NULL,
    q_code TEXT,
    notam_code TEXT,
    message TEXT NOT NULL,
    valid_from DATETIME,
    valid_to DATETIME,
    risk_level TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`
];

const seenNotamIds = new Set();
let notamCount = 0;

for (let i = 1; i < notamRows.length; i++) {
    const r = notamRows[i];
    const loc = r[0] || '';
    let notamId = r[1] || '';
    const cls = r[2] || '';
    const issueDate = parseNotamDate(r[3]);
    const effDate = parseNotamDate(r[4]) || issueDate;
    const expDate = parseNotamDate(r[5]);
    const message = r[6] || '';

    if (!loc || !message) continue;

    if (!notamId) {
        notamId = `${loc}_NOTAM_${i}`;
    }

    // Extract Q-code if present in the message
    let qCode = '';
    const qMatch = message.match(/Q\)\s*([A-Z]{4}\/[A-Z0-9]{4,5})/i);
    if (qMatch) {
        qCode = qMatch[1];
    }

    // Handle duplicate NOTAM IDs by prefixing location or index if needed
    let uniqueId = notamId;
    if (seenNotamIds.has(uniqueId)) {
        uniqueId = `${loc}_${notamId}`;
        if (seenNotamIds.has(uniqueId)) {
            uniqueId = `${uniqueId}_${i}`;
        }
    }
    seenNotamIds.add(uniqueId);

    notamSqlStatements.push(`INSERT OR REPLACE INTO notams (id, location, q_code, message, valid_from, valid_to) VALUES (${escapeSql(uniqueId)}, ${escapeSql(loc)}, ${escapeSql(qCode)}, ${escapeSql(message)}, ${escapeSql(effDate)}, ${escapeSql(expDate)});`);
    notamCount++;
}

fs.writeFileSync(path.join(__dirname, 'seed_notams.sql'), notamSqlStatements.join('\n'), 'utf8');
console.log(`Generated seed_notams.sql with ${notamCount} NOTAMs.`);

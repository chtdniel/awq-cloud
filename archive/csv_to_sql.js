const fs = require('fs');

function parseCSVLine(line) {
    // Quote-aware split: hormati field "..." agar koma di dalam quote tidak memecah kolom.
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const next = line[i + 1];
        if (c === '"') {
            if (inQuotes && next === '"') { cur += '"'; i++; }
            else { inQuotes = !inQuotes; }
        } else if (c === ',' && !inQuotes) {
            cells.push(cur.trim());
            cur = '';
        } else {
            cur += c;
        }
    }
    cells.push(cur.trim());
    return cells;
}

function escSql(v) {
    return String(v == null ? '' : v).replace(/'/g, "''");
}

function isIcao(s) {
    return /^[A-Z]{4}$/.test(String(s || '').trim().toUpperCase());
}

function isCallsign(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t || /^["'\s]+$/.test(t)) return false;
    return /^[A-Z0-9]{2,10}$/.test(t.toUpperCase());
}

const lines = fs.readFileSync('flights.csv', 'utf8').trim().split(/\r?\n/);
const header = parseCSVLine(lines[0]);
const queries = [];
let skipped = 0;

for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) { skipped++; continue; }
    // Skip continuation fragments from quoted multiline fields (e.g. phantom '"' row)
    if (/^",/.test(raw)) { skipped++; continue; }
    const row = parseCSVLine(raw);
    if (row.length !== header.length) { skipped++; continue; }
    if (row.every(c => !String(c).trim())) { skipped++; continue; }

    const callsign = String(row[header.indexOf('QZ')] || '').trim();
    const dep = String(row[header.indexOf('DEP')] || '').trim().toUpperCase();
    const dest = String(row[header.indexOf('DES')] || '').trim().toUpperCase();
    const ac_type = row[header.indexOf('REG')];
    const alt = row[header.indexOf('ALTN')];
    const dof = row[header.indexOf('DOF')];
    const std = row[header.indexOf('STD')];
    const sta = row[header.indexOf('STA')];

    // Validasi baris: tolak callsign quote-only & DEP/DEST non-ICAO
    // (mencegah baris hantu '"' / '20260908 → WIIF' masuk DB).
    if (!isCallsign(callsign) || !isIcao(dep) || !isIcao(dest)) { skipped++; continue; }
    
    let etd = '';
    let eta = '';
    
    if (dof && dof.length === 8 && std && sta) {
        const yr = dof.substring(0, 4);
        const mo = dof.substring(4, 6);
        const dy = dof.substring(6, 8);
        etd = `${yr}-${mo}-${dy}T${std}:00.000Z`;
        eta = `${yr}-${mo}-${dy}T${sta}:00.000Z`;
    }
    
    queries.push(`INSERT OR IGNORE INTO flights (callsign, dep, dest, ac_type, alt, dof, etd, eta) VALUES ('${escSql(callsign)}', '${escSql(dep)}', '${escSql(dest)}', '${escSql(ac_type)}', '${escSql(alt)}', '${escSql(dof)}', '${escSql(etd)}', '${escSql(eta)}');`);
}

fs.writeFileSync('seed_flights.sql', queries.join('\n'));
console.log(`Generated ${queries.length} queries into seed_flights.sql (skipped ${skipped} invalid rows)`);

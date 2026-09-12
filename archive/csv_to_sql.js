const fs = require('fs');
const lines = fs.readFileSync('flights.csv', 'utf8').trim().split(/\r?\n/);
const header = lines[0].split(',');
const queries = [];

for (let i = 1; i < lines.length; i++) {
    // Skip continuation fragments from quoted multiline fields (e.g. phantom '"' row)
    if (/^",/.test(lines[i]) || /^"/.test(lines[i].split(',')[0])) continue;
    const row = lines[i].split(',');
    if (row.length < 3 || !row[0]) continue;
    
    const callsign = row[header.indexOf('QZ')];
    const dep = row[header.indexOf('DEP')];
    const dest = row[header.indexOf('DES')];
    const ac_type = row[header.indexOf('REG')];
    const alt = row[header.indexOf('ALTN')];
    const dof = row[header.indexOf('DOF')];
    const std = row[header.indexOf('STD')];
    const sta = row[header.indexOf('STA')];
    
    let etd = '';
    let eta = '';
    
    if (dof && dof.length === 8 && std && sta) {
        const yr = dof.substring(0, 4);
        const mo = dof.substring(4, 6);
        const dy = dof.substring(6, 8);
        etd = `${yr}-${mo}-${dy}T${std}:00.000Z`;
        eta = `${yr}-${mo}-${dy}T${sta}:00.000Z`;
    }
    
    queries.push(`INSERT OR IGNORE INTO flights (callsign, dep, dest, ac_type, alt, dof, etd, eta) VALUES ('${callsign}', '${dep}', '${dest}', '${ac_type}', '${alt}', '${dof}', '${etd}', '${eta}');`);
}

fs.writeFileSync('seed_flights.sql', queries.join('\n'));
console.log(`Generated ${queries.length} queries into seed_flights.sql`);

// seed_tafs.js
import fs from 'fs';
import { execSync } from 'child_process';

const stations = [
  'VTSP', 'VVDN', 'VVTS', 'WAAA', 'WADD', 'WADL', 'WARR', 'WATO',
  'WIII', 'WIMM', 'WIPP', 'WMKJ', 'WMKK', 'WMKP', 'WSSS', 'YMML',
  'YPAD', 'YPDN', 'YPKG', 'YPPH', 'YSCB', 'YSSY'
];

async function main() {
  console.log('Fetching live TAFs from NOAA API for', stations.length, 'stations...');
  const url = `https://aviationweather.gov/api/data/taf?ids=${stations.join(',')}&format=raw`;
  const res = await fetch(url);
  const text = await res.text();
  console.log('Received payload length:', text.length);

  const tafMap = {};
  const blocks = text.split(/(?=\bTAF\s)/);
  blocks.forEach(block => {
    const bTrim = block.trim();
    if (!bTrim) return;
    const m = bTrim.match(/^TAF\s+(?:AMD\s+|COR\s+)?([A-Z]{4})/i);
    if (m) {
      tafMap[m[1].toUpperCase()] = bTrim;
    }
  });

  console.log('Parsed TAFs for:', Object.keys(tafMap).join(', '));

  const now = new Date().toISOString();
  let sql = 'DELETE FROM tafs;\n';
  for (const st of stations) {
    const raw = tafMap[st] || `TAF ${st} NIL=`;
    const escRaw = raw.replace(/'/g, "''");
    sql += `INSERT INTO tafs (station, raw_text, issue_time) VALUES ('${st}', '${escRaw}', '${now}');\n`;
  }

  fs.writeFileSync('seed_tafs.sql', sql);
  console.log('Generated seed_tafs.sql');
}

main().catch(console.error);

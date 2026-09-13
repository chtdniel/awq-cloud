// Self-check duParseIcaoDateCode (assert-style, tanpa framework) — jalankan: node tests/test_date_parsing.js
// ponytail: import via temp .mjs copy karena package.json type=commonjs (Workers pakai ES module di deploy).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
fs.copyFileSync(path.join(__dirname, '..', 'functions', 'api', 'notamUtils.js'), path.join(os.tmpdir(), 'notamUtils_test.mjs'));
import(pathToFileURL(path.join(os.tmpdir(), 'notamUtils_test.mjs')).href).then(m => {
  const t = m.duParseIcaoDateCode;
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', msg, a, '!=', b); process.exit(1); } else console.log('PASS', msg); };

  eq(t('2609111430').toISOString(), '2026-09-11T14:30:00.000Z', 'valid date+time');
  eq(t('260911') ? t('260911').toISOString() : null, '2026-09-11T00:00:00.000Z', 'valid date only');
  eq(t('991332'), null, 'month 13 rejected');
  eq(t('260231'), null, '31 Feb rejected (round-trip)');
  eq(t('266500'), null, 'day 65 rejected');
  eq(t('2609112530'), null, 'hour 25 rejected');
  eq(t(null), null, 'null input');
  eq(t(''), null, 'empty input');
  eq(t('2609'), null, 'too short');
  console.log('All duParseIcaoDateCode checks passed.');
});

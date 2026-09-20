// Flight board time display regression tests.
//
// displayTime()/timeToMins() feed the STD/STA inputs, the 24h timeline bars and
// the NOTAM note-overlap check. They are not exported on `window`, so the real
// function sources are extracted from src/Flight_Ui.html and run in a vm — the
// shipped code is what gets exercised, not a re-typed copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** Slice one top-level `function name(...) {...}` out of a source file. */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function not found: ${name}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `no body for ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const html = readFileSync(new URL('../src/Flight_Ui.html', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  extractFunction(html, 'displayTime') + '\n' + extractFunction(html, 'timeToMins')
    + '\nglobalThis.__t = { displayTime, timeToMins };',
  sandbox,
  { filename: 'Flight_Ui.html#time' }
);
const { displayTime, timeToMins } = sandbox.__t;

test('displayTime renders every stored flight-time shape as HH:MM', () => {
  assert.equal(displayTime('2026-09-08T04:00:00.000Z'), '04:00');   // ISO, UTC
  assert.equal(displayTime('2026-09-08T23:30:00.000Z'), '23:30');
  // Separator other than 'T' is still a datetime, not a bare HHMM.
  assert.equal(displayTime('2026-09-08 04:00:00'), '04:00');
  assert.equal(displayTime('2026-09-08 04:00'), '04:00');
  assert.equal(displayTime('04:00'), '04:00');
  assert.equal(displayTime('0400'), '04:00');                        // legacy HHMM
  assert.equal(displayTime('4:00'), '04:00');
  assert.equal(displayTime('20260908040000'), '04:00');              // digits-only datetime
  assert.equal(displayTime('202609080400'), '04:00');
});

test('displayTime output always fits the maxlength=5 STD/STA input', () => {
  // Datetime/time shapes must never overflow the 5-char input. A date-only value
  // is excluded on purpose: it has no clock time, so displayTime passes it through
  // raw (pre-existing behaviour, covered by the fallback test below).
  for (const raw of [
    '2026-09-08T04:00:00.000Z', '2026-09-08 04:00:00', '2026-09-08 04:00',
    '04:00', '0400', '4:00', '20260908040000', '202609080400', '', '   ', 'rubbish'
  ]) {
    const out = displayTime(raw);
    assert.ok(out.length <= 5, `displayTime(${JSON.stringify(raw)}) = ${JSON.stringify(out)} exceeds 5 chars`);
  }
});

test('displayTime keeps its previous fallback for values with no clock time', () => {
  assert.equal(displayTime(''), '00:00');            // preserved quirk
  assert.equal(displayTime('rubbish'), '00:00');     // preserved quirk (digits -> 0000)
  assert.equal(displayTime('2026-09-08'), '2026-09-08'); // date only: returned raw, unchanged
});

test('timeToMins derives minutes inside one day for every stored shape', () => {
  assert.equal(timeToMins('2026-09-08T04:00:00.000Z'), 240);
  assert.equal(timeToMins('2026-09-08 04:00:00'), 240);  // the regression
  assert.equal(timeToMins('0400'), 240);
  assert.equal(timeToMins('00:00'), 0);
  assert.equal(timeToMins('23:59'), 1439);
  assert.equal(timeToMins(''), 0);
  // Values with no readable clock time must not invent minutes: previously a
  // date-only string produced 20*60+26 = 1226 and misplaced the timeline bar.
  assert.equal(timeToMins('rubbish'), 0);
  assert.equal(timeToMins('2026-09-08'), 0);
  for (const raw of ['2026-09-08T04:00:00.000Z', '2026-09-08 04:00:00', '0400', '23:59', 'rubbish', '2026-09-08']) {
    const mins = timeToMins(raw);
    assert.ok(Number.isFinite(mins) && mins >= 0 && mins <= 1439, `timeToMins(${JSON.stringify(raw)}) = ${mins} out of range`);
  }
});

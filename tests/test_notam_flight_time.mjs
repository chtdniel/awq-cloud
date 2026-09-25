import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../functions/api/notamUtils.js', import.meta.url), 'utf8');
const { duParseFlightTime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function extractDisplayFlightTime(source) {
  const marker = 'const displayFlightTime = value => {';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'displayFlightTime not found');
  const end = source.indexOf('\n      };', start);
  assert.notEqual(end, -1, 'displayFlightTime end not found');
  const code = source.slice(start, end + '\n      };'.length);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nglobalThis.displayFlightTime = displayFlightTime;', sandbox, { filename: 'Notam_Ui.html#displayFlightTime' });
  return sandbox.displayFlightTime;
}

test('parses ISO flight timestamps as UTC clock time instead of year digits', () => {
  assert.deepEqual(duParseFlightTime('2026-09-08T03:25:00.000Z'), { h: 3, m: 25 });
  assert.deepEqual(duParseFlightTime('2026-09-08 03:25:00'), { h: 3, m: 25 });
  assert.deepEqual(duParseFlightTime('20260908032500'), { h: 3, m: 25 });
  assert.deepEqual(duParseFlightTime('0245'), { h: 2, m: 45 });
  assert.deepEqual(duParseFlightTime('245'), { h: 2, m: 45 });
});

test('NOTAM banner formats stored datetime clocks instead of year digits', async () => {
  const notamUi = await readFile(new URL('../src/Notam_Ui.html', import.meta.url), 'utf8');
  const displayFlightTime = extractDisplayFlightTime(notamUi);

  assert.equal(displayFlightTime('2026-09-25T08:20:00.000Z'), '0820');
  assert.equal(displayFlightTime('2026-09-25 08:20:00'), '0820');
  assert.equal(displayFlightTime('20260925082000'), '0820');
  assert.equal(displayFlightTime('10:10'), '1010');
  assert.equal(displayFlightTime('245'), '0245');
});

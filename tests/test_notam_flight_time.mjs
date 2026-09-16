import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../functions/api/notamUtils.js', import.meta.url), 'utf8');
const { duParseFlightTime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('parses ISO flight timestamps as UTC clock time instead of year digits', () => {
  assert.deepEqual(duParseFlightTime('2026-09-08T03:25:00.000Z'), { h: 3, m: 25 });
  assert.deepEqual(duParseFlightTime('0245'), { h: 2, m: 45 });
  assert.deepEqual(duParseFlightTime('245'), { h: 2, m: 45 });
});

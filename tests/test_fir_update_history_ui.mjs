import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// LAST UPDATE panel on the FIR UPDATE page (src/Fir_Update_Ui.html).
// The panel renders whatever getNotamUpdateHistory returns, so this covers the UI
// contract only: timestamp, account, action, FIR count, the FIR codes written, the
// recent list, the "history unavailable" fallback, and the refresh after an import.
const source = readFileSync('src/Fir_Update_Ui.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    value: '', textContent: '', innerHTML: '', style: {}, disabled: false, events: {},
    addEventListener(type, handler) { this.events[type] = handler; }
  });
  return elements.get(id);
};

const HISTORY = {
  ok: true,
  latest: {
    AD: null,
    FIR: {
      at: '2026-01-31 21:58:11',
      kind: 'FIR',
      action: 'OVERWRITE',
      user: { name: 'Andi Pratama', email: 'andi@awq.id' },
      rowCount: 743,
      locations: ['WIIF', 'WAAF', 'WSJC'],
      detail: 'TSV (DINS) · replace dataset'
    }
  },
  recent: {
    AD: [],
    FIR: [
      { at: '2026-01-31 21:58:11', action: 'OVERWRITE', user: { name: 'Andi Pratama', email: 'andi@awq.id' }, rowCount: 743, locations: ['WIIF', 'WAAF', 'WSJC'] },
      { at: '2026-01-31 06:02:44', action: 'APPEND', user: { name: 'Budi', email: 'budi@awq.id' }, rowCount: 12, locations: ['WIIF'] }
    ]
  }
};

let historyCalls = 0;
let historyReply = HISTORY;
const changedEvents = [];
const window = { dispatchEvent(event) { changedEvents.push(event.type); } };
const runner = {
  withSuccessHandler(handler) { this.success = handler; return this; },
  withFailureHandler(handler) { this.failure = handler; return this; },
  getNotamUpdateHistory() { historyCalls++; this.success(historyReply); },
  firBulkPreviewNotams() {
    this.success({ ok: true, total: 2, valid: 0, validOverwrite: 2, invalid: 0, duplicates: 0, preview: [] });
  },
  firBulkImportNotams() {
    this.success({ ok: true, appended: 2, skippedDup: 0, skippedInvalid: 0, historyLogged: false });
  }
};

vm.runInNewContext(source, {
  window, document: { getElementById: element, querySelector: () => element('toast') },
  google: { script: { run: runner } }, confirm: () => true,
  CustomEvent: class { constructor(type) { this.type = type; } },
  setTimeout: () => 1, clearTimeout: () => {}, Promise, Array, String, Number, JSON, Date
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

window.initFirUpdateDashboard();
await flush();
assert.equal(historyCalls, 1, 'opening the page loads the history panel');

const body = element('firn-history-body').innerHTML;
assert.match(body, /2026-01-31 21:58:11 UTC/, 'panel shows the update timestamp in UTC');
assert.match(body, /Andi Pratama · andi@awq\.id/, 'panel shows the account behind the update (name + email)');
assert.match(body, /Action: <b>OVERWRITE<\/b>/, 'panel shows the action');
assert.match(body, /3 FIRs · 743 NOTAMs/, 'panel shows the FIR and NOTAM counts');
assert.match(body, /WIIF, WAAF, WSJC/, 'panel lists the FIRs that were written');
assert.match(body, /TSV \(DINS\)/, 'panel shows the paste source');
assert.match(body, /Recent updates \(1\)/, 'panel lists earlier updates of its own dataset only');

// Re-opening the tab must refresh the panel (another operator may have committed).
window.initFirUpdateDashboard();
await flush();
assert.equal(historyCalls, 2, 'every tab switch refreshes the panel');

// A successful import refreshes the panel and warns when the audit row was not stored.
element('firn-bulk-raw').value = 'WIIF NOTAM TEXT';
await element('firn-bulk-preview').events.click();
await flush();
await element('firn-bulk-import').events.click();
await flush();
assert.ok(historyCalls >= 3, 'import refreshes the panel');
assert.match(element('toast').textContent, /update history was not recorded/, 'an unrecorded history row is not silent');
assert.deepEqual(changedEvents, ['occ:firNotamsChanged'], 'the panel must not fire extra board events');

// Pre-migration / failed read: the panel degrades, the page keeps working.
historyReply = { ok: false, latest: { AD: null, FIR: null }, recent: { AD: [], FIR: [] }, error: 'no such table: notam_update_log' };
window.initFirUpdateDashboard();
await flush();
assert.match(element('firn-history-body').innerHTML, /Update history unavailable/);

console.log('FIR UPDATE last-update panel renders the history contract and degrades safely.');

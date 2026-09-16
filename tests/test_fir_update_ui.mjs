import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/Fir_Update_Ui.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    value: '', textContent: '', innerHTML: '', style: {}, disabled: false, events: {},
    addEventListener(type, handler) { this.events[type] = handler; }
  });
  return elements.get(id);
};
const requests = [];
const changedEvents = [];
const window = { dispatchEvent(event) { changedEvents.push(event.type); } };
const runner = {
  withSuccessHandler(handler) { this.success = handler; return this; },
  withFailureHandler() { return this; },
  firBulkPreviewNotams(raw) {
    requests.push({ method: 'preview', raw });
    this.success({ ok: true, total: 1, valid: 0, validOverwrite: 1, invalid: 0, duplicates: 1, preview: [] });
  },
  firBulkImportNotams(raw, mode) {
    requests.push({ method: 'import', raw, mode });
    this.success({ ok: true, appended: 1, skippedDup: 0, skippedInvalid: 0 });
  }
};
vm.runInNewContext(source, {
  window, document: { getElementById: element, querySelector: () => element('toast') },
  google: { script: { run: runner } }, confirm: () => true,
  CustomEvent: class { constructor(type) { this.type = type; } },
  setTimeout: () => 1, clearTimeout: () => {}
});
window.initFirUpdateDashboard();
const raw = element('firn-bulk-raw');
const preview = element('firn-bulk-preview');
const overwrite = element('firn-bulk-overwrite');
const append = element('firn-bulk-import');
raw.value = 'OLD PREVIEW TEXT';
await preview.events.click();
assert.equal(append.disabled, true);
assert.equal(overwrite.disabled, false, 'overwrite remains available for duplicate NOTAM');
raw.value = 'NEW NOTAM TEXT';
raw.events.input();
assert.equal(overwrite.disabled, true, 'editing invalidates old preview');
overwrite.events.click();
await Promise.resolve();
assert.equal(requests.filter(request => request.method === 'import').length, 0, 'stale preview cannot import old text');
await preview.events.click();
overwrite.events.click();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(requests.at(-1), { method: 'import', raw: 'NEW NOTAM TEXT', mode: 'overwrite' });
assert.deepEqual(changedEvents, ['occ:firNotamsChanged']);
assert.equal(raw.value, '');
assert.equal(overwrite.disabled, true);
assert.equal(append.disabled, true);
console.log('FIR Update UI stale preview, overwrite and refresh event checks passed.');

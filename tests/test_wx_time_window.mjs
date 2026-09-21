// WX page STD/STA + TAF time window regression tests.
//
// Covers three layers:
//   1. shared/wxtime.mjs           — parsing, dof-derived instants, TAF validity,
//      and which TAF change groups apply to a leg window.
//   2. the inline client helpers   — wxHourParts/wxLegWindow/evaluateWeather/
//      wxLegStatus, run in a vm straight out of src/Weather_Warning_Ui.html so the
//      shipped code is what gets exercised (not a copy).
//   3. functions/api/rpc.js        — getActiveFlightDataForWarning must pick the
//      newest TAF per station and report coverage instead of substituting data;
//      analyzeWxWithManual must gate every leg (AI or rule engine) on that coverage
//      and must not share one cache entry across different flight windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';
import {
  parseTimeToken, flightInstant, dayHourNear, parseTafValidity,
  validityCoversWindow, flightLegWindows, hourOf, newestTafRows, issueClockLabel,
  tafValidityLabel, tafActiveBlocks
} from '../shared/wxtime.mjs';

// --- 1. shared/wxtime.mjs ---------------------------------------------------

test('parseTimeToken reads ISO, HH:MM and the legacy digit forms', () => {
  // The regression: an ISO timestamp used to yield the YEAR as the clock time.
  assert.equal(parseTimeToken('2026-09-08T04:00:00.000Z').label, '04:00');
  assert.equal(parseTimeToken('2026-09-08T04:00:00.000Z').utcMs, Date.UTC(2026, 8, 8, 4, 0));
  assert.equal(parseTimeToken('2026-09-08 04:00:00').label, '04:00');
  assert.equal(parseTimeToken('03:25').label, '03:25');
  assert.equal(parseTimeToken('8:05').label, '08:05');
  assert.equal(parseTimeToken('0810').label, '08:10');          // HHMM
  assert.equal(parseTimeToken('080810').label, '08:10');        // DDHHMM
  assert.equal(parseTimeToken('202609080810').label, '08:10');  // YYYYMMDDHHMM
  assert.equal(parseTimeToken('202609080810').utcMs, Date.UTC(2026, 8, 8, 8, 10));
  assert.equal(parseTimeToken(''), null);
  assert.equal(parseTimeToken(null), null);
  assert.equal(parseTimeToken('2026-09-08'), null);   // date only, no clock time
  assert.equal(parseTimeToken('2570'), null);         // impossible clock time
  // A colon-delimited clock time is literal: never shifted by the local timezone.
  assert.equal(parseTimeToken('2026-09-08 23:30:00').label, '23:30');
  assert.equal(hourOf('2026-09-08T23:30:00.000Z'), 23);
});

test('flightInstant takes the DATE from dof and the CLOCK from the time value', () => {
  // Production reality: dof and the date embedded in an ISO etd disagree by 6-17
  // days. dof is the operator-controlled date of flight, so it must win.
  assert.equal(flightInstant('2026-09-08T03:25:00.000Z', '20260917'), Date.UTC(2026, 8, 17, 3, 25));
  assert.equal(flightInstant('2026-08-30T10:00:00.000Z', '20260916'), Date.UTC(2026, 8, 16, 10, 0));
  // Clock-only values still resolve from dof.
  assert.equal(flightInstant('04:00', '20260908'), Date.UTC(2026, 8, 8, 4, 0));
  assert.equal(flightInstant('0400', '20260908'), Date.UTC(2026, 8, 8, 4, 0));
  // No readable dof -> fall back to the embedded date, then to null.
  assert.equal(flightInstant('2026-09-08T04:00:00.000Z', ''), Date.UTC(2026, 8, 8, 4, 0));
  assert.equal(flightInstant('2026-09-08T04:00:00.000Z', 'undefined'), Date.UTC(2026, 8, 8, 4, 0));
  assert.equal(flightInstant('04:00', ''), null);
  assert.equal(flightInstant('04:00', 'not-a-date'), null);
  // An invalid dof day/month must not silently produce a wrong instant.
  assert.equal(flightInstant('04:00', '20261308'), null);
});

test('parseTafValidity anchors TAF day numbers to the month nearest the issue time', () => {
  const issued = Date.UTC(2026, 8, 8, 6, 0);
  const valid = parseTafValidity('TAF WADD 080600Z 0806/0906 12011KT 9999 SCT016', issued);
  assert.equal(valid.startMs, Date.UTC(2026, 8, 8, 6, 0));
  assert.equal(valid.endMs, Date.UTC(2026, 8, 9, 6, 0));
  // Month rollover: issued 30 SEP, valid 3022/0206 -> ends 2 OCT.
  const rollover = parseTafValidity('TAF WIII 301700Z 3018/0206 08010KT CAVOK', Date.UTC(2026, 8, 30, 17, 0));
  assert.equal(rollover.startMs, Date.UTC(2026, 8, 30, 18, 0));
  assert.equal(rollover.endMs, Date.UTC(2026, 9, 2, 6, 0));
  // "24" end hour means end of day and must roll over, not wrap backwards.
  const endOfDay = parseTafValidity('TAF WIII 080600Z 0806/0824 08010KT CAVOK', issued);
  assert.equal(endOfDay.endMs, Date.UTC(2026, 8, 9, 0, 0));
  assert.ok(endOfDay.endMs > endOfDay.startMs);
  // No validity group (NIL) is unreadable, never "covers nothing".
  assert.equal(parseTafValidity('TAF WATO NIL=', issued), null);
  assert.equal(parseTafValidity('No TAF data in database', issued), null);
});

test('validityCoversWindow is null when the validity is unreadable', () => {
  const valid = { startMs: Date.UTC(2026, 8, 8, 6, 0), endMs: Date.UTC(2026, 8, 9, 6, 0) };
  const at = (h, m = 0) => Date.UTC(2026, 8, 8, h, m);
  assert.equal(validityCoversWindow(valid, at(7), at(7)), true);            // inside
  assert.equal(validityCoversWindow(valid, at(6), at(6)), true);            // touching the start
  assert.equal(validityCoversWindow(valid, at(4), at(4)), false);           // before the validity
  assert.equal(validityCoversWindow(valid, at(5), at(7)), true);            // straddling the start
  assert.equal(validityCoversWindow(valid, NaN, NaN), null);                // no flight date
  assert.equal(validityCoversWindow(null, at(7), at(7)), null);             // unreadable TAF
});

test('flightLegWindows builds DEP/ARR/ALT windows and rolls an overnight ARR to the next day', () => {
  const w = flightLegWindows('2026-09-08T04:00:00.000Z', '2026-09-08T07:50:00.000Z', '20260908');
  assert.deepEqual(w.dep, [Date.UTC(2026, 8, 8, 4, 0), Date.UTC(2026, 8, 8, 4, 0)]);
  assert.deepEqual(w.arr, [Date.UTC(2026, 8, 8, 7, 50), Date.UTC(2026, 8, 8, 7, 50)]);
  assert.equal(w.alt[0], Date.UTC(2026, 8, 8, 8, 50));   // STA + 1h
  assert.equal(w.alt[1], Date.UTC(2026, 8, 8, 10, 50));  // STA + 3h
  // Overnight: STD 21:35, STA 03:20 -> arrival is the NEXT day, never before departure.
  const overnight = flightLegWindows('21:35', '03:20', '20260821');
  assert.equal(overnight.stdMs, Date.UTC(2026, 7, 21, 21, 35));
  assert.equal(overnight.staMs, Date.UTC(2026, 7, 22, 3, 20));
  assert.ok(overnight.staMs > overnight.stdMs);
  assert.equal(overnight.alt[0], Date.UTC(2026, 7, 22, 4, 20));
  const noDate = flightLegWindows('0450', '0750', '');
  assert.equal(noDate.dep, null);
  assert.equal(noDate.arr, null);
  assert.equal(noDate.alt, null);
});

test('tafValidityLabel renders an operator-readable coverage period', () => {
  assert.equal(
    tafValidityLabel(parseTafValidity('TAF WADD 201100Z 2012/2118 12010KT 9999', Date.UTC(2026, 8, 20, 12, 6))),
    '20 12:00Z–21 18:00Z'
  );
  assert.equal(tafValidityLabel(null), '');
});

test('dayHourNear resolves the nearest month like tafDate()', () => {
  assert.equal(dayHourNear(2, 6, 0, Date.UTC(2026, 8, 30, 17, 0)), Date.UTC(2026, 9, 2, 6, 0));
  assert.equal(dayHourNear(3, 4, 0, Date.UTC(2026, 8, 1, 1, 0)), Date.UTC(2026, 8, 3, 4, 0));
});

test('newestTafRows keeps the newest issue_time per station regardless of row order', () => {
  const rows = [
    { station: 'wadd', raw_text: 'NEW', issue_time: '2026-09-08T06:00:00.000Z' },
    { station: 'WADD', raw_text: 'OLD', issue_time: '2026-09-07T17:00:00.000Z' },
    { station: 'wato', raw_text: 'ONLY', issue_time: null },
    { station: '', raw_text: 'NO STATION', issue_time: '2026-09-08T06:00:00.000Z' }
  ];
  const picked = newestTafRows(rows);
  assert.deepEqual(picked.map(r => r.raw_text).sort(), ['NEW', 'ONLY']);
  // Reversed input picks the same rows: order must not decide the forecast.
  const reversed = newestTafRows([...rows].reverse());
  assert.deepEqual(reversed.map(r => r.raw_text).sort(), ['NEW', 'ONLY']);
  // Unreadable timestamps rank lowest but still surface when nothing else exists.
  assert.equal(newestTafRows([{ station: 'WIII', raw_text: 'A' }, { station: 'WIII', raw_text: 'B' }])[0].raw_text, 'A');
  assert.deepEqual(newestTafRows(null), []);
  assert.equal(issueClockLabel('2026-09-07T23:00:00.000Z'), '23:00');
  assert.equal(issueClockLabel(null), '---');
});

// The regression this guards: the rules used to scan the WHOLE TAF, so a TEMPO
// group three days out was reported as weather inside the flight window.
test('tafActiveBlocks keeps only the change groups that apply to the leg window', () => {
  const raw = 'TAF WXXX 081700Z 0818/1000 9999 SCT016'
    + ' TEMPO 0902/0905 TSRA BECMG 0819/0821 3000 BR FM090300 20010KT 2000 TSRA';
  const anchor = Date.UTC(2026, 8, 8, 17, 0);   // issue time, not the flight instant
  const at = (d, h, m = 0) => Date.UTC(2026, 8, d, h, m);
  const pick = (start, end) => tafActiveBlocks(raw, { startMs: start, endMs: end, anchorMs: anchor });

  // DEP window 08 SEP 20:00Z (a point): only the BECMG group has begun by then.
  assert.deepEqual(pick(at(8, 20), at(8, 20)), [
    'TAF WXXX 081700Z 0818/1000 9999 SCT016',
    'BECMG 0819/0821 3000 BR'
  ]);
  // ALT window 09 SEP 02:30Z-04:30Z: the TEMPO group overlaps it even though the
  // window starts before the group does, and the FM group has begun inside it.
  assert.deepEqual(pick(at(9, 2, 30), at(9, 4, 30)), [
    'TAF WXXX 081700Z 0818/1000 9999 SCT016',
    'TEMPO 0902/0905 TSRA',
    'BECMG 0819/0821 3000 BR',
    'FM090300 20010KT 2000 TSRA'
  ]);
  // A window outside every group keeps the base forecast only.
  assert.deepEqual(pick(at(8, 10), at(8, 10)), ['TAF WXXX 081700Z 0818/1000 9999 SCT016']);
  // Without an absolute window every block is returned (previous behaviour): the
  // caller gates on coverage, it does not guess.
  assert.equal(tafActiveBlocks(raw, {}).length, 4);
  assert.deepEqual(tafActiveBlocks('', {}), []);
});

// --- 2. Inline client helpers (run from the real source file) ---------------
function loadWxClient() {
  const html = readFileSync(new URL('../src/Weather_Warning_Ui.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/i.test(m[1]) && m[2].trim());
  assert.equal(scripts.length, 1, 'expected exactly one inline script block in the WX page');
  const block = scripts[0][2];
  const exportLine = '\n  globalThis.__wx = { wxPad2, wxParseTime, wxHourParts, wxFlightInstant, wxDayHourNear, wxLegWindow, wxFlightWindows, wxWindowPayload, wxClientWindow, wxHourOverlap, wxCoverageNote, wxWindowLabel, wxLegStatus, getStatusClass, getStatusLabel, evaluateWeather };\n';
  const instrumented = block.replace(/\}\)\(\);\s*$/, exportLine + '})();');
  assert.ok(instrumented.includes('globalThis.__wx'), 'could not instrument the WX script block');

  // Auto-stub anything the module touches at load time; `window` stays a real
  // object so window.wxRules can be null (the legacy classification path).
  const autoStub = (name) => {
    const target = function () {};
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
        return prop in obj ? obj[prop] : autoStub(name + '.' + String(prop));
      },
      set: () => true,
      apply: () => autoStub(name + '()')
    });
  };
  const sandbox = {
    window: { wxRules: null, wxRefs: [], wxTriggerBlock: '' },
    document: autoStub('document'),
    google: autoStub('google'),
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: 'Weather_Warning_Ui.html#inline' });
  assert.ok(sandbox.__wx, 'client helpers were not exported');
  return sandbox.__wx;
}

const wx = loadWxClient();

test('client wxHourParts renders the real clock time for every stored format', () => {
  // Compare primitives: the helpers run inside a vm realm, so whole-object
  // comparison would trip on the foreign Object.prototype.
  const parts = (v) => { const p = wx.wxHourParts(v); return p.hh + '|' + p.label; };
  // The shipped bug: all of these collapsed to "20:26" (the year 2026).
  assert.equal(parts('2026-09-08T04:00:00.000Z'), '04|04:00');
  assert.equal(parts('2026-09-08T07:50:00.000Z'), '07|07:50');
  assert.equal(parts('2026-09-12T05:35:00.000Z'), '05|05:35');
  assert.equal(parts('03:25'), '03|03:25');
  assert.equal(parts('0810'), '08|08:10');
  assert.equal(parts('080810'), '08|08:10');
  assert.equal(parts(''), '|');
  assert.equal(parts(null), '|');
  // Two different flights must never collapse onto the same STD/STA.
  assert.notEqual(parts('2026-09-08T04:00:00.000Z'), parts('2026-09-08T07:50:00.000Z'));
});

test('client wxFlightWindows anchors to dof and rolls overnight arrivals', () => {
  // dof wins over the stale date embedded in the ISO etd/eta.
  const stale = wx.wxFlightWindows({ std: '2026-09-08T04:00:00.000Z', sta: '2026-09-08T07:50:00.000Z', dof: '20260917' });
  assert.equal(stale.std.instant, Date.UTC(2026, 8, 17, 4, 0));
  assert.equal(stale.sta.instant, Date.UTC(2026, 8, 17, 7, 50));
  assert.equal(stale.std.hour, 4);
  assert.equal(stale.alt.hour, 8);
  assert.equal(stale.alt.instant, Date.UTC(2026, 8, 17, 8, 50));
  // Overnight: STA clock earlier than STD clock belongs to the next day.
  const overnight = wx.wxFlightWindows({ std: '21:35', sta: '03:20', dof: '20260821' });
  assert.equal(overnight.std.instant, Date.UTC(2026, 7, 21, 21, 35));
  assert.equal(overnight.sta.instant, Date.UTC(2026, 7, 22, 3, 20));
  assert.ok(overnight.sta.instant > overnight.std.instant);
  // Legacy clock-only value still resolves its date from dof.
  assert.equal(wx.wxLegWindow('04:00', '20260908', 0).instant, Date.UTC(2026, 8, 8, 4, 0));
  // Midnight rollover of the ALT hour stays in 0..23.
  assert.equal(wx.wxLegWindow('2026-09-08T23:30:00.000Z', '20260908', 1).hour, 0);
  // No time at all -> no hour, no instant (never NaN).
  const empty = wx.wxLegWindow('', '', 0);
  assert.equal(empty.hour, null);
  assert.equal(empty.instant, null);
});

test('client wxCoverageNote only speaks up when a readable TAF misses the window', () => {
  const note = wx.wxCoverageNote('OUT', '20 12:00Z–21 18:00Z', 'DEP');
  assert.match(note, /OUTSIDE FLIGHT WINDOW/);
  assert.match(note, /20 12:00Z/);
  // IN / UNKNOWN / MISSING must not add a second, contradictory message: the leg
  // badge already covers "no TAF at all".
  assert.equal(wx.wxCoverageNote('IN', '20 12:00Z–21 18:00Z', 'DEP'), '');
  assert.equal(wx.wxCoverageNote('UNKNOWN', '', 'DEP'), '');
  assert.equal(wx.wxCoverageNote('MISSING', '', 'DEP'), '');
  assert.equal(wx.wxCoverageNote(undefined, undefined, 'DEP'), '');
});

const TAF_TEMPO_NEXT_DAY = 'TAF WXXX 081700Z 0818/1000 9999 SCT016 TEMPO 0902/0905 TS';

test('evaluateWeather only fires a change group when its day matches the flight', () => {
  // Flight on 08 SEP 04:00Z. The TEMPO block is valid on 09 SEP 02-05Z only:
  // matching on hour-of-day alone (the old code) wrongly reported WARNING.
  const onDay8 = wx.evaluateWeather('WXXX', { hour: 4, instant: Date.UTC(2026, 8, 8, 4, 0) }, TAF_TEMPO_NEXT_DAY);
  assert.equal(onDay8, 'CLEAR');
  // Flight on 09 SEP 03:00Z really is inside that window.
  const onDay9 = wx.evaluateWeather('WXXX', { hour: 3, instant: Date.UTC(2026, 8, 9, 3, 0) }, TAF_TEMPO_NEXT_DAY);
  assert.equal(onDay9, 'WARNING');
  // Without an absolute instant the legacy hour-of-day fallback is preserved.
  assert.equal(wx.evaluateWeather('WXXX', 4, TAF_TEMPO_NEXT_DAY), 'WARNING');
});

test('evaluateWeather keeps FM persistence and reports NO_DATA for unusable TAFs', () => {
  const taf = 'TAF WXXX 081700Z 0818/1000 9999 SCT016 FM090300 20010KT 2000 TSRA';
  // Before the FM group: base conditions only.
  assert.equal(wx.evaluateWeather('WXXX', { hour: 20, instant: Date.UTC(2026, 8, 8, 20, 0) }, taf), 'CLEAR');
  // At and after the FM group: the change block applies (2000 m is below minima).
  assert.equal(wx.evaluateWeather('WXXX', { hour: 3, instant: Date.UTC(2026, 8, 9, 3, 0) }, taf), 'DANGER');
  assert.equal(wx.evaluateWeather('WXXX', { hour: 6, instant: Date.UTC(2026, 8, 9, 6, 0) }, taf), 'DANGER');
  assert.equal(wx.evaluateWeather('WXXX', { hour: 4, instant: null }, 'No TAF data in database'), 'NO_DATA');
  assert.equal(wx.evaluateWeather('WXXX', { hour: 4, instant: null }, ''), 'NO_DATA');
  // NIL/CNL are "no forecast", never OPERATIONAL.
  assert.equal(wx.evaluateWeather('WATO', { hour: 4, instant: null }, 'TAF WATO NIL='), 'NO_DATA');
  assert.equal(wx.evaluateWeather('WATO', { hour: 4, instant: null }, 'TAF AMD WATO 081700Z 0818/1000 CNL='), 'NO_DATA');
});

test('client wxWindowLabel carries the flight date into the AI payload', () => {
  const label = wx.wxWindowLabel({ std: '2026-09-08T04:00:00.000Z', sta: '2026-09-08T07:50:00.000Z', dof: '20260908' });
  assert.equal(label, '08SEP DEP 04:00Z · ARR 07:50Z · ALT 08:50Z–10:50Z');
  // Legacy clock-only values still resolve their date from dof.
  assert.match(wx.wxWindowLabel({ std: '04:00', sta: '07:50', dof: '20260908' }), /^08SEP DEP 04:00Z/);
  // No readable time -> placeholder, never NaN.
  assert.ok(!/NaN/.test(wx.wxWindowLabel({ std: '', sta: '', dof: '' })));
});

// The ALT window is STA+1h..STA+3h — a two-hour RANGE. Collapsing it to its start
// instant (the shipped bug) made a TEMPO group that begins inside the window
// invisible, so the alternate read OPERATIONAL while the TAF forecast TSRA there.
test('client ALT window is evaluated as a range, not as its start instant', () => {
  const f = { std: '2026-09-08T05:50:00.000Z', sta: '2026-09-08T07:50:00.000Z', dof: '20260908' };
  const w = wx.wxFlightWindows(f);
  assert.equal(w.alt.instant, Date.UTC(2026, 8, 8, 8, 50));
  assert.equal(w.alt.endInstant, Date.UTC(2026, 8, 8, 10, 50));
  assert.equal(w.alt.hour, 8);
  assert.equal(w.alt.endHour, 10);
  // DEP/ARR stay points: their end is their own instant.
  assert.equal(w.std.endInstant, w.std.instant);
  assert.equal(w.sta.endInstant, w.sta.instant);

  const taf = 'TAF WATO 081700Z 0818/1000 9999 SCT016 TEMPO 0809/0811 TSRA';
  // TEMPO 09:00Z-11:00Z overlaps the 08:50Z-10:50Z window.
  assert.equal(wx.evaluateWeather('WATO', w.alt, taf), 'WARNING');
  // The same group still does not touch the 05:50Z DEP instant.
  assert.equal(wx.evaluateWeather('WATO', w.std, taf), 'CLEAR');
  // Hour-of-day fallback (no absolute instant) overlaps too: 09-11 vs 08-10.
  assert.equal(wx.evaluateWeather('WATO', { hour: 8, endHour: 10, instant: null }, taf), 'WARNING');
});

// An out-of-window TAF used to yield a green OPERATIONAL badge with only a small
// note; the verdict itself came from a forecast for another day.
test('client wxLegStatus refuses a verdict from a TAF outside the flight window', () => {
  const win = { hour: 4, endHour: 4, instant: Date.UTC(2026, 9, 20, 4, 0), endInstant: Date.UTC(2026, 9, 20, 4, 0), anchorMs: Date.UTC(2026, 8, 30, 17, 0) };
  const taf = 'TAF WADD 301700Z 3018/0206 12011KT 9999 SCT016';
  // The raw evaluator still reads the text (drawer keeps showing it)...
  assert.equal(wx.evaluateWeather('WADD', win, taf), 'CLEAR');
  // ...but the verdict shown on the card is "TAF OUT OF WINDOW", not CLEAR.
  assert.equal(wx.wxLegStatus('WADD', 'OUT', win, taf), 'OUT_OF_WINDOW');
  assert.equal(wx.getStatusClass('OUT_OF_WINDOW'), 'status-outofwindow');
  assert.match(wx.getStatusLabel('OUT_OF_WINDOW'), /TAF OUT OF WINDOW/);
  // IN / UNKNOWN / MISSING keep the normal path (fail-closed stays in evaluateWeather).
  assert.equal(wx.wxLegStatus('WADD', 'IN', win, taf), 'CLEAR');
  assert.equal(wx.wxLegStatus('WADD', 'UNKNOWN', win, 'TAF WADD NIL='), 'NO_DATA');
  assert.equal(wx.wxLegStatus('WADD', 'MISSING', win, 'No TAF data in database'), 'NO_DATA');
});

test('client wxWindowPayload prefers server windows and keeps the TAF issue anchor', () => {
  const client = { hour: 8, endHour: 10, instant: Date.UTC(2026, 8, 8, 8, 50), endInstant: Date.UTC(2026, 8, 8, 10, 50) };
  const server = wx.wxWindowPayload([Date.UTC(2026, 8, 8, 8, 50), Date.UTC(2026, 8, 8, 10, 50)], client, Date.UTC(2026, 8, 8, 17, 0));
  assert.deepEqual([...server.window], [Date.UTC(2026, 8, 8, 8, 50), Date.UTC(2026, 8, 8, 10, 50)]);
  assert.equal(server.anchorMs, Date.UTC(2026, 8, 8, 17, 0));
  // Without a server window the client derivation is sent instead.
  const fallback = wx.wxWindowPayload(null, client, null);
  assert.deepEqual([...fallback.window], [client.instant, client.endInstant]);
  assert.equal(fallback.anchorMs, null);
  // No absolute instant at all -> null, never a NaN window.
  assert.equal(wx.wxWindowPayload(null, { hour: 4, endHour: 4, instant: null, endInstant: null }, null).window, null);
  // prepare a client-side window from the payload round trip
  const merged = wx.wxClientWindow(client, server);
  assert.equal(merged.instant, server.window[0]);
  assert.equal(merged.endInstant, server.window[1]);
  assert.equal(merged.anchorMs, server.anchorMs);
});

// --- 3. functions/api/rpc.js: getActiveFlightDataForWarning -----------------

const bundle = await build({
  entryPoints: ['functions/api/rpc.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { onRequestPost } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

function statement(database, sql, parameters = []) {
  return {
    bind(...values) { return statement(database, sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

function createScenario() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT NOT NULL, dep TEXT, dest TEXT,
      ac_type TEXT, etd TEXT, eta TEXT, alt TEXT, taf_dep TEXT, taf_arr TEXT, cgo TEXT,
      enr1 TEXT, enr2 TEXT, enr3 TEXT, atc TEXT, remarks TEXT, dof TEXT, active_route_id TEXT
    );
    CREATE TABLE tafs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, station TEXT, raw_text TEXT, issue_time TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    -- Flight 1: ISO timestamps, DOF 08 SEP.
    INSERT INTO flights (callsign, dep, dest, alt, dof, etd, eta)
      VALUES ('100', 'WADD', 'WATO', '', '20260908', '2026-09-08T04:00:00.000Z', '2026-09-08T07:50:00.000Z');
    -- Flight 2: legacy clock-only values; the date has to come from dof.
    INSERT INTO flights (callsign, dep, dest, alt, dof, etd, eta)
      VALUES ('200', 'WADD', 'WATO', '', '20260908', '04:00', '07:50');
    -- Live TAF covering the 08 SEP window (valid 0800/0906), inserted FIRST.
    INSERT INTO tafs (station, raw_text, issue_time) VALUES
      ('WADD', 'TAF WADD 072300Z 0800/0906 12011KT 9999 SCT016', '2026-09-07T23:00:00.000Z');
    -- Older row inserted LAST: "last row wins" (the old rule) would return this one.
    INSERT INTO tafs (station, raw_text, issue_time) VALUES
      ('WADD', 'TAF WADD 071700Z 0718/0812 12011KT 9999 SCT016', '2026-09-07T17:00:00.000Z');
    -- TAF issued for a later day: its validity cannot cover an 08 SEP flight.
    INSERT INTO tafs (station, raw_text, issue_time) VALUES
      ('WATO', 'TAF WATO 101700Z 1018/1200 12011KT 9999 SCT016', '2026-09-10T17:00:00.000Z');
  `);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) {
      for (const prepared of statements) await prepared.run();
    }
  };
  return { database, DB };
}

async function warningPayload() {
  const { database, DB } = createScenario();
  const authHeaders = await seedAuthUser(database, DB, 'registered');
  const response = await onRequestPost({
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ method: 'getActiveFlightDataForWarning', args: [] })
    }),
    env: { DB }
  });
  const body = await response.json();
  database.close();
  return { response, flights: JSON.parse(body.data) };
}

test('getActiveFlightDataForWarning picks the newest TAF and reports coverage separately', async () => {
  const { response, flights } = await warningPayload();
  assert.equal(response.status, 200);
  const flight1 = flights.find(f => f.flightNo === '100');
  const flight2 = flights.find(f => f.flightNo === '200');
  assert.ok(flight1 && flight2, 'both seeded flights must be returned');

  // Newest issue_time wins, not the last physical row.
  assert.equal(flight1.tafDep, 'TAF WADD 072300Z 0800/0906 12011KT 9999 SCT016');
  assert.equal(flight1.tafDepTime, '23:00');
  // The WADD TAF covers 08 SEP 00:00Z-09 SEP 06:00Z, so DEP is IN.
  assert.equal(flight1.tafDepCoverage, 'IN');
  assert.equal(flight1.tafDepValid, '08 00:00Z–09 06:00Z');
  // ARR is WATO, whose TAF is for a later day: the forecast is still SHOWN (never
  // blanked), and the mismatch is reported as coverage instead of "no TAF data".
  assert.equal(flight1.tafArr, 'TAF WATO 101700Z 1018/1200 12011KT 9999 SCT016');
  assert.equal(flight1.tafArrCoverage, 'OUT');
  assert.equal(flight1.tafArrValid, '10 18:00Z–12 00:00Z');
  assert.ok(!/No TAF data/.test(flight1.tafArr), 'a present TAF must never be replaced by a no-data sentinel');
  // dof travels to the client so the browser can date the STD/STA window.
  assert.equal(flight1.dof, '20260908');
  assert.equal(flight1.std, '2026-09-08T04:00:00.000Z');
  // The window RANGES travel too, so the browser never has to re-derive the ALT
  // end from an hour (which wraps across midnight) and the rule engine on the
  // server can judge only the groups that fall inside the window.
  assert.deepEqual(flight1.windowDep, [Date.UTC(2026, 8, 8, 4, 0), Date.UTC(2026, 8, 8, 4, 0)]);
  assert.deepEqual(flight1.windowArr, [Date.UTC(2026, 8, 8, 7, 50), Date.UTC(2026, 8, 8, 7, 50)]);
  assert.deepEqual(flight1.windowAlt, [Date.UTC(2026, 8, 8, 8, 50), Date.UTC(2026, 8, 8, 10, 50)]);
  // TAF validity instants + issue anchor: the browser anchors TAF day numbers to
  // the issue time exactly like parseTafValidity() does on the server.
  assert.equal(flight1.tafDepValidFrom, Date.UTC(2026, 8, 8, 0, 0));
  assert.equal(flight1.tafDepValidTo, Date.UTC(2026, 8, 9, 6, 0));
  assert.equal(flight1.tafDepAnchorMs, Date.UTC(2026, 8, 7, 23, 0));
  assert.equal(flight1.tafArrValidFrom, Date.UTC(2026, 8, 10, 18, 0));
  assert.equal(flight1.tafArrAnchorMs, Date.UTC(2026, 8, 10, 17, 0));
  // Legacy clock-only row resolves the same window through dof.
  assert.equal(flight2.std, '04:00');
  assert.equal(flight2.tafDepCoverage, 'IN');
  assert.equal(flight2.tafDep, 'TAF WADD 072300Z 0800/0906 12011KT 9999 SCT016');
});

test('a flight whose dof differs from the date inside etd is anchored to dof', async () => {
  const { database, DB } = createScenario();
  // Same shape as production: etd carries 08 SEP while the operator's DOF is 10 SEP.
  database.prepare("UPDATE flights SET dof = '20260910', etd = '2026-09-08T04:00:00.000Z', eta = '2026-09-08T07:50:00.000Z' WHERE callsign = '100'").run();
  const authHeaders = await seedAuthUser(database, DB, 'registered');
  const response = await onRequestPost({
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ method: 'getActiveFlightDataForWarning', args: [] })
    }),
    env: { DB }
  });
  const flights = JSON.parse((await response.json()).data);
  database.close();
  const flight1 = flights.find(f => f.flightNo === '100');
  // Decisive assertion: the WADD TAF covers 08 SEP 00:00Z-09 SEP 06:00Z, so a 04:00Z
  // departure is IN on the stale embedded date and OUT on the operator's DOF. Only
  // the dof anchor can produce OUT here.
  assert.equal(flight1.tafDepValid, '08 00:00Z–09 06:00Z');
  assert.equal(flight1.tafDepCoverage, 'OUT');
  assert.equal(flight1.tafArrCoverage, 'OUT');
});

test('an unreadable TAF validity keeps the displayed text instead of rejecting it', async () => {
  const { database, DB } = createScenario();
  database.prepare("UPDATE tafs SET raw_text = 'TAF WATO NIL=' WHERE station = 'WATO'").run();
  const authHeaders = await seedAuthUser(database, DB, 'registered');
  const response = await onRequestPost({
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ method: 'getActiveFlightDataForWarning', args: [] })
    }),
    env: { DB }
  });
  const flights = JSON.parse((await response.json()).data);
  database.close();
  const flight1 = flights.find(f => f.flightNo === '100');
  assert.equal(flight1.tafArr, 'TAF WATO NIL=');
});

// --- 4. analyzeWxWithManual: window + coverage gating on every path ---------

const LEG_ANCHOR = Date.UTC(2026, 8, 8, 17, 0);          // issue time of the TAF below
const legWindow = (startMs, endMs) => ({ window: [startMs, endMs], anchorMs: LEG_ANCHOR });
const at = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour, minute);
// A TAF whose only adverse group (TEMPO TSRA) belongs to 10 SEP, not to 08 SEP.
const TAF_OTHER_DAY = 'TAF WXXX 081700Z 0818/1000 9999 SCT016 TEMPO 1002/1005 TSRA';

async function analyzePayload(payload, env) {
  const { database, DB } = createScenario();
  const authHeaders = await seedAuthUser(database, DB, 'registered');
  const response = await onRequestPost({
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ method: 'analyzeWxWithManual', args: [payload] })
    }),
    env: { DB, ...env },
    waitUntil: () => {}
  });
  const body = await response.json();
  database.close();
  return body.data;
}

// Stub Gemini + the Workers Cache API. `respond(prompt, nth)` returns the parsed
// JSON body the fake model "answers"; the prompt is echoed back so a cache hit is
// unmistakable.
function stubGemini(respond) {
  const store = new Map();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? new Response(hit, { headers: { 'Content-Type': 'application/json' } }) : undefined;
      },
      async put(request, response) { store.set(request.url, await response.clone().text()); }
    }
  };
  globalThis.fetch = async (url, init) => {
    fetches += 1;
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    const answer = JSON.stringify(respond(prompt, fetches));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  return {
    store,
    fetchCount: () => fetches,
    restore() {
      delete globalThis.caches;
      globalThis.fetch = originalFetch;
    }
  };
}

test('analyzeWxWithManual rule fallback judges only the groups inside the flight window', async () => {
  const data = await analyzePayload({
    tafDep: TAF_OTHER_DAY, tafArr: TAF_OTHER_DAY, tafAlt: TAF_OTHER_DAY,
    stdH: '20', staH: '20', altH: '20',
    windowLabel: '08SEP DEP 20:00Z · ARR 20:00Z · ALT 21:00Z–23:00Z',
    // DEP/ARR are the point 08 SEP 20:00Z; the TEMPO group is 10 SEP 02:00-05:00Z.
    windows: {
      dep: legWindow(at(8, 20), at(8, 20)),
      arr: legWindow(at(8, 20), at(8, 20)),
      alt: legWindow(at(8, 21), at(8, 23))
    },
    coverage: { dep: 'IN', arr: 'IN', alt: 'IN' }
  }, {});   // no GEMINI_API_KEY -> heuristic rule engine

  assert.equal(data.source, 'heuristic-rules');
  // Without the window the rule engine scanned the whole TAF and answered DANGER
  // "reported during DEP window" for a thunderstorm forecast two days later.
  assert.equal(data.dep.status, 'CLEAR');
  assert.equal(data.arr.status, 'CLEAR');
  assert.equal(data.alt.status, 'CLEAR');
});

test('analyzeWxWithManual coverage OUT overrides whatever the forecast text says', async () => {
  const data = await analyzePayload({
    tafDep: TAF_OTHER_DAY, tafArr: TAF_OTHER_DAY, tafAlt: TAF_OTHER_DAY,
    stdH: '04', staH: '07', altH: '08',
    windows: {
      dep: legWindow(at(20, 4), at(20, 4)),
      arr: legWindow(at(20, 7), at(20, 7)),
      alt: legWindow(at(20, 8), at(20, 10))
    },
    coverage: { dep: 'OUT', arr: 'IN', alt: 'OUT' }
  }, {});

  assert.equal(data.dep.status, 'OUT_OF_WINDOW');
  assert.match(data.dep.reason, /does not cover the DEP flight window/);
  assert.equal(data.alt.status, 'OUT_OF_WINDOW');
  assert.match(data.alt.reason, /does not cover the ALT flight window/);
  // The leg whose validity does cover its window is still judged normally.
  assert.equal(data.arr.status, 'CLEAR');
});

test('analyzeWxWithManual forces OUT_OF_WINDOW even when the AI answers CLEAR', async () => {
  const gemini = stubGemini(() => ({
    dep: { status: 'CLEAR', reason: 'AI says clear', chapter: '', action: '' },
    arr: { status: 'CLEAR', reason: 'AI says clear', chapter: '', action: '' },
    alt: { status: 'CLEAR', reason: 'AI says clear', chapter: '', action: '' }
  }));
  try {
    const data = await analyzePayload({
      tafDep: TAF_OTHER_DAY, tafArr: TAF_OTHER_DAY, tafAlt: TAF_OTHER_DAY,
      stdH: '04', staH: '07', altH: '08',
      windows: {
        dep: legWindow(at(20, 4), at(20, 4)),
        arr: legWindow(at(8, 20), at(8, 20)),
        alt: legWindow(at(8, 21), at(8, 23))
      },
      coverage: { dep: 'OUT', arr: 'IN', alt: 'IN' }
    }, { GEMINI_API_KEY: 'test-key' });

    assert.equal(data.source, 'gemini');
    assert.equal(data.dep.status, 'OUT_OF_WINDOW');
    assert.ok(!/AI says clear/.test(data.dep.reason), 'coverage must replace the AI reason');
    assert.equal(data.arr.status, 'CLEAR');
  } finally {
    gemini.restore();
  }
});

test('analyzeWxWithManual caches per prompt, so windows cannot share a verdict', async () => {
  const gemini = stubGemini((prompt, nth) => {
    const window = (prompt.match(/WINDOW UTC[^\n]*/) || [''])[0];
    return {
      dep: { status: 'CLEAR', reason: 'FETCH#' + nth + ' ' + window, chapter: '', action: '' },
      arr: { status: 'CLEAR', reason: 'FETCH#' + nth + ' ' + window, chapter: '', action: '' },
      alt: { status: 'CLEAR', reason: 'FETCH#' + nth + ' ' + window, chapter: '', action: '' }
    };
  });
  const base = {
    tafDep: 'TAF WADD 080500Z 0806/0906 12011KT 9999 SCT016',
    tafArr: 'TAF WATO 080500Z 0806/0906 12011KT 9999 SCT016',
    tafAlt: 'TAF WIII 080500Z 0806/0906 12011KT 9999 SCT016'
  };
  try {
    const first = await analyzePayload({
      ...base, stdH: '04', staH: '07', altH: '08',
      windowLabel: '08SEP DEP 04:00Z · ARR 07:50Z · ALT 08:50Z–10:50Z',
      windows: {
        dep: legWindow(at(8, 4), at(8, 4)),
        arr: legWindow(at(8, 7, 50), at(8, 7, 50)),
        alt: legWindow(at(8, 8, 50), at(8, 10, 50))
      },
      coverage: { dep: 'IN', arr: 'IN', alt: 'IN' }
    }, { GEMINI_API_KEY: 'test-key' });
    const second = await analyzePayload({
      ...base, stdH: '19', staH: '22', altH: '23',
      windowLabel: '08SEP DEP 19:00Z · ARR 22:50Z · ALT 23:50Z–01:50Z',
      windows: {
        dep: legWindow(at(8, 19), at(8, 19)),
        arr: legWindow(at(8, 22, 50), at(8, 22, 50)),
        alt: legWindow(at(8, 23, 50), at(9, 1, 50))
      },
      coverage: { dep: 'IN', arr: 'IN', alt: 'IN' }
    }, { GEMINI_API_KEY: 'test-key' });

    // Two distinct prompts must be two cache entries and two upstream calls. The
    // old key (model + prompt length + the first 120 chars after "TAF ") collided
    // here and served flight B the verdict computed for flight A's window.
    assert.equal(gemini.store.size, 2);
    assert.equal(gemini.fetchCount(), 2);
    assert.notEqual(first.dep.reason, second.dep.reason);
    assert.match(first.dep.reason, /DEP 04:00Z/);
    assert.match(second.dep.reason, /DEP 19:00Z/);

    // The identical request is still served from cache.
    const repeat = await analyzePayload({
      ...base, stdH: '19', staH: '22', altH: '23',
      windowLabel: '08SEP DEP 19:00Z · ARR 22:50Z · ALT 23:50Z–01:50Z',
      windows: {
        dep: legWindow(at(8, 19), at(8, 19)),
        arr: legWindow(at(8, 22, 50), at(8, 22, 50)),
        alt: legWindow(at(8, 23, 50), at(9, 1, 50))
      },
      coverage: { dep: 'IN', arr: 'IN', alt: 'IN' }
    }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(gemini.fetchCount(), 2, 'an identical prompt must not call Gemini again');
    assert.equal(repeat.dep.reason, second.dep.reason);
  } finally {
    gemini.restore();
  }
});

console.log('WX STD/STA + TAF time window regression tests defined.');
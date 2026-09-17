// ============================================================================
// CREW BRIEFING REPORT FORM (EDITABLE) - IAA/OCC/F/001 Rev.03
// ----------------------------------------------------------------------------
// Web rendition of archive/Crew Briefing Report Form.csv, pre-filled from D1.
// Every data cell is editable; SAVE posts to /api/rpc -> saveBriefingForm.
//
// Route: GET /briefing-form?flights=QZ646,QZ647
// NOTE: /briefing (functions/briefing.js) is intentionally left untouched.
// ============================================================================

import { getRequestUser } from './api/auth.js';
import { qrPngDataUri } from '../shared/qr.mjs';

// --- Helpers ----------------------------------------------------------------

// Escape any DB-derived string before it reaches HTML (attribute or text node).
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Serialize data for embedding inside <script>. Escapes "<" so a DB value can
// never close the script tag and inject markup.
function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Signature prefill: "NAME (LIC: FOOL-881234)", or just "NAME" when no LIC.
// Returns '' when there is no usable name (never a half-built "(LIC: )").
export function dxrPrefillFromProfile(row) {
    const name = row && row.full_name ? String(row.full_name).trim() : '';
    if (!name) return '';
    const lic = row && row.lic_no ? String(row.lic_no).trim() : '';
    return lic ? name + ' (LIC: ' + lic + ')' : name;
}

// Normalise a station-ish DB value to an uppercase ICAO token.
function stationCode(value) {
    if (!value) return '';
    const raw = String(value).trim().toUpperCase();
    if (!raw || raw === '-') return '';
    // enr1/2/3 may hold a code plus free text; take the first token.
    return raw.split(/[\s,;\/|]+/)[0] || '';
}

// "2024-12-01 08:30:00" / ISO / DDHHMM / HHMM -> compact HHMM for TAF TIME.
function compactTime(value) {
    if (value === null || value === undefined) return '';
    const s = String(value).trim();
    if (!s) return '';
    const pad = (n) => (String(n).length < 2 ? '0' + n : String(n));
    // A colon-delimited clock time is unambiguous: take the first HH:MM.
    const withColon = s.match(/(\d{1,2}):(\d{2})/);
    if (withColon) return pad(withColon[1]) + ':' + withColon[2];
    const digits = s.replace(/[^0-9]/g, '');
    if (digits.length === 4) return digits.slice(0, 2) + ':' + digits.slice(2);              // HHMM
    if (digits.length === 6) return digits.slice(2, 4) + ':' + digits.slice(4);     // DDHHMM
    if (digits.length >= 8) return digits.slice(8, 10) + ':' + digits.slice(10, 12);  // YYYYMMDDHHMM[SS]
    return s;
}

const MAX_LEGS = 6;
const NIL_TAF = 'NIL TAF DATA IN DATABASE';
const NIL_NOTAM = 'NIL OPERATIONAL NOTAM.';

// --- Route handler ----------------------------------------------------------

export async function onRequest(context) {
    try {
        const url = new URL(context.request.url);
        const flightParam = url.searchParams.get('flights') || '';
        const flightList = flightParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

        // Same contract/messages as functions/briefing.js
        if (flightList.length === 0) {
            return new Response('<h1>Error: No flight callsigns specified.</h1><p>Usage: /briefing-form?flights=QZ646,QZ647</p>', {
                headers: { 'Content-Type': 'text/html' },
                status: 400
            });
        }

        const flightsKey = flightList.join(',');

        // 1. Flights (same lookup pattern as briefing.js)
        const placeholders = flightList.map(() => '?').join(',');
        const { results: flights } = await context.env.DB.prepare(
            `SELECT * FROM flights WHERE callsign IN (${placeholders}) OR id IN (${placeholders})`
        ).bind(...flightList, ...flightList).all();

        if (!flights || flights.length === 0) {
            return new Response('<h1>Error: Specified flights not found in database.</h1>', {
                headers: { 'Content-Type': 'text/html' },
                status: 404
            });
        }

        // Keep requested order so LEG 1..6 matches the ?flights= order.
        const orderedFlights = [];
        flightList.forEach(key => {
            flights.forEach(f => {
                const cs = String(f.callsign || '').trim().toUpperCase();
                const id = String(f.id || '').trim().toUpperCase();
                if ((cs === key || id === key) && !orderedFlights.some(x => x.id === f.id)) {
                    orderedFlights.push(f);
                }
            });
        });
        // Append anything matched but not yet ordered (e.g. matched by id).
        flights.forEach(f => { if (!orderedFlights.some(x => x.id === f.id)) orderedFlights.push(f); });

        const legs = orderedFlights.slice(0, MAX_LEGS);
        const truncated = orderedFlights.length > MAX_LEGS ? orderedFlights.length - MAX_LEGS : 0;

        // 2. TAFs -> map keyed by station (raw text + issue time)
        const { results: tafRows } = await context.env.DB.prepare('SELECT * FROM tafs').all();
        const tafMap = {};
        (tafRows || []).forEach(t => {
            const stn = stationCode(t.station);
            if (!stn) return;
            tafMap[stn] = { raw: t.raw_text || '', issue_time: t.issue_time || '' };
        });

        // 3. Ordered station list, mirroring legacy generateBriefingPackage:
        //    [DEP, ARR, ALT, ENR1, ENR2, ENR3] per flight, de-duplicated.
        const orderedStations = [];
        const enrStations = []; // { slotId, label, station, flight }
        orderedFlights.forEach(f => {
            const callsign = String(f.callsign || '').trim().toUpperCase();
            const candidates = [
                { station: stationCode(f.dep), label: '' },
                { station: stationCode(f.dest), label: '' },
                { station: stationCode(f.alt), label: '' },
                { station: stationCode(f.enr1), label: 'ENR1' },
                { station: stationCode(f.enr2), label: 'ENR2' },
                { station: stationCode(f.enr3), label: 'ENR3' }
            ];
            candidates.forEach(c => {
                if (!c.station) return;
                const existing = orderedStations.find(s => s.station === c.station);
                if (!existing) {
                    orderedStations.push({
                        station: c.station,
                        label: c.label,
                        isEnr: !!c.label,
                        flights: callsign ? [callsign] : []
                    });
                } else {
                    if (callsign && !existing.flights.includes(callsign)) existing.flights.push(callsign);
                    if (c.label && !existing.label) { existing.label = c.label; existing.isEnr = true; }
                }
                if (c.label) {
                    enrStations.push({
                        slotId: c.label + '_' + (callsign || 'FLT'),
                        label: c.label,
                        station: c.station,
                        flight: callsign
                    });
                }
            });
        });

        // 4. NOTAMs for exactly those stations, grouped per station (actual wins)
        const stationCodes = orderedStations.map(s => s.station);
        const notamMap = {};
        if (stationCodes.length > 0) {
            const stnPlaceholders = stationCodes.map(() => '?').join(',');
            const { results: notamRows } = await context.env.DB.prepare(
                `SELECT id, location, message, valid_from, valid_to
                 FROM notams WHERE location IN (${stnPlaceholders})`
            ).bind(...stationCodes).all();

            (notamRows || []).forEach(n => {
                const stn = stationCode(n.location);
                if (!stn) return;
                if (!notamMap[stn]) notamMap[stn] = [];
                const text = String(n.message || '').trim();
                if (text && !notamMap[stn].includes(text)) notamMap[stn].push(text);
            });
        }

        // 5. Restore a previously saved version of this exact form, if any.
        //    briefing_reports may be absent on a fresh DB -> degrade silently.
        let savedFields = {};
        let savedAtUtc = '';
        try {
            const { results: savedRows } = await context.env.DB.prepare(
                'SELECT content_json, updated_at FROM briefing_reports WHERE flights_key = ? ORDER BY id DESC LIMIT 1'
            ).bind(flightsKey).all();
            if (savedRows && savedRows.length > 0) {
                savedAtUtc = savedRows[0].updated_at ? String(savedRows[0].updated_at) : '';
                if (savedRows[0].content_json) {
                    const parsed = JSON.parse(savedRows[0].content_json);
                    if (parsed && parsed.fields && typeof parsed.fields === 'object') {
                        savedFields = parsed.fields;
                    }
                }
            }
        } catch (restoreErr) {
            console.warn('[briefing-form] Could not restore saved form:', restoreErr.message);
        }

        // A saved value wins over the fresh DB default (a saved "" is respected).
        const sv = (key, fallback) => {
            const v = savedFields[key];
            if (typeof v === 'string') return v;
            return (fallback === null || fallback === undefined) ? '' : String(fallback);
        };

        // Prefill the DXR signature from the logged-in user's profile, only as a
        // fallback: `sv` already lets any saved value (including "") win over it.
        // Degrade silently — user_profiles/auth may be absent on a fresh DB.
        let dxrProfilePrefill = '';
        try {
            const requestUser = await getRequestUser(context);
            if (requestUser) {
                const profileRow = await context.env.DB.prepare(
                    'SELECT full_name, lic_no FROM user_profiles WHERE user_id = ? LIMIT 1'
                ).bind(requestUser.id).first();
                dxrProfilePrefill = dxrPrefillFromProfile(profileRow);
            }
        } catch (profileErr) {
            console.warn('[briefing-form] Could not load profile prefill:', profileErr.message);
        }

        const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 16) + 'Z';

        let dxrQrDataUri = '';
        try {
            const dxrForQr = sv('dxrName', dxrProfilePrefill);
            dxrQrDataUri = await qrPngDataUri(
                'AWQ OCC | DXR: ' + dxrForQr + ' | ' + sv('formDate', nowUtc) + ' | REF: ' + flightsKey,
                { scale: 4, border: 2 }
            );
        } catch (qrErr) {
            console.warn('[briefing-form] QR render skipped:', qrErr.message);
        }

        // --- TAF slot model -------------------------------------------------
        // CSV R30-35: left column POD1,POA1,POD2,POA2,POD3,POA3 and right
        // column POD4,POA4,POD5,POA5,POD6,POA6. Slot order below reproduces it.
        const tafSlots = [];
        for (let i = 0; i < MAX_LEGS; i++) {
            const f = legs[i];
            const callsign = f ? String(f.callsign || '').trim().toUpperCase() : '';
            tafSlots.push({
                slotId: 'POD' + (i + 1),
                label: 'POD ' + (i + 1),
                flight: callsign,
                station: f ? stationCode(f.dep) : '',
                time: f ? compactTime(f.etd) : '',
                enr: false
            });
            tafSlots.push({
                slotId: 'POA' + (i + 1),
                label: 'POA ' + (i + 1),
                flight: callsign,
                station: f ? stationCode(f.dest) : '',
                time: f ? compactTime(f.eta) : '',
                enr: false
            });
        }
        // ENR1/2/3 stations appended as extra TAF rows labelled ENR.
        enrStations.forEach(e => {
            const f = orderedFlights.find(x => String(x.callsign || '').trim().toUpperCase() === e.flight);
            tafSlots.push({
                slotId: e.slotId,
                label: e.label,
                flight: e.flight,
                station: e.station,
                time: f ? compactTime(f.etd) : '',
                enr: true
            });
        });

        // Pair into rows: left = slots[r], right = slots[r + MAX_LEGS];
        // leftover ENR slots flow into additional two-up rows.
        const tafRowPairs = [];
        for (let r = 0; r < MAX_LEGS; r++) {
            tafRowPairs.push([tafSlots[r], tafSlots[r + MAX_LEGS] || null]);
        }
        const extraSlots = tafSlots.slice(MAX_LEGS * 2);
        for (let i = 0; i < extraSlots.length; i += 2) {
            tafRowPairs.push([extraSlots[i], extraSlots[i + 1] || null]);
        }

        // --- Renderers ------------------------------------------------------

        const renderTafGroup = (slot) => {
            if (!slot) {
                return '<td class="cell-blank"></td><td class="cell-blank"></td>'
                    + '<td class="cell-blank"></td><td class="cell-blank"></td>';
            }
            const taf = tafMap[slot.station];
            const defaultText = (taf && taf.raw) ? taf.raw : NIL_TAF;
            const defaultTime = slot.time || ((taf && taf.issue_time) ? compactTime(taf.issue_time) : '');
            const slotAttr = escapeHtml(slot.slotId);
            const stnAttr = escapeHtml(slot.station);
            const flightAttr = escapeHtml(slot.flight);
            const shared = 'data-slot="' + slotAttr + '" data-station="' + stnAttr
                + '" data-flight="' + flightAttr + '"' + (slot.enr ? ' data-enr="true"' : '');
            // Forecast textarea is keyed by station (data-field="taf-WIII") while
            // station/time inputs are keyed by slot so the pair stays addressable.
            const textField = 'taf-' + escapeHtml(slot.station || slot.slotId);
            const textSavedKey = 'taf-' + slot.slotId + '-text';

            return '<td class="slot-label' + (slot.enr ? ' enr' : '') + '">'
                + escapeHtml(slot.label)
                + (slot.flight ? '<span class="slot-flight">' + escapeHtml(slot.flight) + '</span>' : '')
                + '</td>'
                + '<td><input type="text" class="editable stn-input" maxlength="8" '
                + 'name="taf-' + slotAttr + '-station" ' + shared
                + ' data-field="taf-' + slotAttr + '-station"'
                + ' value="' + escapeHtml(sv('taf-' + slot.slotId + '-station', slot.station)) + '"></td>'
                + '<td><input type="text" class="editable time-input" maxlength="12" '
                + 'name="taf-' + slotAttr + '-time" ' + shared
                + ' data-field="taf-' + slotAttr + '-time"'
                + ' value="' + escapeHtml(sv('taf-' + slot.slotId + '-time', defaultTime)) + '"></td>'
                + '<td><textarea class="editable taf-text" rows="4" '
                + 'name="' + textField + '" ' + shared
                + ' data-field="' + textField + '" data-taf-slot-key="' + escapeHtml(textSavedKey) + '">'
                + escapeHtml(sv(textSavedKey, defaultText)) + '</textarea></td>';
        };

        const renderFlightRow = (idx) => {
            const f = legs[idx];
            const n = idx + 1;
            const callsign = f ? String(f.callsign || '').trim().toUpperCase() : '';
            const dep = f ? stationCode(f.dep) : '';
            const dest = f ? stationCode(f.dest) : '';
            const alt = f ? stationCode(f.alt) : '';
            const dof = f ? String(f.dof || '') : '';
            const reg = f ? String(f.ac_type || '') : '';
            const etd = f ? compactTime(f.etd) : '';
            const eta = f ? compactTime(f.eta) : '';
            const unused = !f;

            const cell = (field, value, extraClass, maxLen) =>
                '<td><input type="text" class="editable ' + (extraClass || '') + '"'
                + (maxLen ? ' maxlength="' + maxLen + '"' : '')
                + ' name="' + escapeHtml(field) + '" data-leg="' + n + '"'
                + ' data-flight="' + escapeHtml(callsign) + '"'
                + ' data-field="' + escapeHtml(field) + '"'
                + (unused ? ' data-empty-leg="true"' : '')
                + ' value="' + escapeHtml(sv(field, value)) + '"></td>';

            return '<tr class="' + (unused ? 'leg-unused' : '') + '">'
                + '<td class="slot-label">LEG ' + n + '</td>'
                + cell('leg-' + n + '-flightNo', callsign, 'flt-input')
                + cell('leg-' + n + '-dof', dof, 'date-input', 24)
                + cell('leg-' + n + '-reg', reg, 'reg-input', 12)
                + cell('leg-' + n + '-pod', dep, 'stn-input', 8)
                + cell('leg-' + n + '-std', etd, 'time-input', 24)
                + cell('leg-' + n + '-poa', dest, 'stn-input', 8)
                + cell('leg-' + n + '-sta', eta, 'time-input', 24)
                + cell('leg-' + n + '-alt', alt, 'stn-input', 8)
                + cell('leg-' + n + '-ofp', '', 'ofp-input', 40)
                + '</tr>';
        };

        const renderNotamRow = (entry) => {
            const grouped = notamMap[entry.station] || [];
            // Actual NOTAM text wins; otherwise the NIL sentinel (still editable).
            const defaultText = grouped.length > 0 ? grouped.join('\n\n') : NIL_NOTAM;
            const key = 'notam-' + entry.station;
            const tag = (entry.isEnr && entry.label) ? entry.label : entry.station;
            const flightsAttr = escapeHtml((entry.flights || []).join(','));

            return '<tr>'
                + '<td class="stn-cell' + (entry.isEnr ? ' enr' : '') + '">'
                + '<input type="text" class="editable stn-input" maxlength="8"'
                + ' name="' + escapeHtml(key) + '-station"'
                + ' data-station="' + escapeHtml(entry.station) + '"'
                + ' data-flights="' + flightsAttr + '"'
                + (entry.isEnr ? ' data-enr="true" data-enr-label="' + escapeHtml(entry.label) + '"' : '')
                + ' data-field="' + escapeHtml(key) + '-station"'
                + ' value="' + escapeHtml(sv(key + '-station', entry.station)) + '">'
                + '<span class="stn-tag">' + escapeHtml(tag)
                + (entry.isEnr ? ' &middot; ' + escapeHtml(entry.station) : '') + '</span>'
                + '</td>'
                + '<td><textarea class="editable notam-text" rows="5"'
                + ' name="' + escapeHtml(key) + '"'
                + ' data-station="' + escapeHtml(entry.station) + '"'
                + ' data-flights="' + flightsAttr + '"'
                + (entry.isEnr ? ' data-enr="true"' : '')
                + ' data-field="' + escapeHtml(key) + '"'
                + ' data-notam-count="' + grouped.length + '">'
                + escapeHtml(sv(key, defaultText)) + '</textarea></td>'
                + '</tr>';
        };

        const recNoDefault = 'CBR-' + flightList.join('-') + '-'
            + new Date().toISOString().substring(0, 10).replace(/-/g, '');

        // --- HTML -----------------------------------------------------------
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Crew Briefing Report Form - ${escapeHtml(flightList.join('_'))}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="alternate icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <style>
        :root {
            --primary: #0f172a;
            --accent: #dc2626;
            --border: #94a3b8;
            --border-soft: #cbd5e1;
            --bg-muted: #f1f5f9;
        }
        * { box-sizing: border-box; }
        body {
            font-family: 'Courier New', Courier, monospace;
            background: #e2e8f0;
            color: #0f172a;
            margin: 0;
            font-size: 12px;
            line-height: 1.35;
        }
        /* ---- Toolbar (screen only) ---- */
        .toolbar {
            position: sticky;
            top: 0;
            z-index: 1000;
            background: var(--primary);
            padding: 10px 24px;
            display: flex;
            align-items: center;
            gap: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        }
        .toolbar-title {
            color: #cbd5e1;
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }
        .btn {
            background: var(--accent);
            color: #fff;
            border: none;
            padding: 8px 18px;
            font-size: 12px;
            font-weight: bold;
            font-family: inherit;
            cursor: pointer;
            border-radius: 3px;
            letter-spacing: 0.5px;
        }
        .btn:hover { background: #b91c1c; }
        .btn.secondary { background: #334155; }
        .btn.secondary:hover { background: #475569; }
        .btn:disabled { background: #64748b; cursor: progress; }
        #saveStatus {
            margin-left: auto;
            font-size: 11px;
            font-weight: bold;
            color: #cbd5e1;
            text-align: right;
        }
        #saveStatus.success { color: #4ade80; }
        #saveStatus.error { color: #fca5a5; }
        #saveStatus.saving { color: #fcd34d; }
        /* ---- Sheet ---- */
        .sheet {
            max-width: 1180px;
            margin: 24px auto;
            background: #ffffff;
            padding: 28px 32px;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
        }
        .form-head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 16px;
            border-bottom: 2px solid var(--primary);
            padding-bottom: 12px;
        }
        .form-title {
            font-size: 19px;
            font-weight: 900;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            color: var(--primary);
            padding-top: 6px;
        }
        .head-meta { text-align: right; font-size: 11px; }
        .head-meta div { margin-bottom: 5px; white-space: nowrap; }
        .head-meta label { color: #475569; font-weight: bold; }
        .head-input {
            display: inline-block;
            width: 240px;
            text-align: right;
            border-bottom: 1px dashed var(--border-soft);
        }
        .head-input.short { width: 120px; }
        .section-title {
            background: var(--bg-muted);
            border-left: 4px solid var(--primary);
            padding: 6px 10px;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin: 22px 0 10px 0;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        th, td {
            border: 1px solid var(--border);
            padding: 3px 4px;
            text-align: left;
            vertical-align: top;
        }
        th {
            background: var(--bg-muted);
            font-size: 10px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: #334155;
            text-align: center;
        }
        .cell-blank { background: #f8fafc; }
        .slot-label {
            background: var(--bg-muted);
            font-weight: bold;
            font-size: 10px;
            text-transform: uppercase;
            text-align: center;
            vertical-align: middle;
            color: #334155;
        }
        .slot-label.enr { color: var(--accent); }
        .slot-flight {
            display: block;
            font-size: 9px;
            font-weight: normal;
            color: #64748b;
            letter-spacing: 0;
            text-transform: none;
        }
        tr.leg-unused .editable { background: #fafafa; color: #94a3b8; }
        /* ---- Editable cells ---- */
        .editable {
            width: 100%;
            border: none;
            background: transparent;
            font-family: inherit;
            font-size: 12px;
            color: #0f172a;
            padding: 3px 4px;
            margin: 0;
            display: block;
        }
        textarea.editable {
            resize: vertical;
            min-height: 52px;
            line-height: 1.3;
            white-space: pre-wrap;
        }
        .editable:hover { background: #f8fafc; }
        .editable:focus {
            outline: none;
            background: #eff6ff;
            box-shadow: inset 0 0 0 2px #2563eb;
        }
        .stn-input { text-transform: uppercase; font-weight: bold; text-align: center; }
        .time-input { text-align: center; }
        .flt-input { font-weight: bold; text-align: center; }
        .date-input, .reg-input, .ofp-input { text-align: center; }
        .stn-cell { width: 190px; vertical-align: top; background: #fcfcfd; }
        .stn-cell.enr { background: #fef2f2; }
        .stn-tag {
            display: block;
            font-size: 9px;
            color: #64748b;
            text-align: center;
            margin-top: 2px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stn-cell.enr .stn-tag { color: var(--accent); font-weight: bold; }
        .notice {
            background: #fffbeb;
            border: 1px solid #fcd34d;
            color: #92400e;
            padding: 6px 10px;
            font-size: 11px;
            margin-bottom: 10px;
        }
        .restored {
            background: #eff6ff;
            border: 1px solid #93c5fd;
            color: #1e40af;
            padding: 6px 10px;
            font-size: 11px;
            margin-bottom: 10px;
        }
        /* ---- Signatures ---- */
        .signatures {
            display: grid;
            grid-template-columns: 1fr 1fr;
            margin-top: 26px;
            border: 1px solid var(--border);
        }
        .sign-box { padding: 12px 14px 18px 14px; }
        .sign-box + .sign-box { border-left: 1px solid var(--border); }
        .sign-role {
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            text-align: center;
            color: #334155;
            letter-spacing: 0.8px;
        }
        .sign-sub {
            font-size: 10px;
            text-transform: uppercase;
            text-align: center;
            color: #64748b;
            margin-bottom: 34px;
            letter-spacing: 0.5px;
        }
        .sign-line { border-bottom: 1px solid #64748b; margin-top: 6px; }
        .sign-qr { display: block; width: 96px; height: 96px; margin: 8px 0 0 auto; image-rendering: pixelated; }
        /* ---- Footer ---- */
        .form-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 22px;
            padding-top: 10px;
            border-top: 1px solid var(--border-soft);
            font-size: 10px;
            color: #475569;
        }
        .form-footer .doc-ref { font-weight: bold; letter-spacing: 0.6px; color: #334155; }
        /* ---- Print: hide toolbar, plain white dispatch-release look ---- */
        @media print {
            @page { size: A4 portrait; margin: 10mm; }
            body { background: #ffffff; font-size: 11px; }
            .toolbar { display: none !important; }
            .sheet {
                max-width: 100%;
                margin: 0;
                padding: 0;
                box-shadow: none;
                background: #ffffff;
            }
            .notice, .restored { display: none !important; }
            .editable:hover, .editable:focus { background: transparent; box-shadow: none; }
            tr, .signatures, .form-footer { page-break-inside: avoid; }
            th, .slot-label, .section-title, .stn-cell {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
            textarea.editable { min-height: 44px; overflow: hidden; }
        }
    </style>
</head>
<body>
    <div class="toolbar" id="toolbar">
        <span class="toolbar-title">Crew Briefing Report Form &middot; ${escapeHtml(flightList.join(' / '))}</span>
        <button type="button" class="btn" id="saveBtn">SAVE</button>
        <button type="button" class="btn secondary" id="printBtn">PRINT</button>
        <button type="button" class="btn secondary" id="xlsBtn">DOWNLOAD XLS</button>
        <button type="button" class="btn secondary" id="xlsxBtn">DOWNLOAD XLSX</button>
        <span id="saveStatus"></span>
    </div>

    <div class="sheet">
        ${truncated > 0 ? `<div class="notice">NOTE: ${truncated} additional flight(s) beyond the 6-leg form limit are not shown in the flight grid; their stations are still listed under TAF / NOTAM.</div>` : ''}
        ${savedAtUtc ? `<div class="restored">RESTORED: this form was previously saved (${escapeHtml(savedAtUtc)} UTC). Saved entries override the live database values below.</div>` : ''}

        <!-- ===================== HEADER ===================== -->
        <div class="form-head">
            <div class="form-title">Crew Briefing Report Form</div>
            <div class="head-meta">
                <div><label>Rec. No. :</label>
                    <input type="text" class="editable head-input" name="recNo" data-field="recNo"
                        value="${escapeHtml(sv('recNo', recNoDefault))}">
                </div>
                <div><label>Date :</label>
                    <input type="text" class="editable head-input" name="formDate" data-field="formDate"
                        value="${escapeHtml(sv('formDate', nowUtc))}">
                </div>
                <div><label>Page :</label>
                    <input type="text" class="editable head-input short" name="pageOf" data-field="pageOf"
                        value="${escapeHtml(sv('pageOf', '1 of 1'))}">
                </div>
            </div>
        </div>

        <!-- ===================== FLIGHT BLOCK ===================== -->
        <div class="section-title">Flight Details &mdash; up to 6 legs</div>
        <table class="flight-grid">
            <colgroup>
                <col style="width:6%"><col style="width:10%"><col style="width:11%"><col style="width:9%">
                <col style="width:8%"><col style="width:10%"><col style="width:8%"><col style="width:10%">
                <col style="width:8%"><col style="width:20%">
            </colgroup>
            <thead>
                <tr>
                    <th>LEG</th>
                    <th>FLIGHT NO.</th>
                    <th>DATE</th>
                    <th>A/C REG</th>
                    <th>POD</th>
                    <th>STD / ETD</th>
                    <th>POA</th>
                    <th>STA / ETA</th>
                    <th>ALTN</th>
                    <th>OFP REF NO.</th>
                </tr>
            </thead>
            <tbody>
                ${Array.from({ length: MAX_LEGS }, (_, i) => renderFlightRow(i)).join('')}
            </tbody>
        </table>

        <!-- ===================== TAF BLOCK ===================== -->
        <div class="section-title">Terminal Aerodrome Forecasts</div>
        <table class="taf-grid">
            <colgroup>
                <col style="width:7%"><col style="width:8%"><col style="width:7%"><col style="width:28%">
                <col style="width:7%"><col style="width:8%"><col style="width:7%"><col style="width:28%">
            </colgroup>
            <thead>
                <tr>
                    <th colspan="4">STATION IDENTIFIER &middot; TIME &middot; Forecasts</th>
                    <th colspan="4">STATION IDENTIFIER &middot; TIME &middot; Forecasts</th>
                </tr>
            </thead>
            <tbody>
                ${tafRowPairs.map(pair => `<tr>${renderTafGroup(pair[0])}${renderTafGroup(pair[1])}</tr>`).join('')}
            </tbody>
        </table>

        <!-- ===================== NOTAM BLOCK ===================== -->
        <div class="section-title">Significant NOTAM's</div>
        <table class="notam-grid">
            <colgroup><col style="width:22%"><col style="width:78%"></colgroup>
            <thead>
                <tr>
                    <th>STATION IDENTIFIER</th>
                    <th>SIGNIFICANT NOTAM's</th>
                </tr>
            </thead>
            <tbody>
                ${orderedStations.length > 0
                    ? orderedStations.map(entry => renderNotamRow(entry)).join('')
                    : '<tr><td colspan="2" class="cell-blank" style="text-align:center;padding:10px;">NO STATIONS AVAILABLE FOR THE REQUESTED FLIGHTS.</td></tr>'}
            </tbody>
        </table>

        <!-- ===================== SIGNATURE BLOCK ===================== -->
        <div class="signatures">
            <div class="sign-box">
                <div class="sign-role">DXR ON DUTY</div>
                <div class="sign-sub">NAME / SIGN</div>
                <input type="text" class="editable sign-line" name="dxrName" data-field="dxrName"
                    placeholder="Dispatcher name" value="${escapeHtml(sv('dxrName', dxrProfilePrefill))}">
                ${dxrQrDataUri ? `<img class="sign-qr" src="${dxrQrDataUri}" alt="DXR signature QR">` : ''}
            </div>
            <div class="sign-box">
                <div class="sign-role">PIC</div>
                <div class="sign-sub">NAME / SIGN</div>
                <input type="text" class="editable sign-line" name="picName" data-field="picName"
                    placeholder="Pilot in command name" value="${escapeHtml(sv('picName', ''))}">
            </div>
        </div>

        <!-- ===================== FOOTER ===================== -->
        <div class="form-footer">
            <span>Dec 2025</span>
            <span>GENERATED ${escapeHtml(nowUtc)} &middot; ${orderedFlights.length} SECTOR(S) &middot; AWQ-CLOUD FLIGHT OPERATIONS</span>
            <span class="doc-ref">IAA/OCC/F/001 Rev.03</span>
        </div>
    </div>

    <script>
        // Standalone Pages Function page: all persistence goes through fetch().
        var FLIGHTS_PARAM = ${safeJson(flightList.join(','))};
        var FLIGHTS_KEY = ${safeJson(flightsKey)};
        var FLIGHT_CALLSIGNS = ${safeJson(orderedFlights.map(f => String(f.callsign || '').trim().toUpperCase()))};
        var MAX_LEGS = ${MAX_LEGS};
        var RPC_ENDPOINT = '/api/rpc';
        var saving = false;
        var dirty = false;

        function setStatus(text, kind) {
            var el = document.getElementById('saveStatus');
            if (!el) return;
            el.textContent = text;
            el.className = kind || '';
        }

        function fieldValue(el) {
            return (el && typeof el.value === 'string') ? el.value : '';
        }

        function byField(key) {
            return document.querySelector('[data-field="' + key + '"]');
        }

        // Collect every editable cell into a flat map keyed by data-field (so a
        // saved form restores verbatim), plus structured views for consumers.
        function collectForm() {
            var fields = {};
            var nodes = document.querySelectorAll('[data-field]');
            for (var i = 0; i < nodes.length; i++) {
                fields[nodes[i].getAttribute('data-field')] = fieldValue(nodes[i]);
            }

            var legs = [];
            for (var n = 1; n <= MAX_LEGS; n++) {
                legs.push({
                    leg: n,
                    flightNo: fields['leg-' + n + '-flightNo'] || '',
                    date: fields['leg-' + n + '-dof'] || '',
                    reg: fields['leg-' + n + '-reg'] || '',
                    pod: fields['leg-' + n + '-pod'] || '',
                    std: fields['leg-' + n + '-std'] || '',
                    poa: fields['leg-' + n + '-poa'] || '',
                    sta: fields['leg-' + n + '-sta'] || '',
                    alt: fields['leg-' + n + '-alt'] || '',
                    ofpRef: fields['leg-' + n + '-ofp'] || ''
                });
            }

            var tafs = [];
            var tafNodes = document.querySelectorAll('textarea[data-taf-slot-key]');
            for (var t = 0; t < tafNodes.length; t++) {
                var tn = tafNodes[t];
                var slot = tn.getAttribute('data-slot') || '';
                tafs.push({
                    slot: slot,
                    station: tn.getAttribute('data-station') || '',
                    flight: tn.getAttribute('data-flight') || '',
                    enr: tn.getAttribute('data-enr') === 'true',
                    stationEntered: fields['taf-' + slot + '-station'] || '',
                    time: fields['taf-' + slot + '-time'] || '',
                    forecast: fieldValue(tn)
                });
            }

            var notams = [];
            var notamNodes = document.querySelectorAll('textarea.notam-text');
            for (var k = 0; k < notamNodes.length; k++) {
                var nn = notamNodes[k];
                var nKey = nn.getAttribute('data-field') || '';
                notams.push({
                    station: nn.getAttribute('data-station') || '',
                    stationEntered: fields[nKey + '-station'] || '',
                    flights: (nn.getAttribute('data-flights') || '').split(',').filter(Boolean),
                    enr: nn.getAttribute('data-enr') === 'true',
                    text: fieldValue(nn)
                });
            }

            return {
                formType: 'CREW BRIEFING REPORT FORM',
                docRef: 'IAA/OCC/F/001 Rev.03',
                revisionDate: 'Dec 2025',
                recNo: fields['recNo'] || '',
                date: fields['formDate'] || '',
                page: fields['pageOf'] || '1 of 1',
                legs: legs,
                tafs: tafs,
                notams: notams,
                signatures: {
                    dxrName: fields['dxrName'] || '',
                    picName: fields['picName'] || ''
                },
                fields: fields,
                savedAtUtc: new Date().toISOString(),
                sourceUrl: (typeof window !== 'undefined' && window.location) ? window.location.href : ''
            };
        }

        function saveBriefingForm() {
            if (saving) return;
            saving = true;
            var btn = document.getElementById('saveBtn');
            if (btn) btn.disabled = true;
            setStatus('SAVING...', 'saving');

            // rpc.js handleSaveBriefingForm requires flightsKey (string) and
            // payload (object); flights is passed as the raw query string.
            var body = {
                method: 'saveBriefingForm',
                args: [{
                    flightsKey: FLIGHTS_KEY,
                    flights: FLIGHTS_PARAM,
                    payload: collectForm()
                }]
            };

            fetch(RPC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            .then(function (res) {
                return res.text().then(function (text) {
                    var parsed = null;
                    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
                    if (!res.ok) {
                        var serverMsg = parsed && (parsed.error || (parsed.data && parsed.data.message));
                        throw new Error(serverMsg || ('HTTP ' + res.status));
                    }
                    if (!parsed) throw new Error('Unparseable response from server.');
                    if (parsed.error) throw new Error(parsed.error);
                    // The handler reports validation errors as data.status === 'error'.
                    if (parsed.data && parsed.data.status === 'error') {
                        throw new Error(parsed.data.message || 'Rejected by server.');
                    }
                    return parsed;
                });
            })
            .then(function (data) {
                var msg = (data && data.data && data.data.message) ? data.data.message : 'Briefing form saved';
                var stamp = new Date().toISOString().replace('T', ' ').substring(11, 19);
                dirty = false;
                setStatus('SAVED ' + stamp + 'Z - ' + msg, 'success');
            })
            .catch(function (err) {
                setStatus('SAVE FAILED: ' + ((err && err.message) ? err.message : 'unknown error'), 'error');
            })
            .then(function () {
                saving = false;
                if (btn) btn.disabled = false;
            });
        }

        // Export tampilan sekarang ke tabel HTML agar bisa di-download sebagai .xls
        // (koordinasi: fungsi ini membaca dari field DOM — hasil download = tampilan saat ini, bukan data awal).
        function downloadBriefingXls() {
            var form = collectForm();
            var esc2 = function (v) {
                return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            };
            var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" '
                + 'xmlns:x="urn:schemas-microsoft-com:office:excel"><head>'
                + '<meta charset="UTF-8"></head><body>';
            html += '<table border="1">';
            html += '<tr><th colspan="10">Crew Briefing Report Form</th></tr>';
            html += '<tr><td colspan="7">Rec. No.: ' + esc2(form.fields.recNo) + '</td>'
                + '<td colspan="3">Date: ' + esc2(form.fields.formDate) + ' · Page: ' + esc2(form.fields.pageOf) + '</td></tr>';
            html += '<tr><th>LEG</th><th>FLIGHT NO.</th><th>DATE</th><th>A/C REG</th><th>POD</th>'
                + '<th>STD / ETD</th><th>POA</th><th>STA / ETA</th><th>ALTN</th><th>OFP REF NO.</th></tr>';
            for (var i = 0; i < form.legs.length; i++) {
                var lg = form.legs[i];
                html += '<tr><td>' + lg.leg + '</td><td>' + esc2(lg.flightNo) + '</td><td>' + esc2(lg.date)
                    + '</td><td>' + esc2(lg.reg) + '</td><td>' + esc2(lg.pod) + '</td><td>' + esc2(lg.std)
                    + '</td><td>' + esc2(lg.poa) + '</td><td>' + esc2(lg.sta) + '</td><td>' + esc2(lg.alt)
                    + '</td><td>' + esc2(lg.ofpRef) + '</td></tr>';
            }
            html += '<tr><th colspan="5">TAF — STATION / TIME / FORECAST (KIRI)</th>'
                + '<th colspan="5">TAF — STATION / TIME / FORECAST (KANAN)</th></tr>';
            for (var j = 0; j < form.tafs.length; j += 2) {
                var t1 = form.tafs[j], t2 = form.tafs[j + 1];
                html += '<tr>'
                    + '<td colspan="2">' + esc2(t1 ? t1.stationEntered || t1.station : '') + '</td>'
                    + '<td>' + esc2(t1 ? t1.time : '') + '</td>'
                    + '<td colspan="2">' + esc2(t1 ? t1.forecast : '') + '</td>'
                    + '<td colspan="2">' + esc2(t2 ? t2.stationEntered || t2.station : '') + '</td>'
                    + '<td>' + esc2(t2 ? t2.time : '') + '</td>'
                    + '<td colspan="2">' + esc2(t2 ? t2.forecast : '') + '</td></tr>';
            }
            html += '<tr><th colspan="2">STATION</th><th colspan="8">SIGNIFICANT NOTAM\'S</th></tr>';
            for (var k = 0; k < form.notams.length; k++) {
                var nt = form.notams[k];
                html += '<tr><td colspan="2">' + esc2(nt.stationEntered || nt.station) + '</td>'
                    + '<td colspan="8">' + esc2(nt.text) + '</td></tr>';
            }
            html += '<tr><td colspan="5">DXR ON DUTY<br>NAME / SIGN<br>' + esc2(form.signatures.dxrName) + '</td>'
                + '<td colspan="5">PIC<br>NAME / SIGN<br>' + esc2(form.signatures.picName) + '</td></tr>';
            html += '<tr><td colspan="10">IAA/OCC/F/001 Rev.03 · Dec 2025</td></tr>';
            html += '</table></body></html>';
            var blob = new Blob(['\\ufeff', html], { type: 'application/vnd.ms-excel' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'Crew-Briefing-' + (FLIGHTS_KEY || 'report').replace(/[^A-Za-z0-9,-]+/g, '_') + '.xls';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }

        // Download native .xlsx via server-side template editing
        function downloadBriefingXlsx() {
            var form = collectForm();
            
            fetch(RPC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    method: 'generateBriefingXlsx',
                    args: [form]
                })
            })
            .then(function (res) {
                if (!res.ok) {
                    return res.text().then(function (text) {
                        throw new Error(text || ('HTTP ' + res.status));
                    });
                }
                return res.blob();
            })
            .then(function (blob) {
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'Crew-Briefing-' + FLIGHTS_KEY.replace(/[^A-Za-z0-9,-]+/g, '_') + '.xlsx';
                document.body.appendChild(a);
                a.click();
                setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            })
            .catch(function (err) {
                alert('Failed to download XLSX: ' + err.message);
            });
        }

        document.addEventListener('input', function (e) {
            var t = e.target;
            if (t && t.getAttribute && t.getAttribute('data-field')) dirty = true;
        });

        document.addEventListener('DOMContentLoaded', function () {
            var saveBtn = document.getElementById('saveBtn');
            if (saveBtn) saveBtn.addEventListener('click', saveBriefingForm);
            var printBtn = document.getElementById('printBtn');
            if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
            var xlsBtn = document.getElementById('xlsBtn');
            if (xlsBtn) xlsBtn.addEventListener('click', downloadBriefingXls);
            
            var xlsxBtn = document.getElementById('xlsxBtn');
            if (xlsxBtn) xlsxBtn.addEventListener('click', downloadBriefingXlsx);

            // Date auto-fills from the server clock; refresh only if left blank.
            var dateEl = byField('formDate');
            if (dateEl && !fieldValue(dateEl)) {
                dateEl.value = new Date().toISOString().replace('T', ' ').substring(0, 16) + 'Z';
            }

            // Ctrl/Cmd+S saves instead of opening the browser dialog.
            document.addEventListener('keydown', function (e) {
                if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
                    e.preventDefault();
                    saveBriefingForm();
                }
            });
        });

        // Warn before losing unsaved edits.
        window.addEventListener('beforeunload', function (e) {
            var statusEl = document.getElementById('saveStatus');
            var isSaving = statusEl && statusEl.className === 'saving';
            if (dirty || isSaving) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        });

        window.saveBriefingForm = saveBriefingForm;
    </script>
</body>
</html>`;

        return new Response(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            }
        });
    } catch (e) {
        console.error('[briefing-form] Render error:', e);
        return new Response('<h1>Internal Error: ' + escapeHtml(e.message) + '</h1>', {
            headers: { 'Content-Type': 'text/html' },
            status: 500
        });
    }
}

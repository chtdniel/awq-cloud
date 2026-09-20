import { decodeNotamText } from './notamUtils.js';
import { qrEncode, qrPngBytes } from '../../shared/qr.mjs';

// ============================================================================
// BRIEFING XLSX GENERATION - Native .xlsx output using template-edit approach
// ----------------------------------------------------------------------------
// Fills the committed template public/briefing-template.xlsx (sheets CBR,
// WX, NOTAM) with the SAME payload shape as briefing-form.js collectForm().
// Only value cells are touched; merges/styles/images/print setup stay intact.
// NO EXTERNAL DEPENDENCIES - pure JS ZIP handling (inflate via
// DecompressionStream, deflate via CompressionStream, CRC32 table).
//
// Route: POST /api/rpc {method:'generateBriefingXlsx', args:[form]}
//         POST /api/rpc {method:'generateReportXlsx',   args:[{flights, notamAnalysis, noSigMap}]}
//
// Signature QR: only the editable briefing form (generateBriefingXlsx) embeds
// the DXR signature QR. The REPORT page outputs (generateReportXlsx — used by
// DOWNLOAD SHEET (XLSX) and CREATE GOOGLE SHEET) must not carry it.
// ============================================================================

// --- Cell mapping (verified against template CBR sheet cells/styles/merges) --
// Labels sit one row above their value row (labels 7/9/11, TAF labels 28-29,
// NOTAM header 37-38, signatures 46-47). Because merges group columns,
// writing the anchor (top-left) cell carries the whole merged area.

const ANCHORS = {
    recNo: 'Q2', formDate: 'Q3', pageOf: 'Q4',
    dxrName: 'E48', picName: 'O48'
};

// WX / NOTAM sheet layout (verified via openpyxl):
//   Row 1: B1="WX DOM" | D1="WX INTL"  ;  B1="NOTAM DOM" | D1="NOTAM INTL"
//   Data rows 3..17 inclusive (15 rows). Each physical row holds 2 stations:
//     Left:  A=station, B=text (TAF or NOTAM)
//     Right: C=station, D=text
//   Capacity = 15 rows * 2 = 30 entries. Rows 18+ hold summary (left as-is or
//   overwritten with flight list). Row 26 on NOTAM: A26="CREATE BY : " B26=creator.
const WX_NOTAM_START_ROW = 3;
const WX_NOTAM_END_ROW = 17;
const WX_NOTAM_CAPACITY = (WX_NOTAM_END_ROW - WX_NOTAM_START_ROW + 1) * 2; // 30

// --- ZIP handling -----------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function concatBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

function u16(v) { return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]); }
function u32(v) {
    return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
}

function parseLocalEntries(bytes) {
    // Parse via central directory (sizes/offsets authoritative — local headers
    // may use data descriptors with zeroed sizes).
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('EOCD not found — not a ZIP file');
    const count = view.getUint16(eocd + 10, true);
    let cdOff = view.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (view.getUint32(cdOff, true) !== 0x02014b50) throw new Error('central directory corrupt at entry ' + n);
        const method = view.getUint16(cdOff + 10, true);
        const crc = view.getUint32(cdOff + 16, true);
        const compSize = view.getUint32(cdOff + 20, true);
        const uncompSize = view.getUint32(cdOff + 24, true);
        const nameLen = view.getUint16(cdOff + 28, true);
        const extraLen = view.getUint16(cdOff + 30, true);
        const commentLen = view.getUint16(cdOff + 32, true);
        const lhOff = view.getUint32(cdOff + 42, true);
        const nameBytes = bytes.slice(cdOff + 46, cdOff + 46 + nameLen);
        const name = new TextDecoder().decode(nameBytes);
        const lhNameLen = view.getUint16(lhOff + 26, true);
        const lhExtraLen = view.getUint16(lhOff + 28, true);
        const dataOff = lhOff + 30 + lhNameLen + lhExtraLen;
        entries.push({ name, method, crc, compSize, uncompSize, nameBytes, data: bytes.slice(dataOff, dataOff + compSize) });
        cdOff += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}

async function deflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}

function buildZip(files) {
    // files: [{name: Uint8Array, data: Uint8Array(stored)}]
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const f of files) {
        const crc = crc32(f.data);
        const lh = concatBytes([
            u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
            u32(crc), u32(f.data.length), u32(f.data.length),
            u16(f.name.length), u16(0), f.name
        ]);
        localParts.push(lh, f.data);
        centralParts.push(concatBytes([
            u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
            u32(crc), u32(f.data.length), u32(f.data.length),
            u16(f.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), f.name
        ]));
        offset += lh.length + f.data.length;
    }
    const central = concatBytes(centralParts);
    const eocd = concatBytes([
        u32(0x06054b50), u16(0), u16(0),
        u16(files.length), u16(files.length),
        u32(central.length), u32(offset), u16(0)
    ]);
    return concatBytes([...localParts, central, eocd]);
}

// --- XML value editing (inline strings preserve the template's styles) ------

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setInlineCell(sheetXml, ref, value) {
    if (String(value).length > 32767) throw new RangeError('Spreadsheet cell exceeds 32767 characters; split the report into fewer flights or NOTAMs.');
    const start = sheetXml.indexOf('<c r="' + ref + '"');
    if (start === -1) throw new Error('Template cell missing: ' + ref);
    const tagEnd = sheetXml.indexOf('>', start);
    if (tagEnd === -1) return sheetXml;
    if (sheetXml[tagEnd - 1] === '/') {
        // self-closing <c r="X" s="N"/> → expand to inline string
        const openTag = sheetXml.slice(start, tagEnd - 1).replace(/\s+t="[^"]*"/, '');
        return sheetXml.slice(0, start) + openTag + ' t="inlineStr"><is><t>'
            + xmlEscape(value) + '</t></is></c>' + sheetXml.slice(tagEnd + 1);
    }
    const closeTag = '</c>';
    const end = sheetXml.indexOf(closeTag, tagEnd);
    if (end === -1) return sheetXml;
    const openTag = sheetXml.slice(start, tagEnd).replace(/\s+t="[^"]*"/, '') + ' t="inlineStr"';
    return sheetXml.slice(0, start) + openTag + '><is><t>'
        + xmlEscape(value) + '</t></is></c>' + sheetXml.slice(end + closeTag.length);
}

// --- DATE row (report page) -------------------------------------------------
// The report prints TODAY (UTC) into the DATE row (D9) as a real Excel date:
// a numeric serial with the DD-MMM-YYYY format plus a date data-validation, so
// the operator can change it before printing. Google Sheets shows its calendar
// picker for a validated, date-formatted cell; Excel only enforces/annotates it
// (a click-to-pick calendar inside a plain .xlsx is not possible without macros).

const DATE_CELL_REF = 'D9';
const DATE_CELL_FORMAT = 'DD-MMM-YYYY';

function excelUtcDateSerial(date) {
    // Excel serial day number (1900 system, post-1900-03-01) for a UTC calendar day.
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000) + 25569;
}

// Writes a numeric value (no inlineStr) into an existing template cell.
function setNumberCell(sheetXml, ref, value, styleId) {
    const start = sheetXml.indexOf('<c r="' + ref + '"');
    if (start === -1) throw new Error('Template cell missing: ' + ref);
    const tagEnd = sheetXml.indexOf('>', start);
    if (tagEnd === -1) return sheetXml;
    const selfClosing = sheetXml[tagEnd - 1] === '/';
    const attrs = sheetXml.slice(start, selfClosing ? tagEnd - 1 : tagEnd)
        .replace(/\s+t="[^"]*"/, '')
        .replace(/\s+s="[^"]*"/, '');
    const cell = attrs + ' s="' + styleId + '"><v>' + value + '</v></c>';
    if (selfClosing) return sheetXml.slice(0, start) + cell + sheetXml.slice(tagEnd + 1);
    const end = sheetXml.indexOf('</c>', tagEnd);
    if (end === -1) return sheetXml;
    return sheetXml.slice(0, start) + cell + sheetXml.slice(end + '</c>'.length);
}

// Clones the template's own DATE-cell xf onto a new DD-MMM-YYYY number format so
// borders/centering/font survive; returns the new cellXfs index.
function addDateCellStyle(get, templateStyleId) {
    const stylesFile = get('xl/styles.xml');
    if (!stylesFile || stylesFile.text === null) throw new Error('Template styles.xml missing');
    let styles = stylesFile.text;
    const usedIds = [...styles.matchAll(/<numFmt numFmtId="(\d+)"/g)].map(m => Number(m[1]));
    const numFmtId = Math.max(163, ...usedIds) + 1;
    const numFmtTag = '<numFmt numFmtId="' + numFmtId + '" formatCode="' + DATE_CELL_FORMAT + '"/>';
    const numFmtsTag = styles.match(/<numFmts([^>]*)>/);
    if (numFmtsTag) {
        const declared = Number((numFmtsTag[1].match(/count="(\d+)"/) || [])[1] || 0);
        styles = styles.replace(/<numFmts([^>]*)>([\s\S]*?)<\/numFmts>/, (m, attrs, body) =>
            '<numFmts' + attrs.replace(/count="\d+"/, 'count="' + (declared + 1) + '"') + '>' + body + numFmtTag + '</numFmts>');
    } else {
        styles = styles.replace(/(<styleSheet[^>]*>)/, '$1<numFmts count="1">' + numFmtTag + '</numFmts>');
    }
    const cellXfs = styles.match(/<cellXfs([^>]*)>([\s\S]*?)<\/cellXfs>/);
    if (!cellXfs) throw new Error('Template cellXfs missing');
    const xfs = [...cellXfs[2].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(m => m[0]);
    const source = xfs[templateStyleId];
    const styleId = xfs.length;
    const dateXf = source
        ? source.replace(/numFmtId="\d+"/, 'numFmtId="' + numFmtId + '"').replace(/<xf\b/, '<xf applyNumberFormat="1"')
        : '<xf numFmtId="' + numFmtId + '" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>';
    const declaredXfs = Number((cellXfs[1].match(/count="(\d+)"/) || [])[1] || xfs.length);
    styles = styles.replace(cellXfs[0],
        '<cellXfs' + cellXfs[1].replace(/count="\d+"/, 'count="' + (declaredXfs + 1) + '"') + '>' + cellXfs[2] + dateXf + '</cellXfs>');
    stylesFile.text = styles;
    return styleId;
}

// Date rule for the DATE cell: keeps typed input a valid date and gives Google
// Sheets (and Excel) an explicit, annotated edit affordance.
function dateCellValidationXml() {
    return '<dataValidations count="1"><dataValidation type="date" operator="between" allowBlank="1"'
        + ' showInputMessage="1" showErrorMessage="1" errorStyle="stop"'
        + ' errorTitle="Tanggal tidak valid" error="Masukkan tanggal yang valid, contoh 18-SEP-2026."'
        + ' promptTitle="Tanggal briefing" prompt="Ketik atau pilih tanggal (DD-MMM-YYYY)."'
        + ' sqref="' + DATE_CELL_REF + '">'
        + '<formula1>DATE(2000,1,1)</formula1><formula2>DATE(2100,12,31)</formula2>'
        + '</dataValidation></dataValidations>';
}

function findSheetFile(workbookXml, workbookRelsXml, sheetName) {
    const tagRe = new RegExp('<sheet[^>]*name="' + sheetName + '"[^>]*/?>');
    const tag = workbookXml.match(tagRe);
    if (!tag) return null;
    const idm = tag[0].match(/r:id="([^"]+)"/);
    if (!idm) return null;
    const relRe = new RegExp('Id="' + idm[1] + '"[^>]*Target="([^"]+)"');
    const rm = workbookRelsXml.match(relRe);
    if (!rm) return null;
    const target = rm[1];
    return target.startsWith('worksheets/') ? 'xl/' + target : 'xl/worksheets/' + target;
}

function fillBulkSheet(xml, entries, textKey) {
    if (entries.length > WX_NOTAM_CAPACITY) throw new RangeError('Template supports at most 30 ' + textKey + ' entries; split the report.');
    for (let i = 0; i < WX_NOTAM_CAPACITY; i++) {
        const row = WX_NOTAM_START_ROW + Math.floor(i / 2);
        const isLeft = i % 2 === 0;
        const colStn = isLeft ? 'A' : 'C';
        const colTxt = isLeft ? 'B' : 'D';
        const entry = entries[i];
        if (entry) {
            const stn = (entry.stationEntered || entry.station || '').toString().trim().toUpperCase();
            const txt = (entry[textKey] || '').toString();
            xml = setInlineCell(xml, colStn + row, stn);
            xml = setInlineCell(xml, colTxt + row, txt);
        } else {
            xml = setInlineCell(xml, colStn + row, '');
            xml = setInlineCell(xml, colTxt + row, '');
        }
    }
    return xml;
}

function stationCode(v) {
    if (!v) return '';
    const raw = String(v).trim().toUpperCase();
    if (!raw || raw === '-') return '';
    return raw.split(/[\s,;\/|]+/)[0] || '';
}

function compactTime(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    if (!s) return '';
    const pad = (n) => (String(n).length < 2 ? '0' + n : String(n));
    const withColon = s.match(/(\d{1,2}):(\d{2})/);
    if (withColon) return pad(withColon[1]) + ':' + withColon[2];
    const digits = s.replace(/[^0-9]/g, '');
    if (digits.length === 4) return digits.slice(0, 2) + ':' + digits.slice(2);
    if (digits.length === 6) return digits.slice(2, 4) + ':' + digits.slice(4);
    if (digits.length >= 8) return digits.slice(8, 10) + ':' + digits.slice(10, 12);
    return s;
}

function formatReportDate(v) {
    const raw = String(v || '').trim();
    const digits = raw.replace(/[^0-9]/g, '');
    let year = 0;
    let month = 0;
    let day = 0;
    if (/^\d{8}$/.test(digits)) {
        year = Number(digits.slice(0, 4));
        month = Number(digits.slice(4, 6));
        day = Number(digits.slice(6, 8));
    } else {
        const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (match) {
            year = Number(match[1]);
            month = Number(match[2]);
            day = Number(match[3]);
        }
    }
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return raw;
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return String(day).padStart(2, '0') + '-' + months[month - 1] + '-' + year;
}

async function buildFormFromFlights(context, flightInputs, savedNotamAnalysis, noSigStationMap) {
    const flightList = (flightInputs || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
    if (flightList.length === 0) throw new Error('No flights specified');
    const placeholders = flightList.map(() => '?').join(',');
    const { results: flights } = await context.env.DB.prepare(
        `SELECT * FROM flights WHERE callsign IN (${placeholders}) OR id IN (${placeholders})`
    ).bind(...flightList, ...flightList).all();
    if (!flights || flights.length === 0) throw new Error('Flights not found');
    const orderedFlights = [];
    flightList.forEach(key => {
        flights.forEach(f => {
            const cs = String(f.callsign || '').trim().toUpperCase();
            const id = String(f.id || '').trim().toUpperCase();
            if ((cs === key || id === key) && !orderedFlights.some(x => x.id === f.id)) orderedFlights.push(f);
        });
    });
    flights.forEach(f => { if (!orderedFlights.some(x => x.id === f.id)) orderedFlights.push(f); });
    if (flightList.some(key => !orderedFlights.some(flight => String(flight.callsign).toUpperCase() === key || String(flight.id) === key))) throw new RangeError('Some selected flights no longer exist; refresh the flight selection.');
    if (orderedFlights.length > 6) throw new RangeError('Template supports at most 6 flights; split the report.');
    const legs = orderedFlights;
    const { results: tafRows } = await context.env.DB.prepare('SELECT * FROM tafs').all();
    const tafMap = {};
    (tafRows || []).forEach(t => {
        const stn = stationCode(t.station);
        if (!stn) return;
        tafMap[stn] = { raw: t.raw_text || '', issue_time: t.issue_time || '' };
    });
    const orderedStations = [];
    const additionalTafStations = [];
    orderedFlights.forEach(f => {
        const callsign = String(f.callsign || '').trim().toUpperCase();
        const cands = [
            { station: stationCode(f.dep), label: '' },
            { station: stationCode(f.dest), label: '' },
            { station: stationCode(f.alt), label: '' },
            { station: stationCode(f.enr1), label: 'ENR1' },
            { station: stationCode(f.enr2), label: 'ENR2' },
            { station: stationCode(f.enr3), label: 'ENR3' }
        ];
        const alternate = stationCode(f.alt);
        if (alternate) additionalTafStations.push({ label: 'ALTN', station: alternate, flight: callsign });
        cands.forEach(c => {
            if (!c.station) return;
            const existing = orderedStations.find(s => s.station === c.station);
            if (!existing) orderedStations.push({ station: c.station, label: c.label, isEnr: !!c.label, flights: callsign ? [callsign] : [] });
            else {
                if (callsign && !existing.flights.includes(callsign)) existing.flights.push(callsign);
                if (c.label && !existing.label) { existing.label = c.label; existing.isEnr = true; }
            }
            if (c.label) additionalTafStations.push({ slotId: c.label + '_' + (callsign || 'FLT'), label: c.label, station: c.station, flight: callsign });
        });
    });
    const analysis = savedNotamAnalysis && typeof savedNotamAnalysis === 'object' ? savedNotamAnalysis : {};
    const selectedIds = new Set();
    const selectedFlightsById = new Map();
    orderedFlights.forEach(flight => {
        const callsign = String(flight.callsign || '').trim().toUpperCase();
        const keys = [callsign, String(flight.id), ...orderedStations.filter(station => station.flights.includes(callsign)).map(station => station.station)];
        keys.forEach(key => {
            const selected = analysis[key];
            if (!Array.isArray(selected)) return;
            selected.forEach(item => {
                const id = String(typeof item === 'string' ? item : item?.notamNum || item?.id || '').trim();
                if (!id) return;
                selectedIds.add(id);
                if (!selectedFlightsById.has(id)) selectedFlightsById.set(id, new Set());
                selectedFlightsById.get(id).add(callsign);
            });
        });
    });
    const notamMap = {};
    if (selectedIds.size > 0) {
        const ids = [...selectedIds];
        const stnPlaceholders = ids.map(() => '?').join(',');
        const { results: notamRows } = await context.env.DB.prepare(
            `SELECT id, location, message FROM notams WHERE id IN (${stnPlaceholders})`
        ).bind(...ids).all();
        const foundIds = new Set((notamRows || []).map(notam => notam.id));
        if (ids.some(id => !foundIds.has(id))) throw new RangeError('Selected NOTAMs have changed or expired; run NOTAM analysis again before generating the report.');
        (notamRows || []).forEach(n => {
            const stn = stationCode(n.location);
            if (!stn) return;
            if (!orderedStations.some(station => station.station === stn)) orderedStations.push({ station: stn, label: 'FIR', isEnr: true, flights: [...selectedFlightsById.get(n.id)] });
            if (!notamMap[stn]) notamMap[stn] = [];
            const text = String(n.message || '').trim();
            if (text && !notamMap[stn].includes(text)) notamMap[stn].push(text);
        });
    }
    const tafs = [];
    for (let i = 0; i < 6; i++) {
        const f = legs[i];
        const callsign = f ? String(f.callsign || '').trim().toUpperCase() : '';
        const podStn = f ? stationCode(f.dep) : '';
        const poaStn = f ? stationCode(f.dest) : '';
        const podTime = f ? compactTime(f.etd) : '';
        const poaTime = f ? compactTime(f.eta) : '';
        const podRaw = f ? String(f.taf_dep || '').trim() : '';
        const poaRaw = f ? String(f.taf_arr || '').trim() : '';
        const podForecast = podStn ? (podRaw || 'NIL TAF DATA IN FLIGHT BOARD') : '';
        const poaForecast = poaStn ? (poaRaw || 'NIL TAF DATA IN FLIGHT BOARD') : '';
        tafs.push({ slot: 'POD' + (i + 1), station: podStn, stationEntered: podStn, time: podTime || (podStn && tafMap[podStn]?.issue_time ? compactTime(tafMap[podStn].issue_time) : ''), forecast: podForecast, flight: callsign });
        tafs.push({ slot: 'POA' + (i + 1), station: poaStn, stationEntered: poaStn, time: poaTime || (poaStn && tafMap[poaStn]?.issue_time ? compactTime(tafMap[poaStn].issue_time) : ''), forecast: poaForecast, flight: callsign });
    }
    additionalTafStations.forEach(e => {
        if (tafs.some(taf => taf.station === e.station)) return;
        const raw = tafMap[e.station]?.raw || '';
        tafs.push({ slot: e.label, station: e.station, stationEntered: e.station, time: '', forecast: raw || 'NIL TAF DATA IN DATABASE', flight: e.flight });
    });
    const notams = [];
    orderedStations.forEach(entry => {
        const key = entry.station;
        const isNoSig = !!(noSigStationMap && noSigStationMap[key]);
        const grouped = notamMap[key] || [];
        const texts = grouped.length > 0
            ? grouped
            : [isNoSig ? 'NIL SIGNIFICANT NOTAM' : 'NO NOTAM SELECTED'];
        texts.forEach(text => notams.push({ station: entry.station, stationEntered: entry.station, flights: entry.flights, enr: entry.isEnr, text }));
    });
    const flightsKey = flightList.join(',');
    let savedFields = {};
    try {
        const { results: savedRows } = await context.env.DB.prepare(
            'SELECT content_json FROM briefing_reports WHERE flights_key = ? ORDER BY id DESC LIMIT 1'
        ).bind(flightsKey).all();
        if (savedRows && savedRows.length > 0 && savedRows[0].content_json) {
            const parsed = JSON.parse(savedRows[0].content_json);
            if (parsed && parsed.fields) savedFields = parsed.fields;
        }
    } catch {}
    const fields = {
        recNo: '',
        formDate: '',
        pageOf: savedFields.pageOf || '1 of 1',
        dxrName: savedFields.dxrName || '',
        picName: savedFields.picName || ''
    };
    const legsPayload = legs.map((f, idx) => ({
        leg: idx + 1,
        flightNo: String(f.callsign || '').trim().toUpperCase(),
        date: formatReportDate(f.dof),
        reg: String(f.ac_type || ''),
        pod: stationCode(f.dep),
        std: compactTime(f.etd),
        poa: stationCode(f.dest),
        sta: compactTime(f.eta),
        alt: stationCode(f.alt),
        ofpRef: ''
    }));
    while (legsPayload.length < 6) legsPayload.push({ leg: legsPayload.length + 1, flightNo: '', date: '', reg: '', pod: '', std: '', poa: '', sta: '', alt: '', ofpRef: '' });
    return {
        formType: 'CREW BRIEFING REPORT FORM',
        docRef: 'IAA/OCC/F/001 Rev.03',
        recNo: fields.recNo,
        date: fields.formDate,
        page: fields.pageOf,
        legs: legsPayload,
        tafs,
        notams,
        signatures: { dxrName: fields.dxrName, picName: fields.picName },
        fields,
        orderedStations
    };
}

// options.embedSignatureQr: true (default) keeps the DXR signature QR in the CBR
// drawing. The report page passes false: its XLSX (downloaded directly or
// imported into Google Sheets) prints the DXR name only, without a QR.
// options.dateCellToday: true writes TODAY (UTC) into the DATE row as a real,
// changeable date (DD-MMM-YYYY + date validation) instead of the flight-date
// range. Used by the report page; the editable briefing form keeps the range.
async function buildXlsxResponse(context, form, options = {}) {
    const embedSignatureQr = options.embedSignatureQr !== false;
    const dateCellToday = options.dateCellToday === true;
    form = { ...form, notams: (form.notams || []).map(notam => ({ ...notam, text: decodeNotamText(notam?.text) })) };
    if ((form.legs || []).length > 6) throw new RangeError('Template supports at most 6 flights; split the report.');
    if ((form.tafs || []).length > WX_NOTAM_CAPACITY || (form.notams || []).length > WX_NOTAM_CAPACITY) throw new RangeError('Template supports at most 30 weather or NOTAM entries; split the report.');
    const tplUrl = new URL('/briefing-template.xlsx', context.request.url);
    const tplRes = await context.env.ASSETS.fetch(new Request(tplUrl));
    if (!tplRes.ok) throw new Error('briefing-template.xlsx not reachable (' + tplRes.status + ')');
    const tplBytes = new Uint8Array(await tplRes.arrayBuffer());
    const entries = parseLocalEntries(tplBytes);
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const files = [];
    for (const e of entries) {
        const raw = e.method === 8 ? await inflateRaw(e.data) : e.data;
        files.push({ name: e.name, nameBytes: e.nameBytes, text: e.name.endsWith('.xml') || e.name.endsWith('.rels') ? dec.decode(raw) : null, bin: raw });
    }
    const get = (name) => files.find(f => f.name === name);
    const workbookXml = get('xl/workbook.xml').text;
    const workbookRels = get('xl/_rels/workbook.xml.rels').text;
    const cbrFile = findSheetFile(workbookXml, workbookRels, 'CBR');
    if (!cbrFile) throw new Error('CBR sheet not found in template');
    const cbrSheet = get(cbrFile);
    if (!cbrSheet || cbrSheet.text === null) throw new Error(cbrFile + ' missing/unreadable');
    let xml = cbrSheet.text;
    const fields = form.fields || {};
    xml = setInlineCell(xml, ANCHORS.recNo, 'Rec. No.: ' + (fields.recNo || ''));
    xml = setInlineCell(xml, ANCHORS.formDate, 'Date: ' + (fields.formDate || ''));
    xml = setInlineCell(xml, ANCHORS.pageOf, 'Page: ' + (fields.pageOf || '1 of 1'));
    const legs = form.legs || [];
    const distinctLegValues = key => [...new Set(legs.map(leg => key === 'date' ? formatReportDate(leg[key]) : leg[key]).filter(Boolean))].join(' / ');
    xml = setInlineCell(xml, 'D7', distinctLegValues('flightNo'));
    if (dateCellToday) {
        const templateStyleId = Number((xml.match(new RegExp('<c r="' + DATE_CELL_REF + '"[^>]*\\ss="(\\d+)"')) || [])[1]);
        const styleId = addDateCellStyle(get, Number.isFinite(templateStyleId) ? templateStyleId : -1);
        xml = setNumberCell(xml, DATE_CELL_REF, excelUtcDateSerial(new Date()), styleId);
        // dataValidations must sit after mergeCells and before printOptions.
        xml = xml.replace('</mergeCells>', '</mergeCells>' + dateCellValidationXml());
    } else {
        xml = setInlineCell(xml, 'D9', distinctLegValues('date'));
    }
    xml = setInlineCell(xml, 'D11', distinctLegValues('reg'));
    for (let index = 0; index < 6; index++) {
        const leg = legs[index] || {};
        const row = 7 + index * 2;
        xml = setInlineCell(xml, 'H' + row, leg.pod || '');
        // STD dan OFP Ref No tidak perlu diisi sesuai permintaan
        xml = setInlineCell(xml, 'K' + row, leg.poa || '');
        xml = setInlineCell(xml, 'O' + row, leg.alt || '');
        for (const column of ['E', 'F', 'G', 'M', 'O', 'Q']) xml = setInlineCell(xml, column + (30 + index), '');
    }
    (form.tafs || []).forEach((t) => {
        const match = String(t.slot || '').match(/^(POD|POA)\s*([1-6])$/i);
        if (!match) return;
        const legIndex = Number(match[2]) - 1;
        const r = 30 + (legIndex % 3) * 2 + (match[1].toUpperCase() === 'POA' ? 1 : 0);
        const right = legIndex >= 3;
        const stCol = right ? 'M' : 'E';
        const tmCol = right ? 'O' : 'F';
        const txCol = right ? 'Q' : 'G';
        xml = setInlineCell(xml, stCol + r, t.stationEntered || t.station || '');
        xml = setInlineCell(xml, tmCol + r, t.time || '');
        xml = setInlineCell(xml, txCol + r, t.forecast || '');
    });
    const weatherStations = [...new Map((form.tafs || []).filter(taf => taf.stationEntered || taf.station).map(taf => [taf.stationEntered || taf.station, taf])).values()];
    for (let index = 0; index < 7; index++) {
        const taf = weatherStations[index];
        const continuation = index === 6 && weatherStations.length > 7;
        xml = setInlineCell(xml, 'C' + (20 + index), continuation ? 'CONT.' : taf?.stationEntered || taf?.station || '');
        xml = setInlineCell(xml, 'E' + (20 + index), continuation ? 'See WX sheet for all station forecasts.' : taf?.forecast || '');
    }
    const notamGroups = [];
    (form.notams || []).forEach(nt => {
        const station = nt?.stationEntered || nt?.station || '';
        let group = notamGroups[notamGroups.length - 1];
        if (!group || group.station !== station) {
            group = { station, texts: [] };
            notamGroups.push(group);
        }
        group.texts.push(nt?.text || '');
    });
    const cbrNotamRows = [];
    notamGroups.forEach(group => {
        for (let i = 0; i < group.texts.length; i += 2) {
            cbrNotamRows.push({ station: group.station, left: group.texts[i], right: group.texts[i + 1] || '' });
        }
    });
    for (let index = 0; index < 7; index++) {
        const item = cbrNotamRows[index];
        const continuation = index === 6 && cbrNotamRows.length > 7;
        const row = 39 + index;
        xml = setInlineCell(xml, 'C' + row, continuation ? 'CONT.' : item?.station || '');
        xml = setInlineCell(xml, 'E' + row, continuation ? 'See NOTAM sheet for all selected NOTAMs.' : item?.left || '');
        xml = setInlineCell(xml, 'L' + row, continuation ? '' : item?.right || '');
    }
    const sig = form.signatures || {};
    xml = setInlineCell(xml, ANCHORS.dxrName, sig.dxrName || '');
    xml = setInlineCell(xml, ANCHORS.picName, sig.picName || '');
    cbrSheet.text = xml;
    const wxFile = findSheetFile(workbookXml, workbookRels, 'WX');
    if (wxFile) {
        const wxSheet = get(wxFile);
        if (wxSheet && wxSheet.text !== null) {
            let wxXml = wxSheet.text;
            const wxEntries = (form.tafs || []).map(t => ({ station: t.stationEntered || t.station, stationEntered: t.stationEntered || t.station, forecast: t.forecast || '' }));
            if (wxEntries.length === 0 && form.orderedStations) {
                form.orderedStations.forEach(s => wxEntries.push({ station: s.station, stationEntered: s.station, forecast: 'NIL TAF DATA IN DATABASE' }));
            }
            wxXml = fillBulkSheet(wxXml, wxEntries, 'forecast');
            const flightsStr = (form.legs || []).filter(l => l && l.flightNo).map(l => l.flightNo).join(' ');
            wxXml = setInlineCell(wxXml, 'B18', flightsStr);
            wxSheet.text = wxXml;
        }
    }
    const notamFile = findSheetFile(workbookXml, workbookRels, 'NOTAM');
    if (notamFile) {
        const ntSheet = get(notamFile);
        if (ntSheet && ntSheet.text !== null) {
            let ntXml = ntSheet.text;
            const ntEntries = form.notams || [];
            ntXml = fillBulkSheet(ntXml, ntEntries, 'text');
            const flightsStr2 = (form.legs || []).filter(l => l && l.flightNo).map(l => l.flightNo).join(' ');
            ntXml = setInlineCell(ntXml, 'B18', flightsStr2);
            ntXml = setInlineCell(ntXml, 'B26', sig.dxrName || '');
            ntSheet.text = ntXml;
        }
    }
    if (embedSignatureQr) {
        try {
            const qrFlights = (form.legs || []).filter(l => l && l.flightNo).map(l => l.flightNo).join(',');
            const qrDate = (form.fields && form.fields.formDate) || form.date || '';
            const qrText = 'AWQ OCC | DXR: ' + (sig.dxrName || '') + ' | ' + qrDate + ' | REF: ' + qrFlights;
            const qrPng = await qrPngBytes(qrEncode(qrText, { errorCorrectionLevel: 'M' }).modules, { scale: 4, border: 2 });

            const usedNumbers = files.map(file => Number((file.name.match(/^xl\/media\/image(\d+)\.png$/) || [])[1] || 0));
            const qrImageName = 'xl/media/image' + (Math.max(0, ...usedNumbers) + 1) + '.png';

            const cbrRels = get('xl/worksheets/_rels/' + cbrFile.split('/').pop() + '.rels');
            const drawingRel = cbrRels && cbrRels.text ? (cbrRels.text.match(/Target="([^"]*drawings\/[^"]+)"/) || [])[1] : null;
            if (drawingRel) {
                const drawingPath = 'xl/' + drawingRel.replace(/^\.\.\//, '');
                const drawingFile = get(drawingPath);
                const drawingRels = get('xl/drawings/_rels/' + drawingPath.split('/').pop() + '.rels');
                if (drawingFile && drawingFile.text !== null && drawingRels && drawingRels.text !== null) {
                    const relId = 'rId' + (Math.max(0, ...[...drawingRels.text.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))) + 1);
                    const shapeId = Math.max(0, ...[...drawingFile.text.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map(m => Number(m[1]))) + 1;
                    const emu = 800000;
                    const anchor = '<xdr:oneCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>46</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
                        + '<xdr:ext cx="' + emu + '" cy="' + emu + '"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + shapeId + '" name="qr.png" title="QR"/>'
                        + '<xdr:cNvPicPr preferRelativeResize="0"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="' + relId + '" cstate="print"/>'
                        + '<a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emu + '" cy="' + emu + '"/></a:xfrm>'
                        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></xdr:spPr></xdr:pic><xdr:clientData fLocksWithSheet="0"/></xdr:oneCellAnchor>';
                    drawingFile.text = drawingFile.text.replace('</xdr:wsDr>', anchor + '</xdr:wsDr>');
                    drawingRels.text = drawingRels.text.replace('</Relationships>',
                        '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + qrImageName.split('/').pop() + '"/></Relationships>');
                    files.push({ name: qrImageName, nameBytes: enc.encode(qrImageName), text: null, bin: qrPng, method: 0 });
                }
            }
        } catch (qrErr) {
            console.error('[XLSX] QR embed skipped:', qrErr.message);
        }
    }
    const retainedSheets = new Set([cbrFile, wxFile, notamFile]);
    const removedFiles = new Set(files.filter(file => /^xl\/worksheets\/(?:_rels\/)?sheet\d+\.xml(?:\.rels)?$/.test(file.name) && !retainedSheets.has(file.name.replace('/_rels/', '/').replace(/\.rels$/, ''))).map(file => file.name));
    get('xl/workbook.xml').text = workbookXml.replace(/<sheet\b[^>]*\/>/g, tag => /name="(?:CBR|WX|NOTAM)"/.test(tag) ? tag : '').replace(/<definedNames>[\s\S]*?<\/definedNames>/, '');
    get('xl/_rels/workbook.xml.rels').text = workbookRels.replace(/<Relationship\b[^>]*\/>/g, tag => {
        const target = tag.match(/Target="([^"]+)"/)?.[1];
        return target && removedFiles.has('xl/' + target) ? '' : tag;
    });
    get('[Content_Types].xml').text = get('[Content_Types].xml').text.replace(/<Override\b[^>]*\/>/g, tag => removedFiles.has(tag.match(/PartName="\/([^"]+)"/)?.[1]) ? '' : tag);
    const out = [];
    for (const f of files) {
        if (removedFiles.has(f.name)) continue;
        const data = f.text !== null ? enc.encode(f.text) : f.bin;
        out.push({ name: f.nameBytes, data });
    }
    const xlsx = buildZip(out);
    const flightsStr = (form.legs || []).filter(l => l && l.flightNo).map(l => l.flightNo).join('-') || 'BRIEFING';
    return new Response(xlsx, {
        headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="Crew-Briefing-' + flightsStr + '.xlsx"',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
    });
}

// --- Handler ----------------------------------------------------------------

export async function handleGenerateBriefingXlsx(context, args) {
    const [form] = args || [];
    if (!form || !Array.isArray(form.legs)) {
        return Response.json({ error: 'Invalid form payload (need {legs,tafs,notams,signatures,fields})' }, { status: 400 });
    }
    try {
        return await buildXlsxResponse(context, form, { embedSignatureQr: true });
    } catch (e) {
        console.error('[XLSX] generate failed:', e);
        return Response.json({ error: 'XLSX generation failed: ' + e.message }, { status: e instanceof RangeError ? 400 : 500 });
    }
}

export async function handleGenerateReportXlsx(context, args) {
    const [payload] = args || [];
    if (!payload) return Response.json({ error: 'Missing payload' }, { status: 400 });
    try {
        let form = null;
        if (payload.legs && Array.isArray(payload.legs)) {
            form = payload;
        } else {
            const flights = payload.flights || payload.flightList || payload.callsigns || [];
            const flightArr = Array.isArray(flights) ? flights : String(flights).split(',').map(s => s.trim()).filter(Boolean);
            if (flightArr.length === 0) throw new Error('No flights specified');
            const savedNotamAnalysis = payload.notamAnalysis || payload.savedNotamAnalysis || payload.analysis || {};
            const noSigMap = payload.noSigMap || payload.noSigStationMap || {};
            form = await buildFormFromFlights(context, flightArr, savedNotamAnalysis, noSigMap);
        }
        // Report page (DOWNLOAD SHEET XLSX / CREATE GOOGLE SHEET): no signature QR,
        // and the DATE row defaults to today (UTC) with a date picker/validation.
        return await buildXlsxResponse(context, form, { embedSignatureQr: false, dateCellToday: true });
    } catch (e) {
        console.error('[XLSX report] generate failed:', e);
        return Response.json({ error: 'XLSX report generation failed: ' + e.message }, { status: e instanceof RangeError ? 400 : 500 });
    }
}

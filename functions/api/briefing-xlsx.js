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
// ============================================================================

// --- Cell mapping (verified against template CBR sheet cells/styles/merges) --
// Labels sit one row above their value row (labels 7/9/11, TAF labels 28-29,
// NOTAM header 37-38, signatures 46-47). Because merges group columns,
// writing the anchor (top-left) cell carries the whole merged area.

const ANCHORS = {
    recNo: 'R2', formDate: 'T3', pageOf: 'T4',
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
    const start = sheetXml.indexOf('<c r="' + ref + '"');
    if (start === -1) return sheetXml;
    const tagEnd = sheetXml.indexOf('>', start);
    if (tagEnd === -1) return sheetXml;
    if (sheetXml[tagEnd - 1] === '/') {
        // self-closing <c r="X" s="N"/> → expand to inline string
        const openTag = sheetXml.slice(start, tagEnd - 1);
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
    const legs = orderedFlights.slice(0, 6);
    const { results: tafRows } = await context.env.DB.prepare('SELECT * FROM tafs').all();
    const tafMap = {};
    (tafRows || []).forEach(t => {
        const stn = stationCode(t.station);
        if (!stn) return;
        tafMap[stn] = { raw: t.raw_text || '', issue_time: t.issue_time || '' };
    });
    const orderedStations = [];
    const enrStations = [];
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
        cands.forEach(c => {
            if (!c.station) return;
            const existing = orderedStations.find(s => s.station === c.station);
            if (!existing) orderedStations.push({ station: c.station, label: c.label, isEnr: !!c.label, flights: callsign ? [callsign] : [] });
            else {
                if (callsign && !existing.flights.includes(callsign)) existing.flights.push(callsign);
                if (c.label && !existing.label) { existing.label = c.label; existing.isEnr = true; }
            }
            if (c.label) enrStations.push({ slotId: c.label + '_' + (callsign || 'FLT'), label: c.label, station: c.station, flight: callsign });
        });
    });
    const stationCodes = orderedStations.map(s => s.station);
    const notamMap = {};
    if (stationCodes.length > 0) {
        const stnPlaceholders = stationCodes.map(() => '?').join(',');
        const { results: notamRows } = await context.env.DB.prepare(
            `SELECT id, location, message FROM notams WHERE location IN (${stnPlaceholders})`
        ).bind(...stationCodes).all();
        (notamRows || []).forEach(n => {
            const stn = stationCode(n.location);
            if (!stn) return;
            if (!notamMap[stn]) notamMap[stn] = [];
            const text = String(n.message || '').trim();
            if (text && !notamMap[stn].includes(text)) notamMap[stn].push(text);
        });
    }
    const analysis = savedNotamAnalysis && typeof savedNotamAnalysis === 'object' ? savedNotamAnalysis : {};
    const tafs = [];
    for (let i = 0; i < 6; i++) {
        const f = legs[i];
        const callsign = f ? String(f.callsign || '').trim().toUpperCase() : '';
        const podStn = f ? stationCode(f.dep) : '';
        const poaStn = f ? stationCode(f.dest) : '';
        const podTime = f ? compactTime(f.etd) : '';
        const poaTime = f ? compactTime(f.eta) : '';
        const podRaw = podStn ? (tafMap[podStn]?.raw || '') : '';
        const poaRaw = poaStn ? (tafMap[poaStn]?.raw || '') : '';
        const podForecast = podStn ? (podRaw || 'NIL TAF DATA IN DATABASE') : '';
        const poaForecast = poaStn ? (poaRaw || 'NIL TAF DATA IN DATABASE') : '';
        tafs.push({ slot: 'POD' + (i + 1), station: podStn, stationEntered: podStn, time: podTime || (podStn && tafMap[podStn]?.issue_time ? compactTime(tafMap[podStn].issue_time) : ''), forecast: podForecast, flight: callsign });
        tafs.push({ slot: 'POA' + (i + 1), station: poaStn, stationEntered: poaStn, time: poaTime || (poaStn && tafMap[poaStn]?.issue_time ? compactTime(tafMap[poaStn].issue_time) : ''), forecast: poaForecast, flight: callsign });
    }
    enrStations.forEach(e => {
        const raw = tafMap[e.station]?.raw || '';
        tafs.push({ slot: e.label, station: e.station, stationEntered: e.station, time: '', forecast: raw || 'NIL TAF DATA IN DATABASE', flight: e.flight });
    });
    const notams = orderedStations.map(entry => {
        const key = entry.station;
        const isNoSig = !!(noSigStationMap && noSigStationMap[key]);
        const grouped = notamMap[key] || [];
        let text = '';
        if (grouped.length > 0) text = grouped.join('\n\n');
        else if (isNoSig) text = 'NIL SIGNIFICANT NOTAM';
        else text = 'NIL OPERATIONAL NOTAM.';
        const selected = analysis[entry.flights[0]] || analysis[key] || [];
        if (Array.isArray(selected) && selected.length > 0) {
            const ids = selected.map(x => typeof x === 'string' ? x : x.id || x).filter(Boolean);
            if (ids.length > 0) {
                const filtered = grouped.filter((_, idx) => ids.includes(String(idx)));
            }
        }
        return { station: entry.station, stationEntered: entry.station, flights: entry.flights, enr: entry.isEnr, text };
    });
    const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 16) + 'Z';
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
        recNo: savedFields.recNo || ('CBR-' + flightList.join('-') + '-' + new Date().toISOString().substring(0, 10).replace(/-/g, '')),
        formDate: savedFields.formDate || nowUtc,
        pageOf: savedFields.pageOf || '1 of 1',
        dxrName: savedFields.dxrName || '',
        picName: savedFields.picName || ''
    };
    const legsPayload = legs.map((f, idx) => ({
        leg: idx + 1,
        flightNo: String(f.callsign || '').trim().toUpperCase(),
        date: String(f.dof || ''),
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

async function buildXlsxResponse(context, form) {
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
    xml = setInlineCell(xml, ANCHORS.recNo, fields.recNo || '');
    xml = setInlineCell(xml, ANCHORS.formDate, fields.formDate || '');
    xml = setInlineCell(xml, ANCHORS.pageOf, fields.pageOf || '1 of 1');
    (form.legs || []).slice(0, 6).forEach((leg, i) => {
        const r = 8 + i * 2;
        const ofpCell = 'R' + r;
        xml = setInlineCell(xml, 'B' + r, leg.flightNo || '');
        xml = setInlineCell(xml, 'D' + r, leg.date || '');
        xml = setInlineCell(xml, 'H' + r, leg.reg || '');
        xml = setInlineCell(xml, 'G' + r, leg.pod || '');
        xml = setInlineCell(xml, 'I' + r, leg.std || '');
        xml = setInlineCell(xml, 'J' + r, leg.poa || '');
        xml = setInlineCell(xml, 'K' + r, leg.sta || '');
        xml = setInlineCell(xml, 'N' + r, leg.alt || '');
        xml = setInlineCell(xml, ofpCell, leg.ofpRef || '');
    });
    const tafRowFor = (slot) => {
        const m = String(slot || '').match(/(POD|POA)\s*(\d)/i);
        if (!m) return null;
        const idx = (+m[2] - 1) * 2 + (m[1].toUpperCase() === 'POD' ? 0 : 1);
        if (idx < 0 || idx > 5) return null;
        return 30 + idx;
    };
    (form.tafs || []).forEach((t) => {
        const r = tafRowFor(t.slot);
        if (!r) return;
        const right = /POA/i.test(t.slot || '') && +String(t.slot).replace(/\D/g, '') > 3;
        const stCol = right ? 'K' : 'C';
        const tmCol = right ? 'L' : 'D';
        const txCol = right ? 'P' : 'G';
        xml = setInlineCell(xml, stCol + r, t.stationEntered || t.station || '');
        xml = setInlineCell(xml, tmCol + r, t.time || '');
        xml = setInlineCell(xml, txCol + r, t.forecast || '');
    });
    (form.notams || []).slice(0, 7).forEach((nt, i) => {
        const r = 39 + i;
        xml = setInlineCell(xml, 'C' + r, nt.stationEntered || nt.station || '');
        xml = setInlineCell(xml, 'E' + r, nt.text || '');
    });
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
            if (flightsStr) wxXml = setInlineCell(wxXml, 'B18', flightsStr);
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
            if (flightsStr2) ntXml = setInlineCell(ntXml, 'B18', flightsStr2);
            ntSheet.text = ntXml;
        }
    }
    const out = [];
    for (const f of files) {
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
        return await buildXlsxResponse(context, form);
    } catch (e) {
        console.error('[XLSX] generate failed:', e);
        return Response.json({ error: 'XLSX generation failed: ' + e.message }, { status: 500 });
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
        return await buildXlsxResponse(context, form);
    } catch (e) {
        console.error('[XLSX report] generate failed:', e);
        return Response.json({ error: 'XLSX report generation failed: ' + e.message }, { status: 500 });
    }
}

// ============================================================================
// BRIEFING XLSX GENERATION - Native .xlsx output using template-edit approach
// ----------------------------------------------------------------------------
// Fills the committed template public/briefing-template.xlsx (sheet CBR) with
// the SAME payload shape as briefing-form.js collectForm() output.
// Only value cells are touched; merges/styles/images/print setup stay intact.
// NO EXTERNAL DEPENDENCIES - pure JS ZIP handling (inflate via
// DecompressionStream, deflate via CompressionStream, CRC32 table).
//
// Route: POST /api/rpc {method:'generateBriefingXlsx', args:[form]}
// ============================================================================

// --- Cell mapping (verified against template CBR sheet cells/styles/merges) --
// Labels sit one row above their value row (labels 7/9/11, TAF labels 28-29,
// NOTAM header 37-38, signatures 46-47). Because merges group columns,
// writing the anchor (top-left) cell carries the whole merged area.

const ANCHORS = {
    recNo: 'R2', formDate: 'T3', pageOf: 'T4',
    dxrName: 'E48', picName: 'O48'
};

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

// --- Handler ----------------------------------------------------------------

export async function handleGenerateBriefingXlsx(context, args) {
    const [form] = args || [];
    if (!form || !Array.isArray(form.legs)) {
        return Response.json({ error: 'Invalid form payload (need {legs,tafs,notams,signatures,fields})' }, { status: 400 });
    }
    try {
        const tplUrl = new URL('/briefing-template.xlsx', context.request.url);
        const tplRes = await fetch(tplUrl);
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
        const sheet = get(cbrFile);
        if (!sheet || sheet.text === null) throw new Error(cbrFile + ' missing/unreadable');

        let xml = sheet.text;
        const fields = form.fields || {};
        xml = setInlineCell(xml, ANCHORS.recNo, fields.recNo || '');
        xml = setInlineCell(xml, ANCHORS.formDate, fields.formDate || '');
        xml = setInlineCell(xml, ANCHORS.pageOf, fields.pageOf || '1 of 1');

        (form.legs || []).slice(0, 6).forEach((leg, i) => {
            const r = 8 + i * 2; // value rows 8,10,12,14,16,18
            // Columns follow the label facets: B(FLIGHT NO) D(DATE) H(A/C REG)
            // G(POD) I(STD) J(POA) K(STA) N(ALTN) + OFP at R.
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

        // TAF slots: form slot keys look like "POD1"/"POA1"... map to rows 30-35
        // left block (C anchor + D time, text merged G:J anchor G) and
        // right block (K anchor + L time, text merged P:S anchor P).
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

        // NOTAM rows 39-45 (template has 7 slots): station C:D anchor C, text E:S anchor E.
        (form.notams || []).slice(0, 7).forEach((nt, i) => {
            const r = 39 + i;
            xml = setInlineCell(xml, 'C' + r, nt.stationEntered || nt.station || '');
            xml = setInlineCell(xml, 'E' + r, nt.text || '');
        });

        const sig = form.signatures || {};
        xml = setInlineCell(xml, ANCHORS.dxrName, sig.dxrName || '');
        xml = setInlineCell(xml, ANCHORS.picName, sig.picName || '');

        // Rebuild: store everything uncompressed (valid ZIP, Excel-compatible).
        const out = [];
        for (const f of files) {
            const data = (f.name === cbrFile) ? enc.encode(xml) : (f.text !== null ? enc.encode(f.text) : f.bin);
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
    } catch (e) {
        console.error('[XLSX] generate failed:', e);
        return Response.json({ error: 'XLSX generation failed: ' + e.message }, { status: 500 });
    }
}

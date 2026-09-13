/**
 * FIR_Notam_Backend.gs — Web-based FIR NOTAM editor.
 * Lets dispatchers add / edit / delete FIR NOTAM rows directly from the
 * dashboard web UI, without opening the spreadsheet.
 *
 * Sheet 'FIR' layout (no header row, 7 columns):
 *   A = Location/FIR   B = NOTAM #   C = Class
 *   D = Issue Date     E = Effective Date   F = Expiration Date
 *   G = NOTAM Text
 *
 * rowId returned to the UI is the real 1-based spreadsheet row number, so
 * update/delete can target the exact row.
 */

// Cache and column constants are defined in Constants.gs

/**
 * Read all FIR NOTAM rows for the editor.
 * Returns { ok, notams:[{rowId, Location, 'NOTAM #', Class, 'Issue Date',
 * 'Effective Date', 'Expiration Date', 'NOTAM Text'}], count }.
 * @expose
 */
function firGetNotamEditorData() {
  try {
    const query = "SELECT * FROM notams";
    const dbNotams = D1Helper.select(query);
    
    const notams = [];
    
    for (let i = 0; i < dbNotams.length; i++) {
      const row = dbNotams[i];
      // Format the dates specifically for the dashboard
      const eff = row.valid_from ? row.valid_from.replace('T', ' ').substring(0, 16) : '';
      const exp = row.valid_to ? row.valid_to.replace('T', ' ').substring(0, 16) : '';
      
      notams.push({
        rowId: row.id, // Using D1 ID
        Location: row.location,
        'NOTAM #': row.id, 
        Class: row.notam_code,
        'Issue Date': eff, // Mapped effective as issue as a fallback if issue date isn't kept separately
        'Effective Date': eff,
        'Expiration Date': exp,
        'NOTAM Text': row.message,
        updatedAt: row.updated_at || ''
      });
    }
    
    return { ok: true, notams: notams, count: notams.length, skipped: 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Invalidate the FIR NOTAM editor cache after any write. */
function firClearNotamCache() {
  try {
    try { CacheService.getScriptCache().remove(FIR_NOTAM_CACHE_KEY); } catch (e) {}
    try { CacheService.getUserCache().remove(FIR_NOTAM_CACHE_KEY); } catch (e2) {}
  } catch (e) {}
}

/**
 * Add a new FIR NOTAM row.
 * payload: { Location, 'NOTAM #', Class, 'Issue Date', 'Effective Date',
 * 'Expiration Date', 'NOTAM Text' }
 * @expose
 */
function firSaveNotam(payload) {
  try {
    requireAuthorized();
    const clean = firNotamValidate(payload);
    if (clean.error) return clean;
    
    const dup = firNotamDuplicateCheck(clean.Location, clean['NOTAM #']);
    if (dup) return { ok: false, error: 'NOTAM ' + clean['NOTAM #'] + ' already exists. Edit the existing row instead.' };
    
    const query = `
      INSERT INTO notams 
      (id, location, notam_code, message, valid_from, valid_to, risk_level, is_active, updated_at, kind) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'FIR')
    `;
    
    const params = [
      clean['NOTAM #'],
      clean.Location,
      clean.Class,
      clean['NOTAM Text'],
      clean['Effective Date'],
      clean['Expiration Date'],
      'LOW', // Defaulting risk
      1      // Defaulting active
    ];
    
    D1Helper.run(query, params);
    
    firClearNotamCache();
    return { ok: true, message: 'NOTAM ' + clean['NOTAM #'] + ' added.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Update an existing FIR NOTAM row by its ID.
 * payload: { rowId, ...fields }
 * @expose
 */
function firUpdateNotam(payload) {
  try {
    requireAuthorized();
    const rowId = payload && payload.rowId;
    if (!rowId) return { ok: false, error: 'Invalid rowId.' };
    
    const clean = firNotamValidate(payload);
    if (clean.error) return clean;
    
    // Optimistic check + short lock: 2 tab bisa lolos check bersamaan kalau tanpa lock (TOCTOU).
    // ponytail: 5s lock cukup; full row-versioning penalti besar tidak dibutuhkan untuk beban ini.
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return { ok: false, error: 'Another user is saving right now. Try again.' };
    try {
      const current = D1Helper.select("SELECT updated_at FROM notams WHERE id = ? LIMIT 1", [rowId]);
      if (!current || !current.length) return { ok: false, error: 'Row ' + rowId + ' no longer exists (deleted elsewhere?). Reload.' };
      const dbUpdatedAt = String(current[0].updated_at || '');
      const clientUpdatedAt = String(payload.updatedAt || '');
      if (dbUpdatedAt && clientUpdatedAt && dbUpdatedAt !== clientUpdatedAt) {
        return { ok: false, error: 'Row changed by another user since you opened it. Reload the list (stale editor), then re-view.' };
      }

      const dup = firNotamDuplicateCheck(clean.Location, clean['NOTAM #'], rowId);
      if (dup) return { ok: false, error: 'NOTAM ' + clean['NOTAM #'] + ' already exists. Edit the existing row instead.' };
      
      const query = `
        UPDATE notams 
        SET location = ?, notam_code = ?, message = ?, valid_from = ?, valid_to = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
      
      const params = [
        clean.Location,
        clean.Class,
        clean['NOTAM Text'],
        clean['Effective Date'],
        clean['Expiration Date'],
        rowId
      ];
      
      D1Helper.run(query, params);
    } finally {
      lock.releaseLock();
    }
    
    firClearNotamCache();
    return { ok: true, message: 'NOTAM ' + clean['NOTAM #'] + ' updated.', updatedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Delete a FIR NOTAM row by its ID.
 * rowId: string OR { rowId, updatedAt } — updatedAt enables stale-delete protection.
 * @expose
 */
function firDeleteNotam(rowIdArg) {
  try {
    requireAuthorized();
    const payload = (rowIdArg && typeof rowIdArg === 'object') ? rowIdArg : { rowId: rowIdArg };
    const rowId = payload.rowId;
    if (!rowId) return { ok: false, error: 'Invalid rowId.' };
    
    const current = D1Helper.select("SELECT updated_at FROM notams WHERE id = ? LIMIT 1", [rowId]);
    if (!current || !current.length) return { ok: false, error: 'Row ' + rowId + ' no longer exists. Reload.' };
    const dbUpdatedAt = String(current[0].updated_at || '');
    const clientUpdatedAt = String(payload.updatedAt || '');
    if (dbUpdatedAt && clientUpdatedAt && dbUpdatedAt !== clientUpdatedAt) {
      return { ok: false, error: 'Row changed by another user. Reload the list first.' };
    }
    
    D1Helper.run("DELETE FROM notams WHERE id = ?", [rowId]);
    
    firClearNotamCache();
    return { ok: true, message: 'NOTAM row deleted.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------- helpers ---------- */

/**
 * Read all FIR NOTAM rows enriched with computed display fields for the
 * "Results" tab: status (ACTIVE/EXPIRED), risk (HIGH/MEDIUM/LOW) and type
 * (NEW/RPL/CNL). Reuses the shared FIR parsing helpers from FIR_Parity_Backend.gs.
 * Returns { ok, results:[{rowId, Location, 'NOTAM #', Class, 'Issue Date',
 * 'Effective Date', 'Expiration Date', 'NOTAM Text', status, risk, type}], count }.
 * @expose
 */
function firGetNotamResults() {
  try {
    const base = firGetNotamEditorData();
    if (!base || !base.ok) return base || { ok: false, error: 'Failed to load NOTAMs.' };
    const now = new Date();
    const results = (base.notams || []).map(function (n) {
      const text = String(n['NOTAM Text'] || '');
      const parsed = (typeof firParseNotamText === 'function') ? firParseNotamText(text) : null;
      const qCode = parsed ? parsed.qCode : '';
      const risk = (typeof firGetRiskLevel === 'function') ? firGetRiskLevel(qCode, text) : 'LOW';
      const type = (typeof firParseNotamRef === 'function' && firParseNotamRef(text, 'C')) ? 'CNL'
        : (typeof firParseNotamRef === 'function' && firParseNotamRef(text, 'R')) ? 'RPL' : 'NEW';
      let status = 'ACTIVE';
      const eff = n['Effective Date'];
      const exp = n['Expiration Date'];
      const effDate = eff ? firNotamDateToText(eff) : '';
      const expDate = exp ? firNotamDateToText(exp) : '';
      if (expDate && String(expDate).toUpperCase() !== 'PERM') {
        const expD = duParseNotamDate(expDate);
        if (!isNaN(expD.getTime()) && now > expD) status = 'EXPIRED';
      }
      return {
        rowId: n.rowId,
        Location: n.Location,
        'NOTAM #': n['NOTAM #'],
        Class: n.Class,
        'Issue Date': n['Issue Date'],
        'Effective Date': effDate,
        'Expiration Date': expDate,
        'NOTAM Text': text,
        status: status,
        risk: risk,
        type: type
      };
    });
    const rank = { ACTIVE: 0, EXPIRED: 1 };
    results.sort(function (a, b) {
      const ra = rank[a.status] !== undefined ? rank[a.status] : 2;
      const rb = rank[b.status] !== undefined ? rank[b.status] : 2;
      if (ra !== rb) return ra - rb;
      const la = String(a.Location || ''), lb = String(b.Location || '');
      if (la !== lb) return la < lb ? -1 : 1;
      const na = String(a['NOTAM #'] || ''), nb = String(b['NOTAM #'] || '');
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });
    return { ok: true, results: results, count: results.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Duplicate check across Cloudflare D1. 
 * excludeRowId skips the row being updated so a save can keep its own identity.
 * @expose
 */
function firNotamDuplicateCheck(location, number, excludeRowId) {
  const loc = String(location || '').trim().toUpperCase();
  const num = String(number || '').trim().toUpperCase();
  if (!loc || !num) return null;
  
  try {
    const existing = D1Helper.select("SELECT id FROM notams WHERE id = ?", [num]);
    if (existing && existing.length > 0) {
      if (excludeRowId && existing[0].id === excludeRowId) {
        return null; // It's the same row being edited
      }
      return 'D1 Database'; // Found a duplicate
    }
  } catch(e) {
    console.warn('Duplicate check error: ' + e.message);
  }
  return null;
}

/**
 * Strict row plausibility check shared by the editor reader, the results
 * view and the cleanup tool. Criteria mirror firNotamValidate() (this file)
 * and firParseFirSheetNotams() (FIR_Parity_Backend.gs) so rows saved through
 * the UI always pass, while pasted DINS dumps (query headers, legends,
 * column notes) are rejected.
 * @expose
 */
function firNotamRowLooksValid(row) {
  if (!row || !row.some(Boolean)) return false;
  const location = String(row[0] || '').trim().toUpperCase();
  const number = String(row[1] || '').trim().toUpperCase();
  const text = String(row[6] || '').trim();
if (!/^[A-Z]{4}$/.test(location)) return false;
if (!/^[A-Z]\d{4}\/\d{2}(N|R|C)?$/.test(number)) return false;
  if (text.length === 0) return false;
  // ponytail: reject DINS dump headers accidentally saved as NOTAM Text
  if (/NOTAMs for Location search|Query ran at UTC|NOTAM Condition\/LTA subject|Filter\(s\) used:/i.test(text)) return false;
  // ponytail: reject absurdly long text that contains multiple Q) headers (table dump)
  const qCount = (text.match(/^Q\)/gm) || []).length;
  if (qCount > 1 && text.length > 3000) return false;
  return true;
}

/**
 * Maintenance tool: permanently delete non-NOTAM rows from the 'FIR' sheet
 * (pasted DINS query headers, legends, malformed entries).
 *
 * Run from the Apps Script editor:
 *   firCleanInvalidNotamRows()          // dry-run, reports what would be deleted
 *   firCleanInvalidNotamRows(false)     // actually delete
 *
 * Returns { ok, dryRun, total, invalid, deleted, sample:[{row, location, preview}] }.
 * @expose
 */
function firCleanInvalidNotamRows(dryRun) {
  try {
    if (dryRun === undefined) dryRun = true;
    const sheet = getActiveSS().getSheetByName('FIR');
    if (!sheet) return { ok: false, error: "Sheet 'FIR' not found." };
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { ok: true, dryRun: !!dryRun, total: 0, invalid: 0, deleted: 0, sample: [] };
    const values = sheet.getRange(1, 1, lastRow, FIR_NOTAM_COLS).getValues();
    const invalidRows = [];
    const sample = [];
    for (let i = 0; i < values.length; i++) {
      if (firNotamRowLooksValid(values[i])) continue;
      const rowNumber = i + 1;
      invalidRows.push(rowNumber);
      if (sample.length < 15) {
        sample.push({
          row: rowNumber,
          location: String(values[i][0] || '').substring(0, 60),
          preview: String(values[i][6] || values[i][1] || '').substring(0, 80)
        });
      }
    }
    let deleted = 0;
    if (!dryRun && invalidRows.length > 0) {
      for (let j = invalidRows.length - 1; j >= 0; j--) {
        sheet.deleteRow(invalidRows[j]);
        deleted++;
      }
      firClearNotamCache();
      try { if (typeof firClearNotamDependentCache === 'function') firClearNotamDependentCache(); } catch (e) { console.warn('cache clear skipped: ' + e.message); }
    }
    return {
      ok: true,
      dryRun: !!dryRun,
      total: values.length,
      invalid: invalidRows.length,
      deleted: deleted,
      sample: sample
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Detect polluted NOTAM Text that contains DINS table dump headers.
 * Returns { ok, total, polluted, sample:[{row, Location, NOTAM, size, preview}] }
 * @expose
 */
function firDetectPollutedNotamRows() {
  try {
    const sheet = getActiveSS().getSheetByName('FIR');
    if (!sheet) return { ok: false, error: "Sheet 'FIR' not found." };
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { ok: true, total: 0, polluted: 0, sample: [] };
    const values = sheet.getRange(1, 1, lastRow, FIR_NOTAM_COLS).getValues();
    const pollutedRows = [];
    const sample = [];
    const re = /NOTAMs for Location search|Query ran at UTC|NOTAM Condition\/LTA subject|Filter\(s\) used:/i;
    for (let i = 0; i < values.length; i++) {
      const text = String(values[i][6] || '');
      if (!re.test(text)) {
        const qc = (text.match(/^Q\)/gm) || []).length;
        if (!(qc > 1 && text.length > 3000)) continue;
      }
      pollutedRows.push(i + 1);
      if (sample.length < 15) {
        sample.push({
          row: i + 1,
          Location: String(values[i][0] || '').substring(0, 10),
          NOTAM: String(values[i][1] || '').substring(0, 12),
          size: text.length,
          preview: text.substring(0, 120).replace(/\n/g, ' ')
        });
      }
    }
    const res = { ok: true, total: values.length, polluted: pollutedRows.length, rows: pollutedRows, sample: sample };
    console.log(JSON.stringify(res, null, 2));
    try { Logger.log(JSON.stringify(res)); } catch(e){}
    return res;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Delete polluted rows (DINS dump). dryRun=true reports only.
 * Usage: firCleanPollutedNotamRows()           // dry-run
 *        firCleanPollutedNotamRows(false)      // delete
 * @expose
 */
function firCleanPollutedNotamRows(dryRun) {
  try {
    if (dryRun === undefined) dryRun = true;
    const det = firDetectPollutedNotamRows();
    if (!det.ok) return det;
    let deleted = 0;
    if (!dryRun && det.rows && det.rows.length > 0) {
      const sheet = getActiveSS().getSheetByName('FIR');
      for (let j = det.rows.length - 1; j >= 0; j--) {
        sheet.deleteRow(det.rows[j]);
        deleted++;
      }
      firClearNotamCache();
      try { if (typeof firClearNotamDependentCache === 'function') firClearNotamDependentCache(); } catch (e) { console.warn('cache clear skipped: ' + e.message); }
    }
    const res2 = { ok: true, dryRun: !!dryRun, total: det.total, polluted: det.polluted, deleted: deleted, sample: det.sample };
    console.log(JSON.stringify(res2, null, 2));
    try { Logger.log(JSON.stringify(res2)); } catch(e){}
    return res2;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function firNotamDateToText(value) {
  return duNotamDateToText(value);
}

/**
 * Validate a NOTAM payload for the editor (insert/update).
 * Returns { ok, ...normalizedFields } on success or { ok: false, error }.
 */
function firNotamValidate(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'No payload.' };
  const location = String(payload.Location || '').trim().toUpperCase();
  const rawNumber = String(payload['NOTAM #'] || '').trim().toUpperCase();
  // ponytail: normalize NOTAM # — tolerate unicode slashes / pasted noise
  const normNumber = rawNumber.replace(/\u2215|\u2044|\uFF0F/g, '/').replace(/\s+/g, '');
  const nm = normNumber.match(/([A-Z]\d{4}\/\d{2})/);
  const number = nm ? nm[1] : normNumber;
  const cls = String(payload.Class || '').trim().toUpperCase();
  const issue = String(payload['Issue Date'] || '').trim();
  const effective = String(payload['Effective Date'] || '').trim();
  const expiration = String(payload['Expiration Date'] || '').trim();
  const text = String(payload['NOTAM Text'] || '').trim();
  if (!/^[A-Z]{4}$/.test(location)) return { ok: false, error: 'Location must be a 4-letter ICAO code (e.g. WIII).' };
  if (!/^[A-Z]\d{4}\/\d{2}$/i.test(number)) return { ok: false, error: 'NOTAM # must match format like A1234/26.' };
  if (!cls) return { ok: false, error: 'Class is required (e.g. A, B, C, D, E).' };
  if (!text) return { ok: false, error: 'NOTAM Text is required.' };
  if (/NOTAMs for Location search|Query ran at UTC|NOTAM Condition\/LTA subject|Filter\(s\) used:/i.test(text)) {
    return { ok: false, error: 'NOTAM Text contains a DINS query header — paste a single ICAO NOTAM only. Use the UPDATE NOTAM page / table TSV path.' };
  }
  if ((text.match(/^Q\)/gm) || []).length > 1 && text.length > 3000) {
    return { ok: false, error: 'NOTAM Text looks like a table dump (multiple Q) lines). Paste one NOTAM at a time.' };
  }
  const dateRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  const checkDate = function(s) {
    if (!dateRe.test(s)) return false;
    const d = duParseNotamDate(s);
    return d instanceof Date && !isNaN(d.getTime());
  };
  if (issue && !checkDate(issue)) return { ok: false, error: 'Issue Date must be YYYY-MM-DD HH:MM (UTC) or blank.' };
  if (effective && !checkDate(effective)) return { ok: false, error: 'Effective Date must be YYYY-MM-DD HH:MM (UTC) or blank.' };
  if (expiration && expiration.toUpperCase() !== 'PERM' && !checkDate(expiration)) {
    return { ok: false, error: 'Expiration Date must be YYYY-MM-DD HH:MM (UTC), PERM, or blank.' };
  }
  if (effective && expiration && expiration.toUpperCase() !== 'PERM') {
    const effD = duParseNotamDate(effective);
    const expD = duParseNotamDate(expiration);
    if (effD instanceof Date && expD instanceof Date && !isNaN(effD.getTime()) && !isNaN(expD.getTime()) && effD.getTime() > expD.getTime()) {
      return { ok: false, error: 'Effective Date cannot be after Expiration Date.' };
    }
  }
  return {
    ok: true,
    Location: location,
    'NOTAM #': number,
    Class: cls,
    'Issue Date': issue,
    'Effective Date': effective,
    'Expiration Date': expiration,
    'NOTAM Text': text
  };
}
function firGetExistingNotamKeySet_() {
  const set = {};
  try {
    const ss = getActiveSS();
    const firSheet = ss.getSheetByName('FIR');
    if (firSheet && firSheet.getLastRow()>0) {
      const vals = firSheet.getRange(1,1,firSheet.getLastRow(),2).getValues();
      for (let i =0;i<vals.length;i++){
        const k = String(vals[i][0]||'').trim().toUpperCase() + '|' + String(vals[i][1]||'').trim().toUpperCase();
        if (k !== '|') set[k]=true;
      }
    }
    if (typeof firGetSheetData==='function' && typeof firProcessNotamSheet==='function') {
      const nv = firGetSheetData('NOTAM');
      if (nv && nv.length>1) {
        const list = firProcessNotamSheet(nv);
        for (let j =0;j<list.length;j++){
          const k2 = String(list[j].Location||'').trim().toUpperCase() + '|' + String(list[j]['NOTAM #']||'').trim().toUpperCase();
          if (k2 !== '|') set[k2]=true;
        }
      }
    }
  } catch(e){ console.warn('keySet error: '+e.message); }
  return set;
}

function firParseBulkNotamText(rawText) {
  if (!rawText || !String(rawText).trim()) return { ok: false, error: 'No text provided.' };
  const text = String(rawText);
  const isTSV = text.indexOf('\t') !== -1;
  const rows = [];
  const warnings = [];
  const fmtDate = function(d){ return (d instanceof Date && !isNaN(d.getTime())) ? duNotamDateToText(d) : ''; };
  try {
    if (isTSV) {
      const data = Utilities.parseCsv(text, '\t');
      if (!data || data.length === 0) return { ok: false, error: 'Empty table.' };
      const header = data[0].map(function(h){ return String(h||'').trim().toLowerCase(); });
      const hasHeader = header.some(function(h){ return h.indexOf('location')>-1 || h.indexOf('notam')>-1 || h.indexOf('condition')>-1; });
       let textIdx = header.findIndex(function(h){ return h.indexOf('condition')>-1 || h.indexOf('subject')>-1 || h.indexOf('text')>-1; });
       const locIdx = header.findIndex(function(h){ return h.indexOf('location')>-1; });
      const noIdx = header.findIndex(function(h){ return h.indexOf('#')>-1 || h.indexOf('number')>-1; });
      const clsIdx = header.findIndex(function(h){ return h.indexOf('class')>-1; });
      const issIdx = header.findIndex(function(h){ return h.indexOf('issue')>-1; });
      const effIdx = header.findIndex(function(h){ return h.indexOf('effective')>-1; });
      const expIdx = header.findIndex(function(h){ return h.indexOf('expiration')>-1; });
      if (textIdx === -1) {
        for (let k =0;k<data.length;k++) {
          const f = data[k].findIndex(function(c){ return String(c||'').indexOf('Q)')!==-1; });
          if (f!==-1) { textIdx=f; break; }
        }
      }
      if (textIdx===-1) textIdx = data[0].length-1;
      const start = hasHeader ? 1 : 0;
      for (let i =start;i<data.length;i++) {
        const cols = data[i];
        if (!cols || cols.length<=textIdx) continue;
        const nt = cols[textIdx] ? String(cols[textIdx]).trim() : '';
        if (!nt || nt.indexOf('Q)')===-1) continue;
        // also skip the header-like rows that slipped through
        if (/NOTAMs for Location search|Query ran at UTC/i.test(nt)) continue;
        const extLoc = (nt.match(/Q\)\s*([^ \/]+)/)||[])[1] || 'UNKNOWN';
        const extNo = (nt.match(/([A-Z]\d{4}\/\d{2})/)||[])[1] || 'N/A';
        const extCls = (typeof firInferNotamClass==='function') ? firInferNotamClass(nt) : 'N/A';
        const extIss = duParseNotamIssueDate(nt)||'';
        const extEff = duParseNotamDateField(nt,'B)')||'';
        const extExp = duParseNotamDateField(nt,'C)')||'';
        const locV = (locIdx!==-1 && cols[locIdx]) ? String(cols[locIdx]).trim() : extLoc;
        const noV = (noIdx!==-1 && cols[noIdx]) ? String(cols[noIdx]).trim() : extNo;
        const clsV = (clsIdx!==-1 && cols[clsIdx]) ? String(cols[clsIdx]).trim() : extCls;
        const issV = (issIdx!==-1 && cols[issIdx]) ? String(cols[issIdx]).trim() : (extIss||'');
        const effV = (effIdx!==-1 && cols[effIdx]) ? String(cols[effIdx]).trim() : extEff;
        const expV = (expIdx!==-1 && cols[expIdx]) ? String(cols[expIdx]).trim() : extExp;
        // normalize DINS TSV dates like "05/26/2026 1150" or "05/26/2026 11:50" to YYYY-MM-DD HH:MM
        const normDate = function(s){
          if (s instanceof Date) return isNaN(s.getTime()) ? '' : duNotamDateToText(s);
          s=String(s||'').trim();
          if(!s) return '';
          if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s;
          if(s.toUpperCase()==='PERM') return 'PERM';
          // try duParseNotamDate via known helper then format
          try {
            // US format MM/DD/YYYY HHMM
            const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{2}):?(\d{2}))?/);
            if(m){
              const y=parseInt(m[3],10), mo=parseInt(m[1],10), d=parseInt(m[2],10), hh=parseInt(m[4]||'0',10), mm2=parseInt(m[5]||'0',10);
              const dt=new Date(Date.UTC(y,mo-1,d,hh,mm2));
              if(!isNaN(dt.getTime())) return dt.getUTCFullYear()+'-'+String(dt.getUTCMonth()+1).padStart(2,'0')+'-'+String(dt.getUTCDate()).padStart(2,'0')+' '+String(dt.getUTCHours()).padStart(2,'0')+':'+String(dt.getUTCMinutes()).padStart(2,'0');
            }
            const dd=duParseNotamDate(s);
            if(dd instanceof Date && !isNaN(dd.getTime())){
              return dd.getUTCFullYear()+'-'+String(dd.getUTCMonth()+1).padStart(2,'0')+'-'+String(dd.getUTCDate()).padStart(2,'0')+' '+String(dd.getUTCHours()).padStart(2,'0')+':'+String(dd.getUTCMinutes()).padStart(2,'0');
            }
          } catch(e){}
          return s;
        };
        rows.push([locV, noV, clsV, normDate(issV), normDate(effV), normDate(expV), nt]);
      }
    } else {
      // Raw ICAO — split by Q) boundaries, but handle DINS dump with multiple NOTAMs concatenated
      // First strip the query header table if present (everything before first Q) that contains the TSV header)
      const qIdx = text.indexOf('Q)');
      if (qIdx>0) {
       const headerPart = text.substring(0,qIdx);
         if (/NOTAMs for Location search|Location\s+NOTAM #\/LTA #/i.test(headerPart)) {
           text = text.substring(qIdx);
         }
       }
       let parts = text.split(/(?=Q\))/g);
       parts = parts.filter(function(p){ return p.trim()!==''; });
      for (let p2 =0;p2<parts.length;p2++){
        const nt2 = parts[p2].trim();
        if (!nt2 || nt2.indexOf('Q)')===-1) continue;
        const lm = nt2.match(/Q\)\s*([^ \/]+)/);
        const nm2 = nt2.match(/([A-Z]\d{4}\/\d{2})/);
        rows.push([
          lm?lm[1]:'UNKNOWN',
          nm2?nm2[1]:'N/A',
          (typeof firInferNotamClass==='function')?firInferNotamClass(nt2):'N/A',
            fmtDate(duParseNotamIssueDate(nt2)),
            fmtDate(duParseNotamDateField(nt2,'B)')),
            nt2.match(/C\)\s*PERM/i) ? 'PERM' : fmtDate(duParseNotamDateField(nt2,'C)')),
          nt2
        ]);
      }
    }
    return { ok:true, rows:rows, isTSV:isTSV, warnings:warnings };
  } catch(e){
    return { ok:false, error:e.message };
  }
}

/**
 * Dry-run preview bulk FIR NOTAM import.
 * Returns { ok, total, valid, invalid, duplicates, preview:[{Location,NOTAM#,Class,Issue,Eff,Exp,ok,error}] }
 * @expose
 */
function firBulkPreviewNotams(rawText) {
  try {
    const startMs = new Date().getTime();
    const parsed = firParseBulkNotamText(rawText);
    if (!parsed.ok) return parsed;
    // Build dedup set once — avoids 40+ sheet reads
    const keySet = firGetExistingNotamKeySet_();
    const seenInBatch = {};
     const preview = [];
     let valid=0, invalid=0, dup=0;
    // For speed, only validate first 40 for preview, but estimate totals via sampling if huge
    const limit = Math.min(parsed.rows.length, 40);
    for (let i =0;i<limit;i++){
      const r=parsed.rows[i];
      const payload={ Location:r[0], 'NOTAM #':r[1], Class:r[2], 'Issue Date':r[3], 'Effective Date':r[4], 'Expiration Date':r[5], 'NOTAM Text':r[6] };
       const v=firNotamValidate(payload);
       let isDup=null;
      if (v.ok) {
        const key = String(v.Location||'').trim().toUpperCase() + '|' + String(v['NOTAM #']||'').trim().toUpperCase();
        if (keySet[key] || seenInBatch[key]) isDup='FIR/NOTAM';
        else seenInBatch[key]=true;
        if (isDup) dup++;
        else valid++;
      } else invalid++;
      preview.push({
        Location:r[0], 'NOTAM #':r[1], Class:r[2], 'Issue Date':r[3], 'Effective Date':r[4], 'Expiration Date':r[5],
        ok: v.ok && !isDup,
        error: v.error || (isDup? ('Already exists in '+isDup):''),
        textPreview: String(r[6]||'').substring(0,80).replace(/\n/g,' ')
      });
    }
    // If more than 40, do quick pass for totals without building preview (still uses in-memory set)
    if (parsed.rows.length > 40) {
      for (let k =40;k<parsed.rows.length;k++){
        const rk=parsed.rows[k];
        const pay={ Location:rk[0], 'NOTAM #':rk[1], Class:rk[2], 'Issue Date':rk[3], 'Effective Date':rk[4], 'Expiration Date':rk[5], 'NOTAM Text':rk[6] };
        const vv=firNotamValidate(pay);
        if (!vv.ok) { invalid++; continue; }
        const key2 = String(vv.Location||'').trim().toUpperCase() + '|' + String(vv['NOTAM #']||'').trim().toUpperCase();
        if (keySet[key2] || seenInBatch[key2]) dup++;
        else { valid++; seenInBatch[key2]=true; }
        // safety: abort if approaching 25s
        if (new Date().getTime() - startMs > 25000) {
          return { ok:true, total:parsed.rows.length, valid:valid, invalid:invalid, duplicates:dup, isTSV:parsed.isTSV, preview:preview, truncated:true, note:'Preview truncated after 25s — counts estimated for first '+(k+1)+' rows' };
        }
      }
    }
    return { ok:true, total:parsed.rows.length, valid:valid, invalid:invalid, duplicates:dup, isTSV:parsed.isTSV, preview:preview };
  } catch(e){
    return { ok:false, error:e.message };
  }
}

/**
 * Execute bulk append to FIR sheet (skips invalid + duplicates).
 * mode: 'append' (default) or 'overwrite'
 * Returns { ok, total, appended, skippedInvalid, skippedDup }
 * @expose
 */
function firBulkImportNotams(rawText, mode) {
  try {
    requireAuthorized();
    if (!mode) mode='append';
    const parsed=firParseBulkNotamText(rawText);
    if(!parsed.ok) return parsed;
    if(parsed.rows.length===0) return { ok:false, error:'No valid NOTAMs found. Make sure text contains Q) lines.' };
    const sheet=getActiveSS().getSheetByName('FIR');
    if(!sheet) return { ok:false, error:"Sheet 'FIR' not found." };
    const lock=LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      if (mode==='overwrite') {
        sheet.clearContents();
      }
      // Build once
       const keySet2 = firGetExistingNotamKeySet_();
       const seenBatch2 = {};
       let appended=0, skippedInvalid=0, skippedDup=0;
      // Batch append via array for speed (instead of appendRow per row)
      const toAppend = [];
      for (let i =0;i<parsed.rows.length;i++){
        const r=parsed.rows[i];
        const payload={ Location:r[0], 'NOTAM #':r[1], Class:r[2], 'Issue Date':r[3], 'Effective Date':r[4], 'Expiration Date':r[5], 'NOTAM Text':r[6] };
        const v=firNotamValidate(payload);
        if(!v.ok){ skippedInvalid++; continue; }
        const key = String(v.Location||'').trim().toUpperCase() + '|' + String(v['NOTAM #']||'').trim().toUpperCase();
        if (keySet2[key] || seenBatch2[key]) { skippedDup++; continue; }
        seenBatch2[key]=true;
        toAppend.push([v.Location, v['NOTAM #'], v.Class, v['Issue Date'], v['Effective Date'], v['Expiration Date'], v['NOTAM Text']]);
        // also mark in keySet to catch dup within batch
        keySet2[key]=true;
      }
      if (toAppend.length>0) {
        const startRow = sheet.getLastRow()+1;
        sheet.getRange(startRow, 1, toAppend.length, FIR_NOTAM_COLS).setValues(toAppend);
        appended = toAppend.length;
      }
      if(appended>0){
        firClearNotamCache();
        try{ if(typeof firClearNotamDependentCache==='function') firClearNotamDependentCache(); }catch(e){}
      }
      const res={ ok:true, total:parsed.rows.length, appended:appended, skippedInvalid:skippedInvalid, skippedDup:skippedDup, mode:mode, isTSV:parsed.isTSV };
      console.log(JSON.stringify(res, null, 2));
      try{ Logger.log(JSON.stringify(res)); }catch(e){}
      return res;
    } finally { lock.releaseLock(); }
  } catch(e){
    return { ok:false, error:e.message };
  }
}


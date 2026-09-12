/**
 * FULL SCRIPT: Dispatch IO - CBR & Advanced NOTAM Report [V2]
 * Architect: Elite Flight Dispatch Systems
 * Upgrades: O(1) Map indexing, ES6 Set deduplication, Lido-standard reporting, V8 Optimized.
 */

// ========================
// HELPER FUNCTIONS
// ========================

const cleanAviationText = (rawText) => {
  if (!rawText) return "";
  return String(rawText)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
};

const cleanTafHeader = (tafText) => tafText ? cleanAviationText(tafText) : "";

// ========================
// TAF FETCHING ENGINE
// ========================

const fetchBulkTafData = (stationsArray, tafSheetData) => {
  const uniqueStations = [...new Set(stationsArray.map(s => String(s).trim().toUpperCase()).filter(s => s.length >= 3))];
  const tafMap = {};
  
  if (uniqueStations.length === 0) return tafMap;

  // Initialize Map
  uniqueStations.forEach(s => tafMap[s] = `NIL TAF DATA FOR ${s}`);

  const isComplete = () => Object.values(tafMap).every(val => !val.includes("NIL TAF"));

  // 1) Attempt RAW format fetch
  if (!isComplete()) attemptRawFormat(uniqueStations, tafMap);

  // 2) Attempt Alternative JSON Endpoint
  if (!isComplete()) attemptAltJsonEndpoint(uniqueStations, tafMap);

  // 3) Attempt Main JSON Endpoint
  if (!isComplete()) attemptMainJsonEndpoint(uniqueStations, tafMap);

  // 4) BULLETPROOF FALLBACK: Local Sheet Database
  if (!isComplete() && tafSheetData && tafSheetData.length > 0) {
    const localTafDict = new Map();
    tafSheetData.forEach(row => {
      const stn = String(row[0]).trim().toUpperCase();
      if (stn) localTafDict.set(stn, cleanTafHeader(row[1]));
    });
    uniqueStations.forEach(stn => {
      if (tafMap[stn].includes("NIL TAF") && localTafDict.has(stn)) {
        tafMap[stn] = localTafDict.get(stn);
      }
    });
  }

  return tafMap;
};

const attemptRawFormat = (stations, tafMap) => {
  try {
    const url = `https://aviationweather.gov/api/data/taf?ids=${stations.join(",")}&format=raw&hours=24`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/plain" } });
    if (res.getResponseCode() !== 200) return false;
    
    const text = res.getContentText();
    if (!text || text.trim().length < 10) return false;
    const blocks = text.split(/(?=\bTAF\s)/);
    blocks.forEach(block => {
      const bTrim = block.trim();
      if (!bTrim) return;
      const m = bTrim.match(/^TAF\s+(?:AMD\s+|COR\s+)?([A-Z]{4})/i);
      if (m) tafMap[m[1].toUpperCase()] = cleanTafHeader(bTrim);
    });
    return true;
  } catch (e) {
    console.warn("API RAW Fetch Failed: " + e.message);
    return false;
  }
};

const processJsonPayload = (jsonText, tafMap) => {
  const json = JSON.parse(jsonText);
  const items = Array.isArray(json) ? json : (json.data || []);
  items.forEach(item => {
    const id = item.icaoId || item.icao || item.stationId || item.icao_code;
    const raw = item.rawOb || item.rawTAF || item.rawTaf || item.raw_text || item.raw;
    if (id && raw) tafMap[String(id).toUpperCase()] = cleanTafHeader(raw);
  });
};

const attemptAltJsonEndpoint = (stations, tafMap) => {
  try {
    const url = `https://aviationweather.gov/api/data/taf?ids=${stations.join(",")}&format=json&hours=12`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
    if (res.getResponseCode() === 200) {
      processJsonPayload(res.getContentText(), tafMap);
      return true;
    }
    return false;
  } catch (e) {
    console.warn("API ALT JSON Fetch Failed: " + e.message);
    return false;
  }
};

const attemptMainJsonEndpoint = (stations, tafMap) => {
  try {
    const url = `https://aviationweather.gov/api/data/taf?ids=${stations.join(",")}&format=json&hours=24`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
    if (res.getResponseCode() === 200) {
      processJsonPayload(res.getContentText(), tafMap);
      return true;
    }
    return false;
  } catch (e) {
    console.warn("API MAIN JSON Fetch Failed: " + e.message);
    return false;
  }
};

// ========================
// NOTAM FUNCTIONS
// ========================

const parseNotamIntelligence = (rawText) => {
  const text = String(rawText).toUpperCase();
  let severityLevel = "LOW";
  let impactLevel = "GENERAL INFORMATION / ADVISORY";
  let instr = "REFER TO FULL TEXT";

  if (text.match(/CLSD|CLOSED|U\/S|UNSERVICEABLE|NOT AVBL|INOP|PROHIBITED/)) {
    severityLevel = "HIGH";
    impactLevel = "FACILITY UNAVAILABLE / RESTRICTION";
  } else if (text.match(/WIP|MAINTENANCE|DOWNGRADED|MODIFIED|CHG|DELAY/)) {
    severityLevel = "MEDIUM";
    impactLevel = "REDUCED CAPACITY / OPERATION MODIFIED";
  }

  const instrMatch = text.match(/(?:CTC|CONTACT|CAUTION|EXPECT|REQ|REQUIRE|RMK)[^\.]*(\.|$)/);
  if (instrMatch) instr = instrMatch[0].trim();

  const summaryText = text.split('\n').join(' ').substring(0, 100) + "...";
  return { severity: severityLevel, impact: impactLevel, instructions: instr, summary: summaryText, fullText: text };
};

// ========================
// MAIN BRIEFING GENERATOR
// ========================

function generateBriefingPackage(flightsArray, savedNotamAnalysis, noSigMap) {
  try {
    requireAuthorized();
    // normalize NO SIG map (per-flight A, prioritas B)
    noSigMap = (noSigMap && typeof noSigMap === 'object' && !Array.isArray(noSigMap)) ? noSigMap : {};
    const ss = getActiveSS();
    const totalFlights = flightsArray.length;
    if (totalFlights === 0) throw new Error("No flights provided.");

    let templateName = "";
    if (totalFlights === 1) templateName = "CBR1";
    else if (totalFlights === 2) templateName = "CBR2";
    else if (totalFlights === 3 || totalFlights === 4) templateName = "CBR4";
    // Smart fallback
    else throw new Error("Maximum 4 flights supported.");
    
    const templateSheet = ss.getSheetByName(templateName);
    if (!templateSheet) throw new Error(`Template sheet ${templateName} is missing from the database.`);
    
    const timeStamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "ddMMyy_HHmm");
    const fltNames = flightsArray.map(f => f.FLIGHT);
    
    const newSpreadsheet = SpreadsheetApp.create(`RELEASE_CBR_${fltNames.join('-')}_${timeStamp}`);
    const targetSheet = templateSheet.copyTo(newSpreadsheet);
    targetSheet.setName("Crew Briefing Report");
    const allSheets = newSpreadsheet.getSheets();
    if (allSheets.length > 1) newSpreadsheet.deleteSheet(allSheets[0]);

    const tafSheetData = ss.getSheetByName('TAF') ? ss.getSheetByName('TAF').getDataRange().getValues() : [];
    const rawNotamData = ss.getSheetByName('NOTAM') ? ss.getSheetByName('NOTAM').getDataRange().getValues() : [];

    const formatAndSetCellCoord = (r, c, val, wrap, isAviation = false) => {
      if (!val || r <= 0 || c <= 0) return;
      const rng = targetSheet.getRange(r, c);
      rng.setValue(val);
      rng.setFontFamily("Courier New");
      rng.setFontSize(13);
      rng.setVerticalAlignment("TOP");
      if (wrap || isAviation) rng.setWrap(true);
    };

    const formatA1 = (cell, val, isAviation) => {
      if (!val) return;
      const rng = targetSheet.getRange(cell);
      const r = rng.getRow();
      const c = rng.getColumn();
      formatAndSetCellCoord(r, c, val, isAviation, isAviation);
    };

    // Pad array safely
    const f = [flightsArray[0] || {}, flightsArray[1] || {}, flightsArray[2] || {}, flightsArray[3] || {}];

    // INJECT STATIC HEADER
    formatA1("T1", Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd-MMM-yyyy HH:mmZ"));
    
    const mapping = [
      { flt: "C5", reg: "C9", dep: "I5", std: "J5", arr: "I7", sta: "J7", alt: "Q5" },
      { flt: "D5", reg: null, dep: "I9", std: "J9", arr: "I11", sta: "J11", alt: "Q7" },
      { flt: "E5", reg: null, dep: "M5", std: "N5", arr: "M7", sta: "N7", alt: "Q9" },
      { flt: "F5", reg: null, dep: "M9", std: "N9", arr: "M11", sta: "N11", alt: "Q11" }
    ];

    f.forEach((leg, idx) => {
      if (leg.FLIGHT) formatA1(mapping[idx].flt, leg.FLIGHT);
      if (mapping[idx].reg && leg.REG) formatA1(mapping[idx].reg, leg.REG);
      if (leg.DEP) { formatA1(mapping[idx].dep, leg.DEP); formatA1(mapping[idx].std, leg.STD); }
      if (leg.ARR) { formatA1(mapping[idx].arr, leg.ARR); formatA1(mapping[idx].sta, leg.STA); }
      if (leg.ALT) formatA1(mapping[idx].alt, leg.ALT);
    });

    // 1. TAF INJECTION
    const preferredOrder = [...new Set(flightsArray.flatMap(fl => [fl.DEP, fl.ARR, fl.ALT, fl.ENR1, fl.ENR2, fl.ENR3]))]
      .filter(stn => stn && stn.trim() !== "")
      .map(stn => stn.trim().toUpperCase());
      
    const tafMap = fetchBulkTafData(preferredOrder, tafSheetData);

    for (let i = 0; i < 8; i++) {
      const rowC14 = 14 + i;
      if (i < preferredOrder.length) {
        formatA1(`C${rowC14}`, preferredOrder[i], false);
        formatA1(`D${rowC14}`, tafMap[preferredOrder[i]] || "NIL TAF DATA", true);
      } else {
        targetSheet.getRange(`C${rowC14}:D${rowC14}`).clearContent();
      }
    }

    // 2. GRID SCANNER & SIGNATURE BLOCK PROTECTOR
    const dataMatrix = targetSheet.getDataRange().getValues();
    const tafMapCoords = {};
    let notamStartRow = 30;
    let footerRow = 999;
    
    for (let row = 0; row < dataMatrix.length; row++) {
      for (let col = 0; col < dataMatrix[row].length; col++) {
        const cellVal = String(dataMatrix[row][col]).trim().toUpperCase();
        if (cellVal.match(/^P(OD|OA) \d$/)) {
          tafMapCoords[cellVal] = { r: row + 1, c: col + 1 };
        }
        
        if (cellVal.includes("SIGNIFICANT NOTAM")) {
          notamStartRow = row + 2;
        }
        
        if ((cellVal.includes("DXR") || cellVal.includes("PIC") || cellVal.includes("NAME / SIGN")) && row + 1 > 20 && row + 1 < footerRow) {
             footerRow = row + 1; // Lock signature block
        }
      }
    }

    // 3. POD/POA INJECTION
    flightsArray.forEach((flight, i) => {
        const podKey = `POD ${i + 1}`;
        if (flight.DEP && tafMapCoords[podKey]) {
            const { r, c } = tafMapCoords[podKey];
            formatAndSetCellCoord(r, c + 1, flight.DEP, false);    
            formatAndSetCellCoord(r, c + 2, flight.STD || "", false);
            formatAndSetCellCoord(r, c + 3, flight.TAF_DEP || "", false);   
        }
        
        const poaKey = `POA ${i + 1}`;
        if (flight.ARR && tafMapCoords[poaKey]) {
            const { r, c } = tafMapCoords[poaKey];
            formatAndSetCellCoord(r, c + 1, flight.ARR, false);                    
            formatAndSetCellCoord(r, c + 2, flight.STA || "", false);
            formatAndSetCellCoord(r, c + 3, flight.TAF_ARR || "", false);   
        }
    });

    // 4. NOTAM INJECTION (O(1) Indexed)
    try { 
      const rowsToClear = footerRow - notamStartRow - 1;
      if (rowsToClear > 0) targetSheet.getRange(notamStartRow, 3, rowsToClear, 15).clearContent();
    } catch(e) {
      console.warn("Minor grid reset error: " + e.message);
    }

    // Pre-index NOTAM DB for O(1) Lookups
    const notamDB = new Map();
    rawNotamData.forEach(row => {
        const stn = String(row[0]).trim().toUpperCase();
        const num = String(row[1]).trim();
        const key = `${stn}_${num}`;
        notamDB.set(key, cleanAviationText(row[6]));
    });

    const notamsByStation = {};
    const orderedStationsSet = new Set();
    const stationToFlights = {};

    flightsArray.forEach(flt => {
      [flt.DEP, flt.ARR, flt.ALT, flt.ENR1, flt.ENR2, flt.ENR3].forEach(stn => {
        if (!stn) return;
        const stnU = stn.trim().toUpperCase();
        orderedStationsSet.add(stnU);
        if (!notamsByStation[stnU]) notamsByStation[stnU] = [];
        if (!stationToFlights[stnU]) stationToFlights[stnU] = [];
        if (!stationToFlights[stnU].some(f => f.FLIGHT === flt.FLIGHT)) stationToFlights[stnU].push(flt);
        
        const selectedNotams = savedNotamAnalysis[String(flt.FLIGHT)] || [];
        selectedNotams.forEach(num => {
            const specificKey = `${stnU}_${num}`;
            const allKey = `ALL_${num}`;
            if (notamDB.has(specificKey) && !notamsByStation[stnU].includes(notamDB.get(specificKey))) {
                notamsByStation[stnU].push(notamDB.get(specificKey));
            } else if (notamDB.has(allKey) && !notamsByStation[stnU].includes(notamDB.get(allKey))) {
                notamsByStation[stnU].push(notamDB.get(allKey));
            }
        });
      });
    });

    // B1 per-station: if station empty & station flag true → NO SIGNIFICANT; actual NOTAM wins (B)
    // Also support legacy per-flight map: if station not flagged but a flight for that station is per-flight flagged, still NO SIG
    const NO_SIG_SENTINEL = "NO SIGNIFICANT NOTAM";
    Array.from(orderedStationsSet).forEach(stn => {
      if (notamsByStation[stn].length > 0) return;
      const stnU = String(stn).trim().toUpperCase();
      const isStationFlagged = !!noSigMap[stnU] || !!noSigMap[stn];
      if (isStationFlagged) { notamsByStation[stn] = [NO_SIG_SENTINEL]; return; }
      // legacy per-flight fallback
      const flightsForStn = stationToFlights[stn] || [];
      const hasFlightNoSig = flightsForStn.some(flt => !!noSigMap[flt.FLIGHT]);
      if (hasFlightNoSig) notamsByStation[stn] = [NO_SIG_SENTINEL];
    });

    let currentRowOffset = 0;
    Array.from(orderedStationsSet).forEach(stn => {
        const notamList = notamsByStation[stn];
        const rowForThisStation = notamStartRow + currentRowOffset;
        
        // AUTO-PUSH DOWN: Safe insertion
        if (rowForThisStation >= footerRow - 1) {
            targetSheet.insertRowBefore(footerRow);
            footerRow++; 
        }

        formatAndSetCellCoord(rowForThisStation, 3, stn, false);

        if (notamList.length === 0) {
            formatAndSetCellCoord(rowForThisStation, 4, "NIL OPERATIONAL NOTAM.", true);
        } else if (notamList.length === 1 && notamList[0] === NO_SIG_SENTINEL) {
            formatAndSetCellCoord(rowForThisStation, 4, "NO SIGNIFICANT NOTAM", true);
        } else {
            const halfLength = Math.ceil(notamList.length / 2);
            const leftNotams = notamList.slice(0, halfLength).join("\n\n");
            const rightNotams = notamList.slice(halfLength).join("\n\n");

            if (leftNotams) formatAndSetCellCoord(rowForThisStation, 4, leftNotams, true);
            if (rightNotams) formatAndSetCellCoord(rowForThisStation, 12, rightNotams, true);
        }
        currentRowOffset++;
    });

    return { status: "SUCCESS", message: "Briefing successfully compiled.", url: newSpreadsheet.getUrl() };
  } catch (e) {
    return { status: "ERROR", message: e.toString() };
  }
}

// ========================
// PREVIEW DATA (HTML)
// ========================

function getPreviewData(flightsArray, savedNotamAnalysis, noSigMap) {
  noSigMap = (noSigMap && typeof noSigMap === 'object' && !Array.isArray(noSigMap)) ? noSigMap : {};
  const ss = getActiveSS();
  const tafSheetData = ss.getSheetByName('TAF') ? ss.getSheetByName('TAF').getDataRange().getValues() : [];
  const rawNotamData = ss.getSheetByName('NOTAM') ? ss.getSheetByName('NOTAM').getDataRange().getValues() : [];

  const payload = { 
    flightHeaders: [], rolesMap: [], tafs: [], structuredNotams: [], matrix: { HIGH: 0, MEDIUM: 0, LOW: 0, NO_SIG: 0 }
  };
  
  const stList = flightsArray.flatMap(f => [f.DEP, f.ARR, f.ALT, f.ENR1, f.ENR2, f.ENR3].filter(Boolean));
  const tafMap = fetchBulkTafData(stList, tafSheetData);
  const tafDone = new Set();
  
  // Pre-index NOTAM DB
  const notamDB = new Map();
  rawNotamData.forEach(row => {
      notamDB.set(`${String(row[0]).trim().toUpperCase()}_${String(row[1]).trim()}`, row);
  });

  flightsArray.forEach(flight => {
    payload.flightHeaders.push({
      FLIGHT: flight.FLIGHT, DOF: flight.DOF, STD: flight.STD, STA: flight.STA, REG: flight.REG,
      TIME_WINDOW: `${flight.STD} - ${flight.STA} UTC`
    });

    const nodes = [
      { stn: flight.DEP, role: "DEP" }, { stn: flight.ARR, role: "DEST" },
      { stn: flight.ALT, role: "ALTN" }, { stn: flight.ENR1, role: "ENR ALT" },
      { stn: flight.ENR2, role: "ENR ALT" }, { stn: flight.ENR3, role: "ENR ALT" }
    ];

    nodes.forEach(node => {
      if (!node.stn) return;
      const stnU = node.stn.trim().toUpperCase();
      
      if (!payload.rolesMap.some(r => r.stn === stnU && r.role === node.role)) {
        payload.rolesMap.push({ role: node.role, stn: stnU, flt: flight.FLIGHT });
      }
      
      if (!tafDone.has(stnU)) {
        tafDone.add(stnU);
        payload.tafs.push({ stn: stnU, text: tafMap[stnU] || "NIL TAF DATA" });
      }

      const selected = savedNotamAnalysis[String(flight.FLIGHT)] || [];
      
      selected.forEach(num => {
        const key = `${stnU}_${num}`;
        if (notamDB.has(key) && !payload.structuredNotams.some(sn => sn.id === num)) {
          const found = notamDB.get(key);
          const intel = parseNotamIntelligence(found[6]);
          payload.matrix[intel.severity]++;
          payload.structuredNotams.push({
            phase: node.role, aerodrome: stnU, id: num, summary: intel.summary,
            impact: intel.impact, instructions: intel.instructions, severity: intel.severity, flight: flight.FLIGHT
          });
        }
      });
    });
    // legacy per-flight NO SIG (A) — keep for old keys
    var isNoSig = !!noSigMap[flight.FLIGHT];
    var hasSel = (savedNotamAnalysis[flight.FLIGHT]||[]).length>0;
    if(isNoSig && !hasSel){
      payload.matrix.NO_SIG++;
      payload.matrix.LOW++;
      payload.structuredNotams.push({
        phase: "BRIEF", aerodrome: flight.DEP||"—", id: "NO SIG", summary: "NO SIGNIFICANT NOTAM — "+flight.FLIGHT+" assessed nil significant",
        impact: "NO SIGNIFICANT", instructions: "NIL SIGNIFICANT", severity: "LOW", flight: flight.FLIGHT
      });
    }
  });
  // B1 per-station NO SIG: station flagged & no real NOTAM for that station → synthetic (DEP WIII / ARR WADD may differ)
  (function(){
    const flaggedStations = Object.keys(noSigMap).filter(k => /^[A-Z]{4}$/.test(String(k).trim().toUpperCase()) && !!noSigMap[k]);
    const allStations = new Set(stList.map(s=> String(s).trim().toUpperCase()).filter(Boolean));
    flaggedStations.forEach(stn => {
      const stnU = String(stn).trim().toUpperCase();
      if(!allStations.has(stnU)) return;
      const hasActualForStn = payload.structuredNotams.some(sn => sn.aerodrome===stnU && sn.id!=="NO SIG");
      if(hasActualForStn) return;
      if(payload.structuredNotams.some(sn => sn.aerodrome===stnU && sn.id==="NO SIG")) return;
      payload.matrix.NO_SIG++;
      payload.matrix.LOW++;
      payload.structuredNotams.push({
        phase: "BRIEF", aerodrome: stnU, id: "NO SIG", summary: "NO SIGNIFICANT NOTAM — "+stnU+" assessed",
        impact: "NO SIGNIFICANT", instructions: "NIL SIGNIFICANT", severity: "LOW", flight: "—"
      });
    });
  })();

  return payload;
}
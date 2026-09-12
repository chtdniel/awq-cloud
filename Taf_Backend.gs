/**
 * TAF MANAGEMENT BACKEND
 * Handles reading, writing, and fetching TAF data from external APIs.
 */

/**
 * Fetches all TAF data from the 'TAF' sheet.
 */
function getTafData() {
  const ss = getActiveSS();
  let sheet = ss.getSheetByName('TAF');
  if (!sheet) {
    sheet = ss.insertSheet('TAF');
    sheet.appendRow(['STATION', 'RAW_TAF', 'TIMESTAMP']);
    return [];
  }
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1).map(row => ({
    STATION: String(row[0] || "").trim().toUpperCase(),
    RAW_TAF: String(row[1] || "").trim(),
    TIMESTAMP: row[2] ? Utilities.formatDate(new Date(row[2]), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'") : ""
  }));
}

/**
 * Saves/Overwrites the 'TAF' sheet with provided data.
 * Includes duplicate protection and ensures consistent timestamping.
 */
function saveTafData(tafArray) {
  requireAuthorized();
  const ss = getActiveSS();
  let sheet = ss.getSheetByName('TAF');
  
  if (!sheet) {
    sheet = ss.insertSheet('TAF');
  }
  
  sheet.clearContents();
  sheet.appendRow(['STATION', 'RAW_TAF', 'TIMESTAMP']);
  
  if (tafArray && tafArray.length > 0) {
    // Server-side Duplicate Protection & Normalization
    const seen = new Set();
    const uniqueTafs = [];
    
    tafArray.forEach(item => {
      const icao = String(item.STATION || "").trim().toUpperCase();
      if (icao && !seen.has(icao)) {
        seen.add(icao);
        uniqueTafs.push(item);
      }
    });

    const matrix = uniqueTafs.map(item => {
      let ts = item.TIMESTAMP;
      if (!ts || ts === "---") {
        ts = new Date();
      } else if (typeof ts === 'string') {
        var s = String(ts).trim();
        // Accept UTC ISO with Z; otherwise treat "yyyy-MM-dd HH:mm:ss" as UTC
        var iso = s.replace(' ', 'T').replace(/\//g, '-');
        if (iso.slice(-1) !== 'Z' && iso.indexOf('+') === -1 && /T\d{2}:\d{2}/.test(iso)) iso += 'Z';
        var parsed = new Date(iso);
        ts = !isNaN(parsed.getTime()) ? parsed : new Date();
      }
      return [
        String(item.STATION || "").toUpperCase(),
        item.RAW_TAF || "",
        ts
      ];
    });
    
    if (matrix.length > 0) {
      sheet.getRange(2, 1, matrix.length, 3).setValues(matrix);
    }
  }
  
  return { status: "SUCCESS", message: "TAF Database Updated" };
}

/**
 * Fetches the latest TAF from AviationWeather.gov for a list of stations.
 * Retries up to 2 times on transient errors and returns a structured result.
 */
function fetchLatestTafFromApi(icaoList) {
  if (!icaoList || icaoList.length === 0) return { error: 'No stations provided.' };
  
  const stations = icaoList.map(s => s.trim().toUpperCase()).filter(s => s.length >= 3);
  const tafMap = {};
  const MAX_RETRIES = 2;
  
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const url = `https://aviationweather.gov/api/data/taf?ids=${stations.join(",")}&format=raw`;
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      
      if (res.getResponseCode() === 200) {
        const text = res.getContentText();
        if (!text || text.trim().length < 10) {
          if (attempt <= MAX_RETRIES) { Utilities.sleep(2000 * attempt); continue; }
          return { error: 'Empty response from API.' };
        }
        const blocks = text.split(/(?=\bTAF\s)/);
        blocks.forEach(block => {
          const bTrim = block.trim();
          if (!bTrim) return;
          const m = bTrim.match(/^TAF\s+(?:AMD\s+|COR\s+)?([A-Z]{4})/i);
          if (m) tafMap[m[1].toUpperCase()] = bTrim;
        });
        return tafMap;
      }
      
      if (attempt <= MAX_RETRIES) {
        Utilities.sleep(2000 * attempt);
        continue;
      }
      return { error: 'API returned HTTP ' + res.getResponseCode() + '.' };
    } catch (e) {
      if (attempt <= MAX_RETRIES) {
        Utilities.sleep(2000 * attempt);
        continue;
      }
      console.error("Fetch Error: " + e.message);
      return { error: 'Network error: ' + e.message };
    }
  }
  
  return { error: 'Unexpected failure.' };
}

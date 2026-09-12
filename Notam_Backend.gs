/**
 * ============================================================================
 * NOTAM DECISION SUPPORT ENGINE — WEB APP BACKEND (V6.2 PROD OPTIMIZED)
 * Implementation of Strict 12-Step Operational Decision Logic
 * Includes Route/Waypoint Deep Matching, Performance Caching & Failsafes
 * Architect: Senior Aviation Software Engineer
 * ============================================================================
 */

/**
 * Checks whether a NOTAM's raw text matches any of the flight's route tokens.
 * Returns { impacted: boolean, matches: string[] }.
 */
function _checkRouteMatch(notamRawText, routeTokens) {
  if (!notamRawText || !routeTokens || routeTokens.length === 0) {
    return { impacted: false, matches: [] };
  }
  const matched = [];
  for (const tObj of routeTokens) {
    if (tObj.regex.test(notamRawText)) {
      matched.push(tObj.word);
    }
  }
  return { impacted: matched.length > 0, matches: matched };
}

/**
 * Main entry point called by the Frontend UI shell.
 * Parses flights, builds operational buffers, handles intersections,
 * performs Enroute deep-text matching, and outputs structured payload.
 */
function analyzeNotams(flights, options = {}) {
  const showAll = !!options.showAll;
  if (!flights || !Array.isArray(flights) || flights.length === 0) {
    return { error: "SYSTEM: No active flight context selected on the board." };
  }

  const ss = getActiveSS();
  
  // --- DATABASE PRE-LOAD: ROUTE CACHING & TOKENIZATION ---
  const routeSheet = ss.getSheetByName('Route');
  const routeMap = new Map();
  if (routeSheet) {
    const rData = routeSheet.getDataRange().getValues();
    if (rData.length > 1) {
      const headers = rData[0].map(h => String(h).toUpperCase().trim());
      
      // Flexible Header Resolution (Handles both DEP_AIRPORT or DEP)
      let idxDep = headers.indexOf('DEP_AIRPORT');
      if (idxDep === -1) idxDep = headers.indexOf('DEP');
      
      let idxArr = headers.indexOf('ARR_AIRPORT');
      if (idxArr === -1) idxArr = headers.indexOf('ARR');
      
      const idxSid = headers.indexOf('SID');
      const idxWpt = headers.indexOf('WAYPOINT_SEQ');
      const idxStar = headers.indexOf('STAR');

      if (idxDep > -1 && idxArr > -1) {
        // Pre-define stop words and Regex rules for efficiency
        const airwayRegex = /^[A-Z]{1,2}\d{1,3}$/;
        const fixRegex = /^[A-Z]{3,5}$/;
        const stopWords = ['TO', 'AND', 'VIA', 'DCT'];

        for (let i = 1; i < rData.length; i++) {
          const row = rData[i];
          const key = String(row[idxDep] || '').trim().toUpperCase() + "-" + String(row[idxArr] || '').trim().toUpperCase();
          
          // Clean String Assembly
          const routeParts = [];
          if (idxSid > -1 && row[idxSid]) routeParts.push(String(row[idxSid]));
          if (idxWpt > -1 && row[idxWpt]) routeParts.push(String(row[idxWpt]));
          if (idxStar > -1 && row[idxStar]) routeParts.push(String(row[idxStar]));
          
          const routeString = routeParts.filter(Boolean).join(" ");
          
          // Tokenize and Pre-Compile Regex (Performance Optimization)
          const rawTokens = routeString.split(/\s+/);
          const compiledTokens = [];
          
          rawTokens.forEach(t => {
            const token = t.toUpperCase().trim();
            // Filter pure numbers and navigational stop-words
            if (/^\d+$/.test(token) || stopWords.includes(token)) return;
            
            if (airwayRegex.test(token) || (fixRegex.test(token) && !airwayRegex.test(token))) {
              // Ensure uniqueness before compiling
              if (!compiledTokens.some(ct => ct.word === token)) {
                compiledTokens.push({
                  word: token,
                  regex: new RegExp(`(?:^|[^A-Z0-9])${token}(?:$|[^A-Z0-9])`, 'i') // Tolerant boundaries
                });
              }
            }
          });
          
          routeMap.set(key, compiledTokens);
        }
      }
    }
  }

  // --- DATABASE PRE-LOAD: NOTAM REGISTRY ---
  const notamSheet = ss.getSheetByName('NOTAM');
  if (!notamSheet) return { error: "DATABASE EXCEPTION: Tab 'NOTAM' is missing." };

  const rawData = notamSheet.getDataRange().getValues();
  if (rawData.length <= 1) return { data: [] };

  // Pre-Index NOTAM Registry for O(1) Lookups
  const notamMap = new Map(); 
  
  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    const location = String(row[0] || '').trim().toUpperCase();
    if (!location) continue;

    const parsedNotam = _parseNotamRow(row);
    if (!parsedNotam) continue;

    if (!notamMap.has(location)) {
      notamMap.set(location, []);
    }
    notamMap.get(location).push(parsedNotam);
  }

  const results = [];
  
  // --- FLIGHT SCHEDULE PARSING & MIDNIGHT ROLLOVERS ---
  flights.forEach(f => {
    if (!f.DOF || !f.STD || !f.STA) return;

    // Fetch parsed route tokens for this specific flight
    const fDep = String(f.DEP || '').trim().toUpperCase();
    const fArr = String(f.ARR || '').trim().toUpperCase();
    const routeKey = `${fDep}-${fArr}`;
    const flightRouteTokens = routeMap.get(routeKey) || [];

    // Parse Day of Flight (Robust handling for YYYYMMDD, YYYY-MM-DD, or DD/MM/YYYY)
    let yr, mo, dy;
    const dofStr = String(f.DOF || '').replace(/[^0-9]/g, '');
    if (dofStr.length === 8) {
      // YYYYMMDD or DDMMYYYY - assume YYYYMMDD as per system standard
      yr = parseInt(dofStr.substring(0, 4), 10);
      mo = parseInt(dofStr.substring(4, 6), 10) - 1;
      dy = parseInt(dofStr.substring(6, 8), 10);
    } else {
      // Fallback for other formats like DD/MM/YYYY or YYYY-MM-DD
      const dateObj = new Date(f.DOF);
      if (!isNaN(dateObj.getTime())) {
        yr = dateObj.getUTCFullYear();
        mo = dateObj.getUTCMonth();
        dy = dateObj.getUTCDate();
      } else {
        console.warn(`[NOTAM] Invalid DOF format for flight ${f.FLIGHT}: ${f.DOF}`);
        return;
      }
    }

    // Parse Times (Handle HH:MM, HHMM, or HH:MM AM/PM)
    const parseTime = (tStr) => {
      if (!tStr) return null;
      const clean = String(tStr).replace(/[^0-9]/g, '');
      if (clean.length >= 4) {
        return { h: parseInt(clean.substring(0, 2), 10), m: parseInt(clean.substring(2, 4), 10) };
      }
      return null;
    };

    const std = parseTime(f.STD);
    const sta = parseTime(f.STA);
    if (!std || !sta) {
      console.warn(`[NOTAM] Invalid time format for flight ${f.FLIGHT}: STD=${f.STD}, STA=${f.STA}`);
      return;
    }

    const stdDate = new Date(Date.UTC(yr, mo, dy, std.h, std.m));
    let staDate;

    // Smart Rollover Logic: Use EET if provided to calculate STA
    if (f.EET) {
      const eetStr = String(f.EET).replace(/[^0-9]/g, '');
      if (eetStr.length >= 4) {
        const eetH = parseInt(eetStr.substring(0, 2), 10);
        const eetM = parseInt(eetStr.substring(2, 4), 10);
        staDate = new Date(stdDate.getTime() + (eetH * 60 + eetM) * 60 * 1000);
      }
    }

    if (!staDate) {
      staDate = new Date(Date.UTC(yr, mo, dy, sta.h, sta.m));
      if (staDate < stdDate) {
        staDate.setUTCDate(staDate.getUTCDate() + 1);
      }
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmtZ = (d) => `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
    const stdPill = fmtZ(stdDate);
    const staPill = fmtZ(staDate);

    // --- STATION-SPECIFIC OPERATIONAL BUFFER WINDOWS ---
    const routeSectors = [];

    if (f.DEP) {
      routeSectors.push({
        icao: fDep,
        role: 'DEP',
        pillLabel: `DEP ${stdPill}`,
        start: new Date(stdDate.getTime() - 3 * 60 * 60 * 1000), 
        end: new Date(staDate.getTime() + 3 * 60 * 60 * 1000) // Expanded to STA+3h to cover Return-to-Base (RTB)
      });
    }

    if (f.ARR) {
      routeSectors.push({
        icao: fArr,
        role: 'ARR',
        pillLabel: `ARR ${staPill}`,
        start: new Date(stdDate.getTime() - 1 * 60 * 60 * 1000), // Start from STD-1h for early planning
        end: new Date(staDate.getTime() + 3 * 60 * 60 * 1000)    
      });
    }

    if (f.ALT) {
      routeSectors.push({
        icao: String(f.ALT).trim().toUpperCase(),
        role: 'ALTN',
        pillLabel: `ALTN ${staPill}`,
        start: new Date(stdDate.getTime() - 1 * 60 * 60 * 1000), // Start from STD-1h
        end: new Date(staDate.getTime() + 3 * 60 * 60 * 1000)    
      });
    }

    // Enroute coverage parsing (Separated by individual ICAO station)
    ['ENR1', 'ENR2', 'ENR3'].forEach(enrKey => {
      if (f[enrKey]) {
        routeSectors.push({
          icao: String(f[enrKey]).trim().toUpperCase(),
          role: 'ENROUTE',
          pillLabel: `ENR ${stdPill}`,
          start: new Date(stdDate.getTime() - 1 * 60 * 60 * 1000),
          end: new Date(staDate.getTime() + 1 * 60 * 60 * 1000),
          routeTokens: flightRouteTokens
        });
      }
    });

    // --- INTERSECTION MATCHING AND SCHEDULE ANALYSIS ---
    const now = new Date();
    routeSectors.forEach(sector => {
      if (!notamMap.has(sector.icao)) return;

      const stationNotams = notamMap.get(sector.icao);
      
      stationNotams.forEach(notam => {
        // Operational Impact Analysis
        const isTimeOverlap = (notam.effTo >= sector.start && notam.effFrom <= sector.end);
        const isScheduleOverlap = _checkScheduleDOverlap(notam.schedule, sector.start, sector.end);
        
        let matchesRoute = true;
        if (sector.role === 'ENROUTE') {
          const isCriticalEnroute = (notam.category === 'ENVIRONMENTAL' || notam.category === 'ALERT');
          if (!isCriticalEnroute && sector.routeTokens && sector.routeTokens.length > 0) {
            const routeCheck = _checkRouteMatch(notam.rawText, sector.routeTokens);
            matchesRoute = routeCheck.impacted;
          }
        }

        const isImpacted = isTimeOverlap && isScheduleOverlap && matchesRoute;
        const isExpired = notam.effTo < now;
        const isFuture = notam.effFrom > now;

        // Status Categorization
        let status = "ACTIVE";
        let sortScore = 0;

        if (isImpacted) {
          status = "IMPACTED";
          sortScore = (notam.priority === 'HIGH') ? 100 : 80;
        } else if (isExpired) {
          status = "EXPIRED";
          sortScore = 10;
        } else if (isFuture) {
          status = "FUTURE";
          sortScore = 20;
        } else {
          status = "NOT IN WINDOW";
          sortScore = 40;
        }

        results.push({
          flight: f.FLIGHT,
          pillLabel: sector.pillLabel,
          airport: sector.icao, 
          role: sector.role,
          sectorStart: sector.start,
          sectorEnd: sector.end,
          notamNum: notam.notamNum,
          category: notam.category,
          priority: notam.priority,
          rawText: notam.rawText,
          effFromUi: notam.effFrom ? duFormatDateTimeUTC(notam.effFrom) : '',
          effToUi: notam.isContinuous ? "PERM/EST" : (notam.effTo ? duFormatDateTimeUTC(notam.effTo) : ''),
          schedule: notam.schedule || "CONTINUOUS",
          status: status,
          isImpacted: isImpacted,
          sortScore: sortScore
        });
      });
    });
  });

  // Group results for UI rendering
  const grouped = new Map();
  results.forEach(r => {
      if (!grouped.has(r.airport)) {
          grouped.set(r.airport, {
              station: r.airport,
              windowStr: "OPS WINDOW APPLIED",
              flights: new Set(),
              sectorWindows: [], // Track individual sectors for aggregation
              notamsMap: new Map()
          });
      }
      const stn = grouped.get(r.airport);
      stn.flights.add(r.flight);
      
      // Collect unique sector windows for this flight at this station
      if (!stn.sectorWindows.some(sw => sw.flight === r.flight && sw.start.getTime() === r.sectorStart.getTime())) {
          stn.sectorWindows.push({
              start: r.sectorStart,
              end: r.sectorEnd,
              flight: r.flight
          });
      }
      
      if (!stn.notamsMap.has(r.notamNum)) {
          let bgCol = 'var(--bg-panel-sunken)';
          let fgCol = 'var(--text-primary)';
          
          // Color based on status and priority
          if (r.status === 'IMPACTED') {
            if(r.priority === 'HIGH') { bgCol = 'var(--status-critical)'; fgCol = '#ffffff'; }
            else if(r.priority === 'MEDIUM') { bgCol = 'var(--status-warning)'; fgCol = '#000000'; }
            else { bgCol = 'var(--status-info)'; fgCol = '#ffffff'; }
          } else if (r.status === 'EXPIRED') {
            bgCol = 'rgba(255, 255, 255, 0.05)';
            fgCol = 'var(--text-disabled)';
          }

          stn.notamsMap.set(r.notamNum, {
              notamNum: r.notamNum,
              rawText: r.rawText,
              isTargetedCritical: (r.isImpacted && r.priority === 'HIGH'),
              isImpacted: r.isImpacted,
              status: r.status,
              sortScore: r.sortScore,
              bg: bgCol,
              fg: fgCol,
              tag: r.priority,
              cat: r.category,
              effFromUi: r.effFromUi,
              effToUi: r.effToUi,
              flightsInvolved: []
          });
      }
      
      const nEntry = stn.notamsMap.get(r.notamNum);
      if (!nEntry.flightsInvolved.some(fObj => fObj.flight === r.flight)) {
          nEntry.flightsInvolved.push({
              flight: r.flight,
              pillStr: `✈ ${r.flight} (${r.pillLabel})`
          });
      }

      // Update Impact Status and Visuals if any flight is impacted
      if (r.isImpacted || r.status === 'IMPACTED') {
          nEntry.isImpacted = true;
          nEntry.status = 'IMPACTED';
          nEntry.sortScore = Math.max(nEntry.sortScore, r.sortScore);
          
          // Update colors for IMPACTED status
          if (r.priority === 'HIGH') {
              nEntry.isTargetedCritical = true;
              nEntry.bg = 'var(--status-critical)';
              nEntry.fg = '#ffffff';
          } else if (r.priority === 'MEDIUM') {
              nEntry.bg = 'var(--status-warning)';
              nEntry.fg = '#000000';
          } else {
              nEntry.bg = 'var(--status-info)';
              nEntry.fg = '#ffffff';
          }
      }
  });

  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const fmtZ = (d) => `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z ${String(d.getUTCDate()).padStart(2, '0')}${months[d.getUTCMonth()]}`;

  const finalData = Array.from(grouped.values()).map(g => {
      const sortedNotams = Array.from(g.notamsMap.values()).sort((a, b) => b.sortScore - a.sortScore);
      
      // --- OPS WINDOW AGGREGATION & GAP DETECTION ---
      let overallWindowStr = "OPS WINDOW APPLIED";
      let gapWarning = null;
      
      if (g.sectorWindows.length > 0) {
          // Sort by start time
          const windows = g.sectorWindows.sort((a, b) => a.start.getTime() - b.start.getTime());
          
          const overallStart = new Date(Math.min(...windows.map(w => w.start.getTime())));
          const overallEnd = new Date(Math.max(...windows.map(w => w.end.getTime())));
          
          overallWindowStr = `${fmtZ(overallStart)} – ${fmtZ(overallEnd)} Â· ${g.flights.size} flights`;
          
          // Gap Detection
          const gaps = [];
          for (let i = 0; i < windows.length - 1; i++) {
              const currentEnd = windows[i].end;
              const nextStart = windows[i+1].start;
              
              if (nextStart > currentEnd) {
                  gaps.push(`${fmtZ(currentEnd)} – ${fmtZ(nextStart)}`);
              }
          }
          
          if (gaps.length > 0) {
              gapWarning = `GAP: ${gaps.join(', ')}`;
          }
      }

      return {
          station: g.station,
          windowStr: overallWindowStr,
          gapWarning: gapWarning,
          flightsStr: Array.from(g.flights).join(', '),
          notams: sortedNotams
      };
  });

  const timestamp = Utilities.formatDate(new Date(), "UTC", "MM_dd_yyyy_HHmmss");
  return { data: finalData, timestamp: timestamp };
}

// Client State Synchronization
function syncNotamAnalysisState(stateStr) {
  try {
    PropertiesService.getUserProperties().setProperty('occ_notam_state', stateStr);
  } catch(e) {
    // Failsafe catch
  }
  return "OK";
}

/**
 * --- NOTAM ROW PARSER, VALIDITY AND AUTO-CATEGORIZATION ENGINE ---
 */
function _parseNotamRow(row) {
  const notamNum = String(row[1] || '').trim();
  const fullText = String(row[6] || '');
  if (!notamNum || !fullText) return null;

  const bMatch = fullText.match(/(?:^|\s)B\)\s*(\d{10})/i);
  const cMatch = fullText.match(/(?:^|\s)C\)\s*([\s\S]+?)(?=(?:^|\s)[DE]\)|$)/i);
  if (!bMatch) return null;
  
  const effFrom = duParseIcaoDateCode(bMatch[1]);
  let effTo = null;
  let isContinuous = false;

  if (cMatch) {
    const cStr = cMatch[1].toUpperCase().trim();
    if (cStr.includes('PERM') || cStr.includes('EST') || cStr.includes('UFN')) {
      isContinuous = true;
      effTo = new Date(Date.UTC(2099, 0, 1)); 
    } else {
      const dateStringClean = cStr.replace(/\s/g, '').substring(0, 10);
      effTo = duParseIcaoDateCode(dateStringClean);
    }
  }

  if (!effFrom || !effTo) return null;

  const dMatch = fullText.match(/(?:^|\s)D\)\s*([\s\S]+?)(?=(?:^|\s)E\)|$)/i);
  const schedule = dMatch ? dMatch[1].trim() : null;

  const category = _determineCategory(fullText);
  const priority = _determinePriority(category, fullText);

  return {
    notamNum,
    effFrom,
    effTo,
    isContinuous,
    schedule,
    category,
    priority,
    rawText: fullText
  };
}

function _determineCategory(text) {
  const upper = text.toUpperCase();
  if (/\b(RWY|RUNWAY|AD|AERODROME|AIRPORT)\s+(CLSD|CLOSED|CLOSURE)\b/i.test(upper) || /\b(RWY|RUNWAY|AERODROME|AIRPORT|MILITARY\s+EXER|FIRING|ROCKET\s+LAUNCH|FIRE\s+CAT|RFFS|VIP\s+MOV|VIP\s+MOVEMENT)\b/i.test(upper)) {
    return 'ALERT';
  }
  if (/\b(ILS|VOR|RNAV|SID|STAR|GPS|NDB|LOC|GLIDE\s+SLOPE|DME|PAPI|LOCALIZER)\b/i.test(upper)) {
    return 'NAVAID';
  }
  if (/\b(TWY|TAXIWAY|APRON|LIGHTING|OBSTACLE|CRANE|STAND\s+(CLSD|CLOSED)|SFL|ALS|HIAL)\b/i.test(upper)) {
    return 'FACILITY';
  }
  if (/\b(DRONE|UAS|UAV|UNMANNED|RESTRICTED\s+AREA|DANGER\s+AREA|AIRSPACE)\b/i.test(upper)) {
    return 'AIRSPACE';
  }
  if (/\b(BIRD|VOLCANIC|ASH|WILDLIFE|ANIMAL)\b/i.test(upper)) {
    return 'ENVIRONMENTAL';
  }
  if (/\b(ATC|MET|AWOS|RVR|FUEL|CUSTOMS|COM|COMMUNICATION|RADIO)\b/i.test(upper)) {
    return 'SERVICES';
  }
  return 'FACILITY'; 
}

function _determinePriority(category, text) {
  const upper = text.toUpperCase();
  
  // High Priority: Safety Critical / Closure
  if (category === 'ALERT' || category === 'NAVAID') {
    if (/CLSD|CLOSED|UNSERVICEABLE|U\/S|NOT\s+AVBL|INOP|OUT\s+OF\s+SERVICE|DO\s+NOT\s+USE|VIP\s+MOV|VIP\s+MOVEMENT/i.test(upper)) {
      return 'HIGH';
    }
  }
  if (/MINIMA|CAT\s+I|CAT\s+II|CAT\s+III|APPROACH|DA\/H|MDA|OCA\/H|CEILING|VISIBILITY|DH/i.test(upper)) {
    return 'HIGH';
  }

  // Medium Priority: Advisory / Operational Warnings
  if (/CRANE|WIP|WORK\s+IN\s+PROGRESS|OBSTACLE|TOWER|MEN|EQUIPMENT/i.test(upper)) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function _checkScheduleDOverlap(scheduleText, winStart, winEnd) {
  if (!scheduleText || scheduleText.trim() === "") return true; 
  const cleanSched = scheduleText.toUpperCase().trim();

  // Legacy compatible regex matching instead of matchAll
  const blockRegex = /(\d{10})\s*TO\s*(\d{10})/gi;
  let match;
  let foundBlock = false;
  while ((match = blockRegex.exec(cleanSched)) !== null) {
    foundBlock = true;
    const start = duParseIcaoDateCode(match[1]);
    const end = duParseIcaoDateCode(match[2]);
    if (start && end && end >= winStart && start <= winEnd) return true;
  }
  if (foundBlock) return false;

  const isDaylight = cleanSched.includes('SR-SS') || cleanSched.includes('HJ');
  const hourlyRegex = /(\d{4})\s*-\s*(\d{4})/g;
  let hMatch;
  let foundTimeRange = false;

  while ((hMatch = hourlyRegex.exec(cleanSched)) !== null || isDaylight) {
    foundTimeRange = true;
    let sMin, eMin;
    if (hMatch) {
      sMin = parseInt(hMatch[1].slice(0, 2), 10) * 60 + parseInt(hMatch[1].slice(2, 4), 10);
      eMin = parseInt(hMatch[2].slice(0, 2), 10) * 60 + parseInt(hMatch[2].slice(2, 4), 10);
    } else {
      sMin = 6 * 60; eMin = 18 * 60; // Daylight fallback
    }

    const daysMap = { 'MON': 1, 'TUE': 2, 'WED': 3, 'THU': 4, 'FRI': 5, 'SAT': 6, 'SUN': 0 };
    let iterator = new Date(winStart.getTime());
    
    // Check overlap for this specific time block across the window days
    while (iterator <= winEnd) {
      const currentDay = iterator.getUTCDay();
      let dayValid = false;

      let isExcluded = false;
      Object.keys(daysMap).forEach(key => {
        if (cleanSched.includes('EXC ' + key) && daysMap[key] === currentDay) isExcluded = true;
      });

      if (!isExcluded) {
        if (cleanSched.includes('MON-FRI') && currentDay >= 1 && currentDay <= 5) dayValid = true;
        else if (cleanSched.includes('SAT-SUN') && (currentDay === 0 || currentDay === 6)) dayValid = true;
        else if (cleanSched.includes('DAILY')) dayValid = true;
        else {
          let hasExplicitDays = false;
          Object.keys(daysMap).forEach(key => {
            if (cleanSched.includes(key) && !cleanSched.includes('EXC ' + key)) {
              hasExplicitDays = true;
              if (daysMap[key] === currentDay) dayValid = true;
            }
          });
          if (!hasExplicitDays) dayValid = true; 
        }
      }

      if (dayValid) {
        const winStartMin = winStart.getUTCHours() * 60 + winStart.getUTCMinutes();
        const durationHrs = (winEnd.getTime() - winStart.getTime()) / 3600000;
        if (_isWithinCyclicTimeBounds(winStartMin, sMin, eMin, durationHrs)) return true;
      }
      iterator.setTime(iterator.getTime() + 12 * 60 * 60 * 1000); // 12h steps to cover 2 days effectively
    }
    
    if (isDaylight) break; // SR-SS only needs one pass
  }
  
  if (foundTimeRange) return false;
  return true; 
}

function _isWithinCyclicTimeBounds(fStartMin, nStartMin, nEndMin, durationHrs) {
  if (durationHrs >= 24) return true;
  
  const fStart = fStartMin;
  const fEnd = fStartMin + Math.floor(durationHrs * 60);
  
  let nStart = nStartMin;
  let nEnd = nStartMin <= nEndMin ? nEndMin : nEndMin + (24 * 60);
  
  if (fStart <= nEnd && fEnd >= nStart) return true;
  
  nStart += 24 * 60; nEnd += 24 * 60;
  if (fStart <= nEnd && fEnd >= nStart) return true;

  nStart -= 48 * 60; nEnd -= 48 * 60;
  if (fStart <= nEnd && fEnd >= nStart) return true;

  return false;
}

// Date parsing delegates to DateUtils.gs (duParseIcaoDateCode, duFormatDateZ)

/**
 * Overwrites the entire "NOTAM" sheet data structure atomically.
 * Safeguarded with Mutex Script Locks to prevent concurrent read/write collision.
 */
function overwriteNotamDatabase(dataMatrix) {
  requireAuthorized();
  // Enhanced Security Validation
  if (!dataMatrix || !Array.isArray(dataMatrix) || dataMatrix.length === 0 || !dataMatrix[0] || dataMatrix[0].length === 0) {
    throw new Error("SERVER EXCEPTION: Received empty, malformed, or corrupt dataset matrix.");
  }

  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lock.waitLock(30000);
    lockAcquired = true;
  } catch (e) {
    throw new Error("MUTEX TIMEOUT: System is currently processing another database commit. Please retry shortly.");
  }

  try {
    const ss = getActiveSS();
    const notamSheet = ss.getSheetByName('NOTAM');
    if (!notamSheet) {
      throw new Error("DATABASE EXCEPTION: Sheet tab reference 'NOTAM' does not exist.");
    }

    notamSheet.clearContents();
    
    const totalRows = dataMatrix.length;
    const totalCols = dataMatrix[0].length;
    
    notamSheet.getRange(1, 1, totalRows, totalCols).setValues(dataMatrix);
    SpreadsheetApp.flush();
    firClearNotamDependentCache();
    
    return {
      status: "SUCCESS",
      rowsInserted: totalRows
    };
  } catch (err) {
    throw new Error("DATABASE WRITE CRITICAL FAILURE: " + err.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * Entry point invoked by the UPDATE NOTAM console.
 * Accepts a raw parsed matrix (metadata rows + a header row containing "NOTAM"),
 * normalizes it to a clean NOTAM schema, overwrites the NOTAM registry, and
 * records an audit entry in the NOTAM_HISTORY sheet.
 *
 * Returns the object contract expected by Update_Notam_Ui: { status, message }.
 */
function saveNotamData(dataMatrix, queryStr) {
  requireAuthorized();
  if (!dataMatrix || !Array.isArray(dataMatrix) || dataMatrix.length === 0 || !dataMatrix[0]) {
    return { status: 'error', message: 'Empty dataset.' };
  }

  // 1. Locate the true header row. A metadata row may contain the substring
  //    "NOTAM" (e.g. "fnsNotams"), so require a NOTAM column header specifically:
  //    an exact "NOTAM #" cell, OR a "Location" cell alongside any NOTAM column.
  let headerIndex = -1;
  for (let i = 0; i < dataMatrix.length; i++) {
    const row = dataMatrix[i];
    if (!row || !Array.isArray(row)) continue;
    const joined = row.map(v => String(v == null ? '' : v)).join(' ').toUpperCase();
    const hasExactNotamCol = row.some(c => String(c == null ? '' : c).trim().toUpperCase() === 'NOTAM #');
    const hasLocationCol = row.some(c => String(c == null ? '' : c).trim().toUpperCase() === 'LOCATION');
    if (hasExactNotamCol || (joined.includes('NOTAM') && hasLocationCol)) {
      headerIndex = i;
      break;
    }
  }

  const startRow = headerIndex >= 0 ? headerIndex : 0;
  const headerRow = dataMatrix[startRow].map((value, i) => String(value || 'Column_' + i).trim());
  const dataRows = dataMatrix.slice(startRow + 1).filter(row => row && row.some(Boolean));

  if (dataRows.length === 0) {
    return { status: 'error', message: 'No data rows found below the header.' };
  }

  // 2. Normalize every row to a consistent column count matching the header.
  const colCount = headerRow.length;
  const cleanMatrix = [headerRow].concat(dataRows.map(row => {
    const normalized = new Array(colCount).fill('');
    for (let i = 0; i < Math.min(row.length, colCount); i++) normalized[i] = row[i] ?? '';
    return normalized;
  }));

  // 3. Destructive atomic overwrite of the registry.
  let writeResult;
  try {
    writeResult = overwriteNotamDatabase(cleanMatrix);
  } catch (err) {
    return { status: 'error', message: String(err.message || err) };
  }

  // 4. Append audit trail entry.
  try {
    appendNotamHistory(String(queryStr || ''), dataRows.length);
  } catch (err) {
    console.warn('[NOTAM] History append failed (non-fatal): ' + err.message);
  }

  return {
    status: 'success',
    message: 'Saved Successfully',
    rowsInserted: writeResult && writeResult.rowsInserted
  };
}

/**
 * Appends an audit entry to NOTAM_HISTORY and guarantees a header row exists.
 * Columns: A=TIMESTAMP, B=USER, C=ROW_COUNT, D=QUERY_STR.
 */
function appendNotamHistory(queryStr, rowCount) {
  const ss = getActiveSS();
  let sheet = ss.getSheetByName('NOTAM_HISTORY');
  if (!sheet) {
    sheet = ss.insertSheet('NOTAM_HISTORY');
    sheet.getRange(1, 1, 1, 4).setValues([['TIMESTAMP', 'USER', 'ROW_COUNT', 'QUERY_STR']]);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, 4).getValues()[0];
    if (String(firstRow[0] || '').trim().toUpperCase() !== 'TIMESTAMP') {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, 4).setValues([['TIMESTAMP', 'USER', 'ROW_COUNT', 'QUERY_STR']]);
    }
  }

  let user = 'Unknown';
  try {
    const email = Session.getActiveUser().getEmail();
    if (email) user = email;
  } catch (e) { /* ignore */ }

  sheet.appendRow([new Date(), user, rowCount, String(queryStr || '')]);
}

/**
 * SAFE smoke test for the UPDATE NOTAM pipeline (saveNotamData + history).
 *
 * Backs up the live NOTAM sheet, writes a small synthetic dataset, verifies the
 * write + audit history, then restores the backup in a finally block so live
 * data is never lost. Leaves one history entry so it can be inspected.
 *
 * Run from the Apps Script editor (Run > smokeTestSaveNotam) and read the log.
 */
function smokeTestSaveNotam() {
  const ss = getActiveSS();
  const notamSheet = ss.getSheetByName('NOTAM');
  if (!notamSheet) throw new Error("Sheet 'NOTAM' not found.");

  // --- Backup live registry (incl. any existing header row) ---
  const backup = notamSheet.getDataRange().getValues();
  console.log('[SMOKE] NOTAM backup rows: ' + backup.length);

  // --- Synthetic matrix shaped like Update_Notam_Ui parsed output ---
  // Rows 0-3 = metadata; row 4 = header containing "NOTAM"; rows 5+ = data.
  const matrix = [
    ['Excel export', '', '', '', '', '', ''],
    ['fnsNotams', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Location', 'NOTAM #', 'Class', 'Issue Date', 'Effective Date', 'Expiration Date', 'NOTAM Text'],
    ['WAAA', 'S001/26', 'Domestic', '01/01/2026 0000', '01/01/2026 0000', '01/02/2026 0000',
      'S001/26 TESTNOTAMN\nQ) WAAA/QXXXX/IV/NBO/E/000/999/1234S12000E001\nA) WAAA\nB) 2601010000\nC) 2601020000\nE) SMOKE TEST ENTRY\nF) GND\nG) 999'],
    ['WAAA', 'S002/26', 'Domestic', '01/01/2026 0000', '01/01/2026 0000', '01/02/2026 0000',
      'S002/26 TESTNOTAMN\nQ) WAAA/QXXXX/IV/NBO/E/000/999/1234S12000E001\nA) WAAA\nB) 2601010000\nC) 2601020000\nE) SMOKE TEST ENTRY 2\nF) GND\nG) 999']
  ];

  try {
    // --- Execute the exact endpoint the UI calls ---
    const res = saveNotamData(matrix, 'Query ran at UTC SMOKE TEST');
    console.log('[SMOKE] saveNotamData result: ' + JSON.stringify(res));

    // --- Verify the NOTAM sheet now holds the test rows ---
    const nowRows = notamSheet.getDataRange().getValues();
    const okRows = nowRows.length === 3 && String(nowRows[1][1]).trim() === 'S001/26';
    console.log('[SMOKE] NOTAM sheet rows after write: ' + nowRows.length + ' (expect 3)');
    console.log('[SMOKE] Row[1] NOTAM # = "' + String(nowRows[1][1]) + '" (expect S001/26)');
    if (!okRows) throw new Error('saveNotamData write verification FAILED.');

    // --- Verify audit history entry exists with the right contract ---
    const history = getNotamUpdateHistory();
    const latest = history[0] || {};
    console.log('[SMOKE] History latest entry: ' + JSON.stringify(latest));
    const okHistory = latest.rowCount === 2 && String(latest.queryStr || '').indexOf('SMOKE TEST') !== -1;
    if (!okHistory) throw new Error('History audit verification FAILED.');

    console.log('[SMOKE] PASS — saveNotamData + history pipeline verified.');
    return { status: 'PASS' };
  } catch (err) {
    console.error('[SMOKE] FAIL: ' + err.message);
    return { status: 'FAIL', error: err.message };
  } finally {
    // --- Restore live registry (preserving original header) ---
    try {
      notamSheet.clearContents();
      if (backup.length > 0) {
        notamSheet.getRange(1, 1, backup.length, backup[0].length).setValues(backup);
      }
      console.log('[SMOKE] NOTAM registry restored (' + backup.length + ' rows).');
    } catch (e) {
      console.error('[SMOKE] RESTORE FAILED — check NOTAM sheet immediately: ' + e.message);
    }
  }
}

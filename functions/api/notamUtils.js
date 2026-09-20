// ============================================================================
// NOTAM UTILITIES FOR CLOUDFLARE WORKER
// Shared Date parsing and logic
// ============================================================================

export function decodeNotamText(value) {
    const named = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };
    return String(value ?? '').replace(/&(#x[0-9a-f]+|#[0-9]+|apos|quot|amp|lt|gt|nbsp);/gi, (entity, code) => {
        if (code[0] !== '#') return named[code.toLowerCase()];
        const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        const valid = point === 9 || point === 10 || point === 13 ||
            (point >= 0x20 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && point !== 0xfffe && point !== 0xffff);
        return valid ? String.fromCodePoint(point) : entity;
    });
}

export function duParseIcaoDateCode(s) {
    if (!s || s.length < 6) return null;
    const code = s.length >= 10 ? s.slice(0, 10) : s.slice(0, 6);
    // Guard "991332" dan semacamnya: bulan/hari/jam di luar jangkauan → null, bukan Invalid Date.
    const year = 2000 + parseInt(code.slice(0, 2), 10);
    const month = parseInt(code.slice(2, 4), 10) - 1;
    const day = parseInt(code.slice(4, 6), 10);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let hours = 0, minutes = 0;
    if (s.length >= 10) {
      hours = parseInt(code.slice(6, 8), 10);
      minutes = parseInt(code.slice(8, 10), 10);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return null;
    }
    const date = new Date(Date.UTC(year, month, day, hours, minutes));
    if (isNaN(date.getTime())) return null;
    // Round-trip check: "260231" (31 Feb) harus ditolak, bukan dilempar sebagai 3 Mar.
    if (hours === 0 && minutes === 0 && (date.getUTCMonth() !== month || date.getUTCDate() !== day)) return null;
    return date;
}
  
export function duFormatDateTimeUTC(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return y + '-' + m + '-' + d2 + ' ' + hh + ':' + mm;
}

export function duParseFlightTime(value) {
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : { h: value.getUTCHours(), m: value.getUTCMinutes() };
    }
    const raw = String(value ?? '').trim();
    if (!raw) return null;

    const isoMatch = raw.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
    if (isoMatch) {
        const h = Number(isoMatch[1]);
        const m = Number(isoMatch[2]);
        return h <= 23 && m <= 59 ? { h, m } : null;
    }
    if (/\d{4}-\d{2}-\d{2}/.test(raw)) return null;

    const compact = raw.replace(/[^0-9]/g, '');
    if (compact.length < 3) return null;
    const h = compact.length === 3 ? Number(compact.slice(0, 1)) : Number(compact.slice(0, 2));
    const m = compact.length === 3 ? Number(compact.slice(1, 3)) : Number(compact.slice(2, 4));
    return h <= 23 && m <= 59 ? { h, m } : null;
}
  
export function isAerodromeOnlyNotam(text) {
    const qualifier = String(text || '').match(/(?:^|\s)Q\)\s*([A-Z]{4}\s*\/[^\r\n]+)/i);
    if (!qualifier) return false;
    const scope = (qualifier[1].split('/')[4] || '').trim().toUpperCase();
    return scope === 'A';
}

export function parseNotamRow(row) {
    const notamNum = String(row.id || '').trim();
    const fullText = decodeNotamText(row.message);
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

    const category = determineCategory(fullText);
    const priority = determinePriority(category, fullText);

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

function determineCategory(text) {
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

function determinePriority(category, text) {
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

/* ---------- Geometri area NOTAM (layer peta halaman FIR) ---------- */
// Q) memberi titik pusat + radius of influence (3 digit terakhir, NM; 000/999 =
// tidak didefinisikan). E) memberi batas area sebagai daftar koordinat
// ("... WI: 142305N 1205257E - 141804N 1205714E - ...") atau frasa radius
// ("5NM RADIUS CENTERED ON 144357N 1210842E").
function duToDecimal(digits, hemi, isLat) {
    const n = digits.length;
    let deg = 0, min = 0, sec = 0;
    if (isLat) {
        if (n === 6) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); sec = parseInt(digits.slice(4, 6), 10); }
        else if (n === 4) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); }
        else deg = parseInt(digits, 10);
    } else {
        if (n === 7) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); sec = parseInt(digits.slice(5, 7), 10); }
        else if (n === 5) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); }
        else deg = parseInt(digits, 10);
    }
    let dec = deg + min / 60 + sec / 3600;
    if (/S|W/i.test(hemi)) dec = -dec;
    return Math.round(dec * 10000) / 10000;
}

// Daftar koordinat [lon, lat] dari sebuah potongan teks NOTAM. Alternasi DMS
// (6/7 digit) didahulukan supaya pasangan DM (4/5 digit) tidak terbelah.
function duCollectCoordinates(text) {
    const out = [];
    if (!text) return out;
    const re = /(\d{6})\s*([NS])\s*(\d{7})\s*([EW])|(\d{4})\s*([NS])\s*(\d{5})\s*([EW])/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const latDigits = m[1] || m[5], latHemi = m[2] || m[6];
        const lonDigits = m[3] || m[7], lonHemi = m[4] || m[8];
        if (!latDigits || !lonDigits) continue;
        const pair = [duToDecimal(lonDigits, lonHemi, false), duToDecimal(latDigits, latHemi, true)];
        const last = out[out.length - 1];
        if (last && last[0] === pair[0] && last[1] === pair[1]) continue; // titik penutup dobel
        out.push(pair);
    }
    return out;
}

// Radius eksplisit di E) lebih tepat daripada radius of influence Q).
function duParseRadiusPhrase(text) {
    if (!text) return null;
    const patterns = [
        /(\d+(?:\.\d+)?)\s*NM\s*RADIUS\b/i,
        /RADIUS\s*(?:OF\s*)?(\d+(?:\.\d+)?)\s*NM\b/i,
        /WITHIN\s*(\d+(?:\.\d+)?)\s*NM\b/i
    ];
    for (const re of patterns) {
        const m = re.exec(text);
        if (!m) continue;
        const value = parseFloat(m[1]);
        if (value > 0 && value < 1000) return value;
    }
    return null;
}

export function parseNotamGeometry(text) {
    const empty = { center: null, radiusNm: null, polygon: [] };
    try {
        if (!text || typeof text !== 'string') return empty;

        const qLine = (text.match(/(?:^|\n)[ \t]*Q\)[^\n]*/i) || [''])[0];
        const qMatch = qLine.match(/(\d{6})([NS])(\d{7})([EW])(\d{3})?/i) || qLine.match(/(\d{4})([NS])(\d{5})([EW])(\d{3})?/i);
        let center = qMatch ? [duToDecimal(qMatch[3], qMatch[4], false), duToDecimal(qMatch[1], qMatch[2], true)] : null;
        let qRadius = qMatch && qMatch[5] ? parseInt(qMatch[5], 10) : NaN;
        // 000/999 = radius of influence tidak didefinisikan (ICAO) — jangan digambar.
        if (!(qRadius > 0) || qRadius === 999) qRadius = NaN;

        const eMatch = /(?:^|\n)[ \t]*E\)[ \t]*([\s\S]*?)(?=(?:\n[ \t]*[FG]\))|$)/i.exec(text);
        const eIdx = text.indexOf('E)');
        const eText = eMatch ? eMatch[1] : (eIdx >= 0 ? text.slice(eIdx + 2) : '');
        const polygon = duCollectCoordinates(eText);
        const textRadius = duParseRadiusPhrase(eText);

        if (!center) {
            const fallbackPoint = polygon.length ? polygon : duCollectCoordinates(text);
            if (fallbackPoint.length) center = [fallbackPoint[0][0], fallbackPoint[0][1]];
        }

        return {
            center,
            radiusNm: textRadius !== null ? textRadius : (qRadius > 0 ? qRadius : null),
            polygon: polygon.length >= 2 ? polygon : []
        };
    } catch (e) {
        return empty;
    }
}

export function checkScheduleDOverlap(scheduleText, winStart, winEnd) {
    if (!scheduleText || scheduleText.trim() === "") return true; 
    const cleanSched = scheduleText.toUpperCase().trim();
  
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
          if (isWithinCyclicTimeBounds(winStartMin, sMin, eMin, durationHrs)) return true;
        }
        iterator.setTime(iterator.getTime() + 12 * 60 * 60 * 1000); // 12h steps
      }
      
      if (isDaylight) break; 
    }
    
    if (foundTimeRange) return false;
    return true; 
}

function isWithinCyclicTimeBounds(fStartMin, nStartMin, nEndMin, durationHrs) {
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

export function checkRouteMatch(notamRawText, routeTokens) {
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

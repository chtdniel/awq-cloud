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
    // Round-trip check TANPA syarat jam: "2602311200" (31 Feb) harus null, bukan
    // dilempar sebagai 3 Mar. Dulu guard ini hanya jalan saat HHMM = 0000, sehingga
    // B)/C) dengan tanggal imajiner diterima dan menggeser window validitas diam-diam.
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
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
    const clockMatch = raw.match(/(?:^|[\sT])(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (clockMatch) {
        const h = Number(clockMatch[1]);
        const m = Number(clockMatch[2]);
        return h <= 23 && m <= 59 ? { h, m } : null;
    }
    if (/\d{4}-\d{2}-\d{2}/.test(raw)) return null;

    const compact = raw.replace(/[^0-9]/g, '');
    if (compact.length >= 12) {
        const h = Number(compact.slice(8, 10));
        const m = Number(compact.slice(10, 12));
        return h <= 23 && m <= 59 ? { h, m } : null;
    }
    if (compact.length < 3) return null;
    if (compact.length > 4) return null;
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

    // B) boleh terbelah oleh wrap AFTN 69 karakter ("B) 26092812" + baris "23"):
    // digit di dalam nilai digabung dulu, baru diambil 10 digit pertama.
    const bMatch = fullText.match(/(?:^|\s)B\)\s*(\d[\d\s]{6,}\d)/i);
    const bCode = bMatch ? bMatch[1].replace(/\s+/g, '').slice(0, 10) : null;
    const cMatch = fullText.match(/(?:^|\s)C\)\s*([\s\S]+?)(?=(?:^|\s)[DE]\)|$)/i);
    if (!bCode || bCode.length < 10) return null;

    const effFrom = duParseIcaoDateCode(bCode);
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
    // Pusat Q) dipakai untuk meresolusi token matahari di D-line (SR/SS/HJ/HN):
    // jadwal matahari bergantung koordinat NOTAM, bukan jam tetap.
    const geometry = parseNotamGeometry(fullText);

    return {
        notamNum,
        effFrom,
        effTo,
        isContinuous,
        schedule,
        category,
        priority,
        center: geometry.center,
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
    // Semua token di-word-boundary. Tanpa \b, "DH" (Decision Height) cocok di dalam
    // SPDH / YGDH / DH8 / DHC, sehingga NOTAM biasa naik ke HIGH hanya karena kebetulan
    // huruf — kelas bug yang sama dengan "MEN" di dalam GOVERNMENT pada blok MEDIUM.
    if (/\bMINIMA\b|\bCAT\s+(?:I|II|III)\b|\bAPPROACH\b|\bDA\/H\b|\bMDA\b|\bOCA\/H\b|\bCEILING\b|\bVISIBILITY\b|\bDH\b/i.test(upper)) {
        return 'HIGH';
    }

    // Hazard ruang udara aktif: danger area, rocket launch, firing/military exercise,
    // re-entry/splashdown. Tanpa cabang ini NOTAM ALERT tetap jatuh ke LOW hanya
    // karena tidak memuat kata closure (CLSD/U-S/INOP) — mis. TEMPO DANGER AREA ACT
    // untuk peluncuran/atmospheric re-entry.
    if (/DANGER\s+AREA\s+ACT|HAZARDOUS\s+OPS|RE-?ENTRY|SPLASHDOWN|ROCKET\s+LAUNCH|MISSILE|FIRING|MILITARY\s+EXER|AIRSPACE\s+CLOSURE|TEMPO\s+DANGER/i.test(upper)) {
        return 'HIGH';
    }

    // Medium Priority: Advisory / Operational Warnings
    // "MEN" dikunci \b: pola lama tanpa \b cocok di dalam GOVERNMENT, AMENDMENTS,
    // SEGMENT, MOVEMENT, IMPLEMENTATION, DEPARTMENT, dst — 18 dari 22 NOTAM MEDIUM
    // di data FIR berasal dari false positive ini. Frasa asli "MEN AND EQUIPMENT"
    // tetap tertangkap lewat \bMEN\b maupun EQUIPMENT.
    if (/\bCRANE\b|\bWIP\b|WORK\s+IN\s+PROGRESS|\bOBSTACLE\b|\bTOWER\b|\bMEN\b|EQUIPMENT/i.test(upper)) {
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
    // Detik boleh desimal (mis. "024101.40N"): sebagian negara mengirim DMS dengan
    // pecahan detik, dan regex yang menuntut digit bulat membuat batas area E) hilang
    // sama sekali (peta hanya menggambar lingkaran radius Q)).
    const dmsLat = /^\d{6}(?:\.\d+)?$/;
    const dmsLon = /^\d{7}(?:\.\d+)?$/;
    if (isLat) {
        if (dmsLat.test(digits)) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); sec = parseFloat(digits.slice(4)); }
        else if (n === 4) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); }
        else deg = parseInt(digits, 10);
    } else {
        if (dmsLon.test(digits)) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); sec = parseFloat(digits.slice(5)); }
        else if (n === 5) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); }
        else deg = parseInt(digits, 10);
    }
    let dec = deg + min / 60 + sec / 3600;
    if (/S|W/i.test(hemi)) dec = -dec;
    return Math.round(dec * 10000) / 10000;
}

// Daftar koordinat [lon, lat] dari sebuah potongan teks NOTAM. Alternasi DMS
// (6/7 digit) didahulukan supaya pasangan DM (4/5 digit) tidak terbelah.
// joinWrapped=true HANYA untuk potongan field E): di sana newline memang bisa membelah
// satu token ("23" + baris "42S"). Di luar field E), menyambung digit lintas baris bisa
// MENGARANG koordinat — mis. baris "2630" + baris "42S 07500E" menjadi "263042S 07500E"
// yang cocok sebagai 30°42'S 075°00'E. Peta lalu menggambar hazard di tempat yang salah,
// dan titik itu juga dipakai meresolusi jadwal matahari.
function duCollectCoordinates(text, joinWrapped = false) {
    const out = [];
    if (!text) return out;
    const source = joinWrapped
        ? String(text).replace(/(\d)[ \t]*\r?\n[ \t]*(\d)/g, '$1$2')
        : String(text);
    const re = /(\d{6}(?:\.\d+)?)\s*([NS])\s*(\d{7}(?:\.\d+)?)\s*([EW])|(\d{4})\s*([NS])\s*(\d{5})\s*([EW])/gi;
    let m;
    while ((m = re.exec(source)) !== null) {
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
        const qMatch = qLine.match(/(\d{6}(?:\.\d+)?)([NS])(\d{7}(?:\.\d+)?)([EW])(\d{3})?/i) || qLine.match(/(\d{4})([NS])(\d{5})([EW])(\d{3})?/i);
        let center = qMatch ? [duToDecimal(qMatch[3], qMatch[4], false), duToDecimal(qMatch[1], qMatch[2], true)] : null;
        let qRadius = qMatch && qMatch[5] ? parseInt(qMatch[5], 10) : NaN;
        // 000/999 = radius of influence tidak didefinisikan (ICAO) — jangan digambar.
        if (!(qRadius > 0) || qRadius === 999) qRadius = NaN;

        const eMatch = /(?:^|\n)[ \t]*E\)[ \t]*([\s\S]*?)(?=(?:\n[ \t]*[FG]\))|$)/i.exec(text);
        const eIdx = text.indexOf('E)');
        const eText = eMatch ? eMatch[1] : (eIdx >= 0 ? text.slice(eIdx + 2) : '');
        const polygon = duCollectCoordinates(eText, true);
        const textRadius = duParseRadiusPhrase(eText);

        if (!center) {
            // Scan seluruh pesan TANPA join: di luar field E) newline bukan pembungkus
            // token, dan menyambungnya bisa mengarang titik pusat.
            const fallbackPoint = polygon.length ? polygon : duCollectCoordinates(text, false);
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

/* ---------- Waktu matahari untuk D-line (SR / SS / HJ / HN) ---------- */
// D-line boleh memakai token matahari ("SR-SS", "HJ", "HN", "SR-30 SS+15"). Jamnya
// bergantung posisi matahari di koordinat NOTAM, BUKAN jam tetap: band UTC
// 06:00-18:00 yang dulu dipakai menghasilkan false clear untuk FIR di timur jauh
// (YMMM UTC+10: window 20:30Z = 06:30 lokal = siang, tapi dinilai tidak overlap)
// sekaligus false alarm di malam lokal (12:00Z = 22:00 lokal, dinilai overlap).
const DU_DEG = Math.PI / 180;
const DU_DAY_MS = 86400000;
const DU_J1970 = 2440588, DU_J2000 = 2451545;
const duToJulian = d => d.valueOf() / DU_DAY_MS - 0.5 + DU_J1970;
const duFromJulian = j => new Date((j + 0.5 - DU_J1970) * DU_DAY_MS);
const duToDays = d => duToJulian(d) - DU_J2000;

// Sunrise/sunset UTC untuk satu hari UTC + koordinat (algoritma NOAA/SunCalc,
// akurasi ±1 menit — cukup untuk band operasional NOTAM). polarDay/polarNight
// menandai matahari yang tidak pernah terbit/terbenam pada tanggal itu.
export function duSunTimesUTC(date, lat, lon) {
    const empty = { sunrise: null, sunset: null, polarDay: false, polarNight: false };
    try {
        const la = Number(lat), lo = Number(lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return empty;
        const rad = DU_DEG, lw = rad * -lo, phi = rad * la;
        const d = new Date(date);
        if (isNaN(d.getTime())) return empty;
        const n = Math.round(duToDays(d) - 0.0009 - lw / (2 * Math.PI));
        const ds = 0.0009 + lw / (2 * Math.PI) + n;
        const M = rad * (357.5291 + 0.98560028 * duToDays(d));
        const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
        const L = M + C + rad * 102.9372 + Math.PI;
        const dec = Math.asin(Math.sin(rad * 23.4397) * Math.sin(L));
        const transit = (h) => DU_J2000 + (0.0009 + (h + lw) / (2 * Math.PI) + n)
            + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
        const cosH = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
        if (!Number.isFinite(cosH)) return empty;
        if (cosH < -1) return { sunrise: null, sunset: null, polarDay: true, polarNight: false };
        if (cosH > 1) return { sunrise: null, sunset: null, polarDay: false, polarNight: true };
        const w = Math.acos(cosH);
        const jSet = transit(w);
        const jNoon = transit(0);
        return { sunrise: duFromJulian(jNoon - (jSet - jNoon)), sunset: duFromJulian(jSet), polarDay: false, polarNight: false };
    } catch (e) {
        return empty;
    }
}

// Offset token matahari: "SR-30" = 30 menit sebelum terbit, "SS+15" = 15 menit
// sesudah terbenam. <=2 digit = menit, 3-4 digit = HHMM.
function duScheduleOffsetMinutes(raw) {
    const s = String(raw || '');
    const digits = s.replace(/[^0-9]/g, '');
    if (!digits) return 0;
    const sign = s.indexOf('-') >= 0 ? -1 : 1;
    if (digits.length <= 2) return sign * parseInt(digits, 10);
    return sign * (parseInt(digits.slice(0, digits.length - 2), 10) * 60 + parseInt(digits.slice(-2), 10));
}

// Token matahari pada D-line. anchors dipakai untuk bentuk "SR-30 SS+15";
// unresolved = token matahari tunggal tanpa pasangan (tidak bisa jadi band).
function duScheduleSolarTokens(sched) {
    const out = { day: false, night: false, anchors: [], unresolved: false };
    if (/\bHJ\b/.test(sched)) out.day = true;
    if (/\bHN\b/.test(sched)) out.night = true;
    if (/\bSR\s*-\s*SS\b/.test(sched)) out.day = true;
    if (/\bSS\s*-\s*SR\b/.test(sched)) out.night = true;
    if (out.day || out.night) return out; // rentang sudah menentukan band
    const re = /\b(SR|SS)\s*([+-]\s*\d{1,4})?(?![A-Z0-9])/g;
    let m;
    while ((m = re.exec(sched)) !== null) out.anchors.push({ base: m[1], offset: duScheduleOffsetMinutes(m[2]) });
    if (out.anchors.length === 1) { out.anchors = []; out.unresolved = true; }
    return out;
}

// Band jam eksplisit "HHMM-HHMM" (boleh beberapa; b <= a berarti lewat tengah malam).
function duScheduleClockBands(sched) {
    const out = [];
    const re = /(?<!\d)(\d{4})\s*-\s*(\d{4})(?!\d)/g;
    let m;
    while ((m = re.exec(sched)) !== null) {
        const sh = parseInt(m[1].slice(0, 2), 10), sm = parseInt(m[1].slice(2, 4), 10);
        const eh = parseInt(m[2].slice(0, 2), 10), em = parseInt(m[2].slice(2, 4), 10);
        if (sh > 23 || sm > 59 || eh > 24 || em > 59) continue; // 2400 = tengah malam berikutnya
        out.push([sh * 60 + sm, eh * 60 + em]);
    }
    return out;
}

// Filter hari D-line: DAILY / MON-FRI / SAT-SUN / hari eksplisit / EXC.
function duScheduleDayMatches(sched, dayDate) {
    const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
    const dow = dayDate.getUTCDay();
    const excUsed = (label) => new RegExp('EXC\\s+' + label + '(?![A-Z])').test(sched);
    if (Object.keys(DAYS).some(k => excUsed(k) && DAYS[k] === dow)) return false;
    if (excUsed('MON\\s*-\\s*FRI') && dow >= 1 && dow <= 5) return false;
    if (excUsed('SAT\\s*-\\s*SUN') && (dow === 0 || dow === 6)) return false;
    if (/MON\s*-\s*FRI/.test(sched)) return dow >= 1 && dow <= 5;
    if (/SAT\s*-\s*SUN/.test(sched)) return dow === 0 || dow === 6;
    if (/\bDAILY\b/.test(sched)) return true;
    let hasExplicit = false, matched = false;
    for (const k of Object.keys(DAYS)) {
        if (new RegExp('\\b' + k + '\\b').test(sched) && !excUsed(k)) {
            hasExplicit = true;
            if (DAYS[k] === dow) matched = true;
        }
    }
    return hasExplicit ? matched : true;
}

// Overlap jadwal D) terhadap window [winStart, winEnd].
// coords = { lat, lon } dari Q) NOTAM — WAJIB bila jadwal memakai token matahari.
// Tanpa koordinat, token matahari tidak bisa diresolusi: hasilnya fail-open
// (dianggap aktif) supaya tidak pernah menghasilkan false clear.
export function checkScheduleDOverlap(scheduleText, winStart, winEnd, coords) {
    if (!scheduleText || String(scheduleText).trim() === "") return true;
    if (!(winStart instanceof Date) || !(winEnd instanceof Date)) return true;
    const cleanSched = String(scheduleText).toUpperCase().replace(/\s+/g, ' ').trim();

    // 1) Blok tanggal eksplisit "YYMMDDHHMM TO YYMMDDHHMM".
    const blockRegex = /(\d{10})\s*TO\s*(\d{10})/g;
    let match, foundBlock = false;
    while ((match = blockRegex.exec(cleanSched)) !== null) {
        foundBlock = true;
        const start = duParseIcaoDateCode(match[1]);
        const end = duParseIcaoDateCode(match[2]);
        if (start && end && end >= winStart && start <= winEnd) return true;
    }
    if (foundBlock) return false;

    // 2) Band harian: jam eksplisit + token matahari.
    const bands = duScheduleClockBands(cleanSched);
    const solar = duScheduleSolarTokens(cleanSched);
    const hasSolar = solar.day || solar.night || solar.anchors.length > 0;

    // Tidak ada band waktu yang bisa dibaca -> fail-open (perilaku lama, arah aman).
    if (bands.length === 0 && !hasSolar && !solar.unresolved) return true;
    if (solar.unresolved) return true;

    const hasCoords = !!(coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lon)));
    if (hasSolar && !hasCoords) return true; // fail-open, jangan menebak jam tetap
    const lat = hasCoords ? Number(coords.lat) : 0;
    const lon = hasCoords ? Number(coords.lon) : 0;
    const winStartMs = winStart.getTime(), winEndMs = winEnd.getTime();

    // (a) Jam eksplisit: band diuji per hari UTC. Hari sebelum window ikut dihitung
    // supaya band yang lewat tengah malam (mis. 2300-0100) tidak hilang.
    if (bands.length > 0) {
        const startDay = Date.UTC(winStart.getUTCFullYear(), winStart.getUTCMonth(), winStart.getUTCDate()) - DU_DAY_MS;
        const endDay = Date.UTC(winEnd.getUTCFullYear(), winEnd.getUTCMonth(), winEnd.getUTCDate());
        const dayCount = Math.min(Math.floor((endDay - startDay) / DU_DAY_MS) + 1, 400); // guard rentang ekstrem
        for (let i = 0; i < dayCount; i++) {
            const day = startDay + i * DU_DAY_MS;
            if (!duScheduleDayMatches(cleanSched, new Date(day))) continue;
            for (const [a, b] of bands) {
                const s = day + a * 60000;
                const e = day + b * 60000 + (b <= a ? DU_DAY_MS : 0); // band lewat tengah malam
                if (s <= winEndMs && e >= winStartMs) return true;
            }
        }
    }

    // (b) Token matahari: diresolusi per hari SURYA (bukan tengah malam UTC) memakai
    // titik referensi window. Hari surya di bujur timur bisa melintang tengah malam
    // UTC, jadi menghitung dari tanggal UTC akan mengambil hari yang salah.
    if (hasSolar) {
        const refs = [winStartMs, winStartMs + (winEndMs - winStartMs) / 2, winEndMs];
        for (const ref of refs) {
            const localDay = new Date(ref + Math.round(lon * 4) * 60000); // offset bujur -> tanggal sipil lokal
            if (!duScheduleDayMatches(cleanSched, localDay)) continue;
            const sun = duSunTimesUTC(new Date(ref), lat, lon);
            if (sun.polarDay) {
                if (solar.day || solar.anchors.length >= 2) return true; // matahari tidak terbenam
                continue;
            }
            if (sun.polarNight) {
                if (solar.night) return true; // matahari tidak terbit = malam penuh
                continue;
            }
            if (!sun.sunrise || !sun.sunset) return true; // tidak bisa diresolusi -> fail-open
            const rise = sun.sunrise.getTime(), set = sun.sunset.getTime();
            if (solar.day && rise <= winEndMs && set >= winStartMs) return true;
            if (solar.night && set <= winEndMs && rise + DU_DAY_MS >= winStartMs) return true;
            if (solar.anchors.length >= 2) {
                const anchorMs = solar.anchors.map((anchor) => {
                    const base = anchor.base === 'SR' ? rise : set;
                    return base + anchor.offset * 60000;
                }).sort((x, y) => x - y);
                if (anchorMs[0] <= winEndMs && anchorMs[anchorMs.length - 1] >= winStartMs) return true;
            }
        }
    }

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

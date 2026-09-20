// ============================================================================
// WX time-window helpers (server side, shared).
// ----------------------------------------------------------------------------
// flights.etd / flights.eta in D1 hold ISO UTC ("2026-09-08T04:00:00.000Z"),
// "HH:MM", or the legacy bare HHMM / DDHHMM forms. TAF writes day+hour without
// a month ("1218/1400"), so a day number must be anchored to the month nearest
// a reference instant before it can be compared with a flight time.
//
// The parsing rules here are identical to compactTime() in
// functions/briefing-form.js and functions/api/briefing-xlsx.js, and to the
// inline wxParseTime() in src/Weather_Warning_Ui.html. Keep them in step.
// ============================================================================

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

export const ALT_WINDOW_OFFSET_HOURS = 1;
export const ALT_WINDOW_LENGTH_HOURS = 2;

function pad2(n) {
    return String(n).length < 2 ? '0' + n : String(n);
}

/**
 * Parse one DB time value into UTC components.
 *
 * A colon-delimited clock time is unambiguous, so it wins: this returns the
 * literal clock time of an ISO timestamp without any timezone conversion
 * (a "2026-09-08 08:10:00" value written as local time must not be shifted).
 *
 * @returns {{hh: string, mm: string, label: string, day: number|null,
 *            month: number|null, year: number|null, utcMs: number|null}|null}
 *          null when the value carries no readable clock time.
 */
export function parseTimeToken(value) {
    const s = String(value === null || value === undefined ? '' : value).trim();
    if (!s) return null;

    let hh;
    let mm;
    let day = null;
    let month = null;
    let year = null;

    const withColon = s.match(/(\d{1,2}):(\d{2})/);
    if (withColon) {
        hh = Number(withColon[1]);
        mm = Number(withColon[2]);
        const date = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (date) {
            year = Number(date[1]);
            month = Number(date[2]);
            day = Number(date[3]);
        }
    } else {
        const digits = s.replace(/[^0-9]/g, '');
        if (digits.length === 4) {
            hh = Number(digits.slice(0, 2));
            mm = Number(digits.slice(2, 4));
        } else if (digits.length === 6) {
            day = Number(digits.slice(0, 2));
            hh = Number(digits.slice(2, 4));
            mm = Number(digits.slice(4, 6));
        } else if (digits.length >= 12) {
            year = Number(digits.slice(0, 4));
            month = Number(digits.slice(4, 6));
            day = Number(digits.slice(6, 8));
            hh = Number(digits.slice(8, 10));
            mm = Number(digits.slice(10, 12));
        } else {
            return null;
        }
    }

    if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) return null;
    if (day !== null && !(day >= 1 && day <= 31)) return null;
    if (month !== null && !(month >= 1 && month <= 12)) return null;

    const hasDate = day !== null && month !== null && year !== null;
    return {
        hh: pad2(hh),
        mm: pad2(mm),
        label: pad2(hh) + ':' + pad2(mm),
        day: day,
        month: month,
        year: year,
        utcMs: hasDate ? Date.UTC(year, month - 1, day, hh, mm) : null
    };
}

/**
 * Absolute UTC instant of one flight time point. An ISO value already carries
 * its date; a legacy HH:MM value takes its date from `dof` (YYYYMMDD), so a
 * flight still has an absolute instant when only the clock time is stored.
 *
 * @returns {number|null} epoch ms, or null when no date can be established.
 */
export function flightInstant(raw, dof) {
    const t = parseTimeToken(raw);
    if (!t) return null;
    if (t.utcMs !== null) return t.utcMs;

    const digits = String(dof === null || dof === undefined ? '' : dof).replace(/[^0-9]/g, '');
    if (digits.length < 8) return null;
    const year = Number(digits.slice(0, 4));
    const month = Number(digits.slice(4, 6));
    const day = Number(digits.slice(6, 8));
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
    return Date.UTC(year, month - 1, day, Number(t.hh), Number(t.mm));
}

/**
 * Anchor a TAF day+hour (no month) to the month (−1 / 0 / +1 from the
 * reference) nearest the reference instant. Same rule as tafDate() in
 * shared/taf.mjs, so month rollover resolves the same way everywhere.
 */
export function dayHourNear(day, hour, minute, referenceMs) {
    const reference = new Date(referenceMs);
    let best = null;
    for (const offset of [-1, 0, 1]) {
        const candidate = Date.UTC(
            reference.getUTCFullYear(), reference.getUTCMonth() + offset,
            day, hour, minute || 0
        );
        if (best === null || Math.abs(candidate - referenceMs) < Math.abs(best - referenceMs)) {
            best = candidate;
        }
    }
    return best;
}

const TAF_VALIDITY = /^TAF\s+(?:(?:AMD|COR)\s+)?([A-Z]{4})\s+(?:(\d{2})(\d{2})(\d{2})Z\s+)?(\d{2})(\d{2})\/(\d{2})(\d{2})/;

/**
 * Validity period of a raw TAF, read from the "DDHH/DDHH" group that follows the
 * issue time. Day numbers are anchored to the month nearest `issueMs`.
 *
 * @returns {{startMs: number, endMs: number}|null} null when there is no
 *          readable validity group (for example a "NIL" TAF).
 */
export function parseTafValidity(raw, issueMs) {
    const match = String(raw === null || raw === undefined ? '' : raw).toUpperCase().match(TAF_VALIDITY);
    if (!match) return null;
    // "24" is a legal TAF end hour and means end-of-day: Date.UTC rolls it over.
    const reference = Number.isFinite(issueMs) ? issueMs : Date.now();
    const startMs = dayHourNear(Number(match[5]), Number(match[6]), 0, reference);
    let endMs = dayHourNear(Number(match[7]), Number(match[8]), 0, reference);
    if (endMs <= startMs) endMs += DAY_MS;
    return { startMs: startMs, endMs: endMs };
}

/**
 * Does a TAF validity period cover a leg window?
 *
 * @returns {boolean|null} null when the validity could not be read — callers
 *          must treat that as "do not reject", so an unparseable TAF degrades
 *          to whatever the displayed text says rather than being dropped.
 */
export function validityCoversWindow(validity, windowStartMs, windowEndMs) {
    if (!validity) return null;
    if (!Number.isFinite(windowStartMs)) return null;
    const end = Number.isFinite(windowEndMs) ? windowEndMs : windowStartMs;
    if (end < windowStartMs) return null;
    return validity.endMs > windowStartMs && validity.startMs <= end;
}

/**
 * Leg windows of one flight, in epoch ms. DEP is the STD instant, ARR the STA
 * instant, ALT the fixed STA+1h..STA+3h diversion window the WX page evaluates.
 * Any value is null when the flight has no absolute instant for it.
 *
 * @returns {{dep: [number, number]|null, arr: [number, number]|null,
 *            alt: [number, number]|null, stdMs: number|null, staMs: number|null}}
 */
export function flightLegWindows(etd, eta, dof) {
    const stdMs = flightInstant(etd, dof);
    const staMs = flightInstant(eta, dof);
    return {
        stdMs: stdMs,
        staMs: staMs,
        dep: stdMs === null ? null : [stdMs, stdMs],
        arr: staMs === null ? null : [staMs, staMs],
        alt: staMs === null
            ? null
            : [staMs + ALT_WINDOW_OFFSET_HOURS * HOUR_MS, staMs + (ALT_WINDOW_OFFSET_HOURS + ALT_WINDOW_LENGTH_HOURS) * HOUR_MS]
    };
}

/** Hour-of-day (0-23) of a DB time value, or null. */
export function hourOf(raw) {
    const t = parseTimeToken(raw);
    return t ? Number(t.hh) : null;
}

/**
 * One TAF row per station, keeping the newest issue_time.
 *
 * The `tafs` table accumulates rows (the fetch path INSERTs, it does not upsert),
 * so a reader that just takes "the last row" of an unordered SELECT picks a
 * different forecast depending on physical row order. Every reader — the WX page,
 * the CBR/WX sheet and the plain briefing — must pick the same one, so they all
 * route through here. Rows with an unreadable issue_time rank lowest and only win
 * when a station has nothing better.
 *
 * @returns {Array<object>} the original rows, newest first-wins per station.
 */
export function newestTafRows(rows) {
    const best = new Map();
    (rows || []).forEach(row => {
        const icao = String(row.station || '').trim().toUpperCase();
        if (!icao) return;
        const issueMs = row.issue_time ? new Date(row.issue_time).getTime() : NaN;
        const rank = Number.isFinite(issueMs) ? issueMs : -Infinity;
        const previous = best.get(icao);
        if (previous && previous.rank >= rank) return;
        best.set(icao, { row: row, rank: rank });
    });
    return Array.from(best.values(), entry => entry.row);
}

/** UTC "HH:mm" label for an issue_time value, or "---" when unreadable. */
export function issueClockLabel(issueTime) {
    const issueMs = issueTime ? new Date(issueTime).getTime() : NaN;
    if (!Number.isFinite(issueMs)) return '---';
    const d = new Date(issueMs);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

export { HOUR_MS, MINUTE_MS, DAY_MS };

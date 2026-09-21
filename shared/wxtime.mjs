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
 * Absolute UTC instant of one flight time point.
 *
 * The DATE comes from `dof` (YYYYMMDD) whenever it is readable, and the CLOCK
 * from the time value. That order matters: `dof` is the operator-controlled
 * date of flight, while the date embedded in an ISO `etd`/`eta` can be stale by
 * weeks — real production rows carry `dof=20260917` with
 * `etd='2026-09-08T03:25:00.000Z'` (9 days apart, up to 17 in the sample). Using
 * the embedded date anchored every analysis window to the wrong day, so no TAF
 * validity period could ever intersect a flight window.
 *
 * Without a readable `dof` the embedded date is still better than nothing.
 *
 * @returns {number|null} epoch ms, or null when no date can be established.
 */
export function flightInstant(raw, dof) {
    const t = parseTimeToken(raw);
    if (!t) return null;

    const digits = String(dof === null || dof === undefined ? '' : dof).replace(/[^0-9]/g, '');
    if (digits.length >= 8) {
        const year = Number(digits.slice(0, 4));
        const month = Number(digits.slice(4, 6));
        const day = Number(digits.slice(6, 8));
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            return Date.UTC(year, month - 1, day, Number(t.hh), Number(t.mm));
        }
    }
    return t.utcMs;
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

// Change groups inside a TAF. Kept identical to the split in the inline script of
// src/Weather_Warning_Ui.html so both layers read the same groups.
const TAF_GROUP_SPLIT = /\s+(?=TEMPO|BECMG|FM|PROB|INTER)/;
const TAF_TEMPORARY_GROUP = /(?:TEMPO|PROB|INTER)/;

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
 * Does one TAF change group apply during a leg window?
 *
 * TEMPO/PROB/INTER describe temporary fluctuations, so the group counts when it
 * OVERLAPS the window, not only when the window's first instant falls inside the
 * group. That distinction is what the ALT window exposes: it is two hours wide
 * (STA+1h..STA+3h), so a "TEMPO 0902/0905" group must be seen by an alternate
 * window of 08:50Z–10:50Z even though 08:50Z sits before the group's start.
 *
 * BECMG/FM are permanent: once begun they hold for the rest of the window. For a
 * point window (DEP = STD, ARR = STA, where startMs === endMs) this degenerates
 * exactly to the previous "flight instant inside the group" rule.
 *
 * @returns {boolean} true when the group applies to [startMs, endMs].
 */
function groupActiveForWindow(block, startMs, endMs, anchorMs) {
    const group = block.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
    const fm = block.match(/FM(\d{2})(\d{2})(\d{2})/);
    const temporary = TAF_TEMPORARY_GROUP.test(block);

    if (group) {
        const groupStart = dayHourNear(Number(group[1]), Number(group[2]), 0, anchorMs);
        let groupEnd = dayHourNear(Number(group[3]), Number(group[4]), 0, anchorMs);
        if (groupEnd <= groupStart) groupEnd += DAY_MS;   // group melewati tengah malam
        if (temporary) return groupStart <= endMs && groupEnd >= startMs;
        return groupStart <= endMs;
    }
    if (fm) {
        return dayHourNear(Number(fm[1]), Number(fm[2]), Number(fm[3]), anchorMs) <= endMs;
    }
    return false;
}

/**
 * The TAF blocks that apply to one leg window: the base group plus every change
 * group active during that window.
 *
 * Day numbers are anchored to `anchorMs` — the TAF ISSUE time, the same reference
 * parseTafValidity() uses. Anchoring to the flight instant instead used to move a
 * group to a different month whenever the flight fell outside the validity.
 *
 * When no absolute window is known (for example an unreadable dof) every block is
 * returned: that is the previous behaviour, and guessing is worse than reporting
 * the whole forecast.
 *
 * @returns {string[]} uppercased blocks; [0] is always the base group.
 */
export function tafActiveBlocks(raw, options) {
    const text = String(raw === null || raw === undefined ? '' : raw).toUpperCase();
    if (!text) return [];
    const parts = text.split(TAF_GROUP_SPLIT);
    const opts = options || {};
    const startMs = Number.isFinite(opts.startMs) ? opts.startMs : NaN;
    const endMs = Number.isFinite(opts.endMs) ? opts.endMs : startMs;
    if (!Number.isFinite(startMs)) return parts;
    const anchorMs = Number.isFinite(opts.anchorMs) ? opts.anchorMs : startMs;
    const active = [parts[0]];
    for (let i = 1; i < parts.length; i += 1) {
        if (groupActiveForWindow(parts[i], startMs, endMs, anchorMs)) active.push(parts[i]);
    }
    return active;
}

/**
 * Leg windows of one flight, in epoch ms. DEP is the STD instant, ARR the STA
 * instant, ALT the fixed STA+1h..STA+3h diversion window the WX page evaluates.
 * Any value is null when the flight has no absolute instant for it.
 *
 * An STA clock earlier than the STD clock means the arrival is on the NEXT day
 * (dof + 1) — the same rule the Flight board timeline already applies
 * (`sta > std ? sta : sta + 1440`). Without it an overnight flight gets an ARR
 * window that sits before its own departure, which inverts the window checks.
 *
 * @returns {{dep: [number, number]|null, arr: [number, number]|null,
 *            alt: [number, number]|null, stdMs: number|null, staMs: number|null}}
 */
export function flightLegWindows(etd, eta, dof) {
    const stdMs = flightInstant(etd, dof);
    let staMs = flightInstant(eta, dof);
    if (stdMs !== null && staMs !== null && staMs < stdMs) staMs += DAY_MS;
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

/**
 * Short UTC label of a TAF validity period, for operator-facing messages:
 * "20 12:00Z–21 18:00Z". Empty when the validity is unreadable.
 */
export function tafValidityLabel(validity) {
    if (!validity) return '';
    const stamp = (ms) => {
        const d = new Date(ms);
        return pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + 'Z';
    };
    return stamp(validity.startMs) + '–' + stamp(validity.endMs);
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

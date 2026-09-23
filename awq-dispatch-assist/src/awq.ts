/**
 * Adapter from the AWQ Cloud payloads to the deterministic engine's input.
 *
 * Why this is a separate module
 *   AWQ Cloud names its fields one way and the engine consumes another shape.
 *   Keeping the translation in one place means the engine never grows knowledge
 *   of an upstream wire format, and the wire format can change here without
 *   touching a rule. Everything upstream is read as untrusted: a missing or
 *   wrong-typed field must produce a recorded gap, never a silent default.
 *
 * Data quality problems measured against the live payload (2026-09-21)
 *   1. There is no date-of-flight field. `std` and `sta` appear in two shapes in
 *      the same feed — a bare `HH:MM` and a full ISO instant. The bare shape
 *      carries no date at all, so the date has to be derived.
 *   2. Arrival dates are not rolled over. When a sector crosses midnight the
 *      stored `sta` keeps the departure's calendar day, so the arrival reads
 *      *earlier* than the departure. Observed: std `2026-09-11T23:05:00.000Z`
 *      with sta `2026-09-11T03:00:00.000Z`. Used as-is, this places the arrival
 *      window roughly 23 hours in the past and every TAF would appear not to
 *      cover it.
 *   3. Diversion time, minima, fuel figures and NOTAM are absent from the
 *      payload.
 *
 *   Each is handled explicitly below. Note that (2) is an upstream defect worth
 *   fixing at the source; this adapter corrects it so an assessment is still
 *   possible, and records what it did in `notes`.
 *
 * Every inference is recorded
 *   `notes` is part of the result rather than a log line, so an inferred date
 *   travels with the assessment and can be shown next to the verdict. A silent
 *   guess is exactly what the design forbids.
 */

import type { ApproachMinima, DispatchInput, RouteImpactWarning, SelectedNotam } from './dispatch';

/** One row of the active flight board. */
export type AwqFlight = {
	id: number;
	callsign?: unknown;
	flightNumber?: unknown;
	operator?: unknown;
	origin?: unknown;
	destination?: unknown;
	std?: unknown;
	sta?: unknown;
	/** Operator-controlled date of flight, `YYYYMMDD`. Authoritative when present. */
	dof?: unknown;
	aircraft?: unknown;
	destinationAlternates?: unknown;
	enrouteAlternates?: unknown;
};

/** The flight-weather payload for one flight. */
export type AwqFlightWeather = {
	flightId?: unknown;
	taf?: unknown;
	route?: unknown;
	weatherMonitoring?: unknown;
};

/**
 * A schedule value the engine had to infer or correct.
 *
 * These are surfaced rather than swallowed: the ETA windows are computed from
 * these values, so a human has to confirm them before the assessment can be
 * relied on. `assumed` carries the value the engine proceeded with, so the UI can
 * pre-fill a confirmation instead of asking the operator to type a timestamp.
 */
export type ScheduleAdjustment = {
	field: 'staZ' | 'dof';
	reason: 'arrival-before-departure' | 'date-absent' | 'date-not-authoritative';
	/** The value as published by the feed. */
	raw: string;
	/** The instant the engine assumed, pending confirmation. */
	assumed: string;
	/** Operator-readable explanation. */
	note: string;
};

export type ScheduleResolution = {
	/** Departure, resolved to an absolute Zulu instant. */
	stdZ: Date | null;
	/** Arrival, resolved to an absolute Zulu instant. */
	staZ: Date | null;
	/** Date of flight, taken from the departure instant. */
	dof: Date | null;
	/** What had to be inferred or corrected, in operator-readable form. */
	notes: string[];
	/** True when a human should confirm a date before the assessment is relied on. */
	needsConfirmation: boolean;
	adjustments: ScheduleAdjustment[];
};

/** An operator-supplied correction, which takes precedence over anything inferred. */
export type ScheduleOverride = {
	staZ?: Date | null;
};

export type AdapterResult = {
	input: DispatchInput;
	schedule: ScheduleResolution;
	destinationStation: string | null;
	alternateStation: string | null;
	routeWarnings: RouteImpactWarning[];
	notes: string[];
};

const DAY_MS = 86_400_000;

/**
 * Clock time of a published `std`/`sta` value.
 *
 * Three shapes appear in production: `HH:MM`, `HHMM`, and a full ISO instant. Only
 * the clock is treated as trustworthy; see `nearestClockOccurrence`.
 */
function clockOf(value: string): { hours: number; minutes: number } | null {
	const raw = String(value ?? '').trim();
	if (!raw) return null;
	const colon = /(\d{1,2}):(\d{2})/.exec(raw);
	if (colon) {
		const hours = Number(colon[1]);
		const minutes = Number(colon[2]);
		return hours <= 23 && minutes <= 59 ? { hours, minutes } : null;
	}
	const digits = raw.replace(/[^0-9]/g, '');
	if (digits.length === 4) {
		const hours = Number(digits.slice(0, 2));
		const minutes = Number(digits.slice(2, 4));
		return hours <= 23 && minutes <= 59 ? { hours, minutes } : null;
	}
	return null;
}

/** True when the published value carried a calendar date of its own. */
function hasEmbeddedDate(value: string): boolean {
	return /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(value ?? ''));
}

/** Calendar parts of a `YYYYMMDD` date of flight, or null when unreadable. */
function datePartsOf(value: string): { year: number; month: number; day: number } | null {
	const digits = String(value ?? '').replace(/[^0-9]/g, '');
	if (digits.length < 8) return null;
	const year = Number(digits.slice(0, 4));
	const month = Number(digits.slice(4, 6));
	const day = Number(digits.slice(6, 8));
	return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { year, month, day } : null;
}

/** Exact instant from a date of flight plus the clock carried by a schedule value. */
function instantFromDate(parts: { year: number; month: number; day: number }, raw: string): Date | null {
	const clock = clockOf(raw);
	if (!clock) return null;
	return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, clock.hours, clock.minutes, 0, 0));
}

/** Midnight UTC of the day an instant falls in. */
function startOfUtcDay(instant: Date): Date {
	return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

function text(value: unknown): string {
	return value === null || value === undefined ? '' : String(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Non-empty strings only, so a caller cannot end up with `['']` as an alternate list. */
function stringList(value: unknown): string[] {
	return asArray(value)
		.map(entry => text(entry).trim())
		.filter(entry => entry.length > 0);
}

/**
 * Anchor a clock time to the occurrence nearest `reference`.
 *
 * The date published alongside the clock is deliberately NOT used. AWQ Cloud's own
 * time module documents why (`shared/wxtime.mjs`): the date embedded in an ISO
 * `etd`/`eta` can be stale by weeks — a production row carries `dof=20260917` with
 * an `etd` of `2026-09-08` — so that module resolves flight instants from the
 * operator-controlled date of flight instead. The flight-board payload carries
 * neither a trustworthy date nor a date of flight, so the clock is anchored to the
 * nearest occurrence around the board's own fetch instant. That is what an active
 * board means by "this flight", and it lands an overnight arrival on the following
 * day without needing a special case.
 */
function nearestClockOccurrence(value: string, reference: Date): Date | null {
	const clock = clockOf(value);
	if (!clock) return null;
	const base = Date.UTC(
		reference.getUTCFullYear(),
		reference.getUTCMonth(),
		reference.getUTCDate(),
		clock.hours,
		clock.minutes,
		0,
		0
	);
	let best = base;
	for (const candidate of [base - DAY_MS, base, base + DAY_MS]) {
		if (Math.abs(candidate - reference.getTime()) < Math.abs(best - reference.getTime())) best = candidate;
	}
	return new Date(best);
}

/**
 * Resolve the schedule into Zulu instants.
 *
 * Two paths, and which one runs decides whether a human has to confirm a date.
 *
 *   A. The board published a date of flight. It is the operator-controlled date, so
 *      `dof` plus the clock gives exact instants: nothing is inferred and
 *      `needsConfirmation` is false. AWQ Cloud's own time module resolves flight
 *      instants this way.
 *   B. No date of flight. The board's own fetch instant is then the only anchor, and
 *      the date becomes an inference, which is recorded in `adjustments` and turned
 *      into a finding that holds the verdict below GO until a human confirms it. The
 *      anchored instant is still used, because the ETA windows remain worth reading
 *      while the confirmation is outstanding, but they are explicitly provisional.
 *
 * The date published inside an ISO `std`/`sta` is never used to date the flight on
 * either path: AWQ Cloud documents that it can be stale by weeks.
 *
 * An operator-supplied override short-circuits the inference entirely: once a human
 * has stated the arrival, there is nothing left to confirm.
 */
export function resolveSchedule(flight: AwqFlight, reference: Date, override: ScheduleOverride = {}): ScheduleResolution {
	const stdRaw = text(flight.std).trim();
	const staRaw = text(flight.sta).trim();
	const overridden = override.staZ !== undefined && override.staZ !== null;
	const dateOfFlight = datePartsOf(text(flight.dof));

	// ---- Path A: the date of flight is published, so the instants are read -------
	if (dateOfFlight) {
		const stdZ = instantFromDate(dateOfFlight, stdRaw);
		let staZ = overridden ? override.staZ! : instantFromDate(dateOfFlight, staRaw);
		// An overnight arrival belongs to the following day — the same rule
		// shared/wxtime.mjs applies.
		if (stdZ && staZ && staZ.getTime() <= stdZ.getTime()) staZ = new Date(staZ.getTime() + DAY_MS);

		const notes: string[] = [];
		if (!stdZ) notes.push('Departure time is absent or unreadable, so the departure instant could not be established.');
		if (!staZ) notes.push('Arrival time is absent or unreadable, so no ETA window could be computed.');
		return { stdZ, staZ, dof: stdZ ? startOfUtcDay(stdZ) : null, notes, needsConfirmation: false, adjustments: [] };
	}

	// ---- Path B: no date of flight, so the date is inferred and confirmed --------
	const adjustments: ScheduleAdjustment[] = [];
	let staZ = overridden ? override.staZ! : nearestClockOccurrence(staRaw, reference);
	// The departure is anchored around the confirmed arrival when one was supplied, so
	// confirming a date does not leave the departure sitting on an unconfirmed one.
	const stdZ = nearestClockOccurrence(stdRaw, overridden && staZ ? staZ : reference);

	/**
	 * Record that an instant had to be anchored rather than read.
	 *
	 * `date-not-authoritative` is the common case and is not a complaint about the
	 * operator: the field genuinely carries a date, but that date is not the date of
	 * flight.
	 */
	const recordAnchor = (field: 'staZ' | 'dof', label: string, raw: string, assumed: Date): void => {
		if (!raw || !assumed) return;
		const embedded = hasEmbeddedDate(raw);
		adjustments.push({
			field,
			reason: embedded ? 'date-not-authoritative' : 'date-absent',
			raw,
			assumed: assumed.toISOString(),
			note: embedded
				? `${label} "${raw}" carries a date, but the date published in this field is not the date of flight: AWQ Cloud resolves flight instants from its own date-of-flight field, because this one can be stale by weeks. The clock was anchored to the nearest occurrence around the board reference instant, ${assumed.toISOString()}. Confirm the date.`
				: `${label} "${raw}" carries no date; the clock was anchored to the nearest occurrence around the board reference instant, ${assumed.toISOString()}. Confirm the date.`
		});
	};

	if (!overridden) {
		if (stdZ) recordAnchor('dof', 'Departure time', stdRaw, stdZ);
		if (staZ) recordAnchor('staZ', 'Arrival time', staRaw, staZ);
	}

	// Guard: an arrival cannot precede its departure. The nearest-occurrence rule
	// normally lands an overnight arrival on the next day already, so this only fires
	// on a genuinely odd pair of clock times.
	if (!overridden && stdZ && staZ && staZ.getTime() <= stdZ.getTime()) {
		const corrected = new Date(staZ.getTime() + DAY_MS);
		if (corrected.getTime() > stdZ.getTime()) {
			adjustments.push({
				field: 'staZ',
				reason: 'arrival-before-departure',
				raw: staRaw,
				assumed: corrected.toISOString(),
				note: `Arrival ${staZ.toISOString()} is not after departure ${stdZ.toISOString()}, which cannot be a real sector. The following day was assumed, ${corrected.toISOString()}. Confirm or correct the arrival date before relying on these ETA windows.`
			});
			staZ = corrected;
		}
	}

	const notes = adjustments.map(adjustment => adjustment.note);
	if (!stdZ) notes.push('Departure time is absent or unreadable, so no date of flight could be derived.');
	if (!staZ) notes.push('Arrival time is absent or unreadable, so no ETA window could be computed.');

	return {
		stdZ,
		staZ,
		dof: stdZ ? startOfUtcDay(stdZ) : null,
		notes,
		needsConfirmation: adjustments.length > 0,
		adjustments
	};
}

/** The TAF entries of a flight-weather payload, as records. */
export function toTafEntries(weather: AwqFlightWeather): Array<Record<string, unknown>> {
	return asArray(weather.taf).map(asRecord);
}

/**
 * Select one TAF by its role.
 *
 * Roles observed in the feed: `Departure`, `Destination`, `Destination
 * alternate`, `Enroute alternate 1`. Matching is exact on the trimmed,
 * lower-cased role, because a substring match would let `Destination` capture
 * `Destination alternate`.
 */
export function selectTaf(entries: readonly Record<string, unknown>[], role: string): Record<string, unknown> | null {
	const target = role.trim().toLowerCase();
	return entries.find(entry => text(entry.role).trim().toLowerCase() === target) ?? null;
}

/**
 * Select the TAF issued for one station, whatever role it was filed under.
 *
 * The feed files one TAF per station it has data for: the destination alternate
 * and the en-route alternates each get their own entry, but only the single
 * alternate nominated on the flight carries the `Destination alternate` role.
 * A dispatcher who selects a different alternate therefore has no forecast for
 * it in this payload, and this lookup is what makes that visible instead of
 * quietly evaluating the wrong station's weather.
 */
export function selectTafForStation(
	entries: readonly Record<string, unknown>[],
	station: string | null
): Record<string, unknown> | null {
	const target = text(station).trim().toUpperCase();
	if (!target) return null;
	return entries.find(entry => text(entry.station).trim().toUpperCase() === target) ?? null;
}

/** True when a TAF entry carries report text, rather than `NIL`. */
export function hasUsableTaf(entry: Record<string, unknown> | null): boolean {
	if (!entry) return false;
	const raw = text(entry.raw).trim();
	if (!raw) return false;
	return !/\bNIL\b/i.test(raw);
}

/** True when the feed evaluated this advisory as touching the route. */
function routeHit(warning: Record<string, unknown>): boolean {
	const impact = asRecord(warning.impact);
	return impact.hit === true || text(impact.hit).trim().toLowerCase() === 'true';
}

/**
 * Route-impacting advisories from the weather monitoring block.
 *
 * The feed has already applied its own proximity buffer, so `hit` is taken as
 * the upstream judgement of whether an advisory touches the route rather than
 * being recomputed here.
 */
export function selectRouteWarnings(weather: AwqFlightWeather): RouteImpactWarning[] {
	const monitoring = asRecord(weather.weatherMonitoring);
	return asArray(monitoring.warnings)
		.map(asRecord)
		.filter(routeHit)
		.map(warning => {
			const impact = asRecord(warning.impact);
			const nm = impact.nm;
			return {
				source: text(warning.source).trim() || 'unknown source',
				kind: text(warning.kind).trim() || 'Weather',
				title: text(warning.title).trim() || text(warning.fir).trim() || 'advisory',
				severity: text(impact.severity).trim() || null,
				nm: typeof nm === 'number' && Number.isFinite(nm) ? nm : null
			};
		});
}

/**
 * The feed's own currency verdict for a TAF.
 *
 * `Current` is the only value that satisfies the requirement, matching how the
 * original findings engine treated it; anything else is read as superseded
 * rather than being assumed current.
 */
function currencyOf(entry: Record<string, unknown> | null): 'current' | 'stale' | 'unknown' {
	const status = text(entry?.status).trim().toLowerCase();
	if (!status) return 'unknown';
	return status === 'current' ? 'current' : 'stale';
}

/** Freshness of the weather monitoring block. */
function freshnessOf(weather: AwqFlightWeather): 'fresh' | 'stale' | 'unknown' {
	const value = text(asRecord(weather.weatherMonitoring).freshness).trim().toLowerCase();
	if (!value) return 'unknown';
	return value === 'fresh' ? 'fresh' : 'stale';
}

export type BuildOptions = {
	flight: AwqFlight;
	weather: AwqFlightWeather;
	/** The board's fetch instant, used to date a bare `HH:MM` schedule. */
	reference: Date;
	/** Approved destination landing minima, selected from the minima registry. */
	destinationMinima: ApproachMinima | null;
	/** ICAO of the manually selected primary alternate. */
	alternateIcao: string | null;
	/** Approved landing minima of the selected alternate. */
	alternateLandingMinima: ApproachMinima | null;
	/**
	 * Planning minima the alternate must meet. The caller passes the higher of the
	 * chart's published `Alternate Minima` and the company minima of OM Part A
	 * Table 8.1-5.
	 */
	alternatePlanningMinima: ApproachMinima | null;
	/** NOTAM the dispatcher selected from AWQ Cloud. Empty means the review is pending. */
	selectedNotams: readonly SelectedNotam[];
	/** An operator-stated arrival, which suppresses the schedule inference. */
	scheduleOverride?: ScheduleOverride;
};

/**
 * Translate one flight plus its weather into the engine's input.
 *
 * Absent payload fields are reported in `notes` instead of being defaulted
 * silently, so the assessment can state which checks rest on an assumption.
 */
export function buildDispatchInput(options: BuildOptions): AdapterResult {
	const { flight, weather, reference } = options;
	const schedule = resolveSchedule(flight, reference, options.scheduleOverride ?? {});
	const notes = [...schedule.notes];

	const entries = toTafEntries(weather);
	const destinationStation = text(flight.destination).trim().toUpperCase() || null;
	const destination = selectTaf(entries, 'Destination');
	const alternateStation = text(options.alternateIcao).trim().toUpperCase() || null;
	const nominatedAlternate = selectTaf(entries, 'Destination alternate');
	// Weather is matched by station, not by the feed's role label: the label names
	// the alternate the flight plan nominated, which is not necessarily the one the
	// dispatcher selected.
	const alternate = selectTafForStation(entries, alternateStation);

	if (!hasUsableTaf(destination)) {
		notes.push(`No usable Destination TAF is present for ${destinationStation || 'the destination'} in this payload.`);
	}
	if (!alternateStation) {
		notes.push('No primary alternate was selected, so no alternate forecast could be matched.');
	} else if (!hasUsableTaf(alternate)) {
		const nominated = text(nominatedAlternate?.station).trim().toUpperCase();
		notes.push(
			nominated && nominated !== alternateStation
				? `The payload carries no TAF for the selected alternate ${alternateStation}; its only destination-alternate forecast is for ${nominated}. Select ${nominated}, or treat the alternate as not assessed.`
				: `No usable TAF is present for the selected alternate ${alternateStation} in this payload.`
		);
	}

	// Diversion time is not published by the feed, so the workflow's 2-hour default
	// applies and the alternate window becomes STA +1 hr to +3 hr.
	notes.push('Diversion time is not present in the payload; the 2-hour default is used and the alternate window is STA +1 hr to +3 hr.');
	if (!options.destinationMinima) {
		notes.push('No approved destination minima record was selected; destination compliance cannot be evaluated.');
	}
	if (!options.alternateLandingMinima) {
		notes.push('No approved alternate landing minima record was selected; the destination-alternate TEMPO concession cannot be evaluated.');
	}
	if (!options.alternatePlanningMinima) {
		notes.push('No alternate planning minima is available; alternate suitability cannot be evaluated.');
	}
	notes.push('Fuel figures are not present in the payload; the engine states the holding fuel and standard padding the cited rules require but cannot compare them against an uplift.');
	if (!options.selectedNotams.length) {
		notes.push('No NOTAM has been reviewed for this flight; the NOTAM state is reported as NOTAM REVIEW PENDING, which is not a statement that NOTAM is clear.');
	}

	const routeWarnings = selectRouteWarnings(weather);

	const input: DispatchInput = {
		dof: schedule.dof,
		staZ: schedule.staZ,
		diversionMinutes: null,
		originIcao: text(flight.origin).trim().toUpperCase() || null,
		destinationIcao: destinationStation,
		alternateIcao: alternateStation,
		destinationTaf: hasUsableTaf(destination) ? text(destination!.raw) : null,
		alternateTaf: hasUsableTaf(alternate) ? text(alternate!.raw) : null,
		destinationMinima: options.destinationMinima,
		alternateLandingMinima: options.alternateLandingMinima,
		alternatePlanningMinima: options.alternatePlanningMinima,
		selectedNotams: options.selectedNotams,
		routeImpactWarnings: routeWarnings,
		destinationTafCurrency: currencyOf(destination),
		weatherFreshness: freshnessOf(weather),
		scheduleNeedsConfirmation: schedule.needsConfirmation
	};

	return {
		input,
		schedule,
		destinationStation,
		alternateStation,
		routeWarnings,
		notes
	};
}

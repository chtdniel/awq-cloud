/**
 * TAF decoding for the dispatch evaluation workflow.
 *
 * Why this is a decoder and not a model call
 *   The evaluation rules depend on *which* TAF change group is active inside the
 *   ETA window: a `TEMPO` group that reaches below the planning minima at the
 *   arrival time is a different operational fact from the same values appearing
 *   in the prevailing group. A language model answering that question would be
 *   free to answer it differently on two runs over the same TAF, and the
 *   dispatch verdict is required to be reproducible. Group structure and time
 *   validity are therefore decided here, deterministically, and a model is only
 *   ever allowed to explain the result (see DESIGN.md §10).
 *
 * Scope
 *   The decoder surfaces the elements the workflow actually consumes: wind,
 *   visibility, weather phenomena, cloud amount and ceiling. Temperature, QNH,
 *   wind shear and NOSIG are recognised so they are not reported as malformed
 *   input, but they are not surfaced because no rule reads them.
 *
 * Time model
 *   TAF times are day-of-month plus hour (and minute for the issue time and for
 *   `FM`). A day-of-month is meaningless on its own, so decoding keeps the raw
 *   `DDHH[MM]` shape and resolution to an absolute instant is a separate step,
 *   `resolveTafTime`, which needs the date of flight as its reference. Keeping
 *   the two apart is what lets the same decoder serve a TAF that spans a month
 *   boundary without special-casing it at parse time.
 *
 * Robustness
 *   The upstream TAF string is untrusted. Anything the decoder does not
 *   recognise is collected in `unparsed` rather than dropped, so a silent loss of
 *   a token becomes visible to the caller instead of quietly changing a verdict.
 */

import type { FindingSeverity } from './findings';

/** Day-of-month plus Zulu time, exactly as it appears in a TAF. */
export type TafTime = {
	day: number;
	hour: number;
	minute: number;
};

export type TafWind = {
	/** Null when the direction is variable (`VRB`). */
	directionDeg: number | null;
	speedKt: number | null;
	gustKt: number | null;
	variable: boolean;
};

export type TafCloudLayer = {
	/** `FEW` | `SCT` | `BKN` | `OVC` | `VV`. */
	amount: string;
	/** Base height in feet, or null when the report carried `///`. */
	heightFt: number | null;
	cumulonimbus: boolean;
	toweringCumulus: boolean;
};

export type TafConditions = {
	wind: TafWind | null;
	visibilityM: number | null;
	/** `CAVOK`: visibility 10 km or more, no cloud below 5000 ft, no significant weather. */
	cavok: boolean;
	/** Raw phenomenon codes, e.g. `['TSRA']`. */
	weather: string[];
	thunderstorm: boolean;
	fog: boolean;
	clouds: TafCloudLayer[];
	/** Lowest `BKN`/`OVC`/`VV` base; the operational ceiling. */
	ceilingFt: number | null;
};

/** `PROB` is a bare probability group (`PROB30` without `TEMPO`). */
export type TafChangeType = 'FM' | 'BECMG' | 'TEMPO' | 'INTER' | 'PROB';

export type TafChangeGroup = {
	type: TafChangeType;
	/** 30 or 40 when the group carried a `PROB` qualifier. */
	probability: number | null;
	/** Change instant for `FM`; start of the becoming/fluctuation window otherwise. */
	from: TafTime;
	/** End of the parent validity for `FM`; end of the window otherwise. */
	to: TafTime;
	conditions: TafConditions;
	raw: string;
};

export type TafForecast = {
	station: string | null;
	issuedAt: TafTime | null;
	validFrom: TafTime;
	validTo: TafTime;
	/** Conditions outside any change group. */
	prevailing: TafConditions;
	changes: TafChangeGroup[];
	raw: string;
	/** Tokens the decoder did not recognise. Visible so a silent loss cannot hide. */
	unparsed: string[];
};

/** Result of reading a TAF against one time window. */
export type TafWindowAssessment = {
	/** The TAF validity covers the whole window. */
	covered: boolean;
	/** Conditions prevailing across the window, after completed `FM`/`BECMG`. */
	prevailing: TafConditions;
	/** `FM`/`BECMG` changes that take effect inside the window. */
	transitions: TafChangeGroup[];
	/** `TEMPO`/`INTER`/`PROB` groups whose window intersects this window. */
	conditional: TafChangeGroup[];
	hasInter: boolean;
	hasTempo: boolean;
	/** Worst-case visibility across the prevailing group and every conditional group. */
	worstVisibilityM: number | null;
	/** Worst-case ceiling across the prevailing group and every conditional group. */
	lowestCeilingFt: number | null;
	thunderstorm: boolean;
	fog: boolean;
};

const DESCRIPTORS = new Set(['MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ']);
const PHENOMENA = new Set([
	'DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP',
	'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY', 'PO', 'SQ', 'FC', 'SS', 'DS'
]);

/** Report type and status qualifiers, which carry no operational content. */
const REPORT_PREFIX = /^(TAF|AMD|COR|RTD|NIL)$/;

/** Start of a change group. `PROB` is qualified by its two-digit percentage. */
const CHANGE_MARKER = /^(FM\d{6}|BECMG|TEMPO|INTER|PROB\d{2})$/;

const WIND = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/;
const VISIBILITY = /^[MP]?(\d{4})$/;
const CLOUD = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU)?$/;
const VERTICAL_VISIBILITY = /^VV(\d{3}|\/\/\/)$/;
const VALIDITY = /^\d{4}\/\d{4}$/;
const ISSUE_TIME = /^\d{6}Z$/;

/**
 * Tokens that are valid TAF content but are not consumed by any workflow rule.
 * Recognising them keeps `unparsed` meaningful: the field is meant to reveal
 * genuinely unknown input, not to flag every optional element a TAF may carry.
 */
const NOT_CONSUMED = /^(?:TX|TN)\d{2}\/\d{4}Z$|^Q\d{4}$|^WS\d{3}\/\d{5,6}KT$|^NOSIG$/;

/** Metres per second to knots. TAF is normally KT, but MPS appears in the region. */
const MPS_TO_KT = 1.94384;

/** Visibility implied by CAVOK; used when a comparison needs a number. */
export const CAVOK_VISIBILITY_M = 10_000;

/** Cloud bases at or above this are not a ceiling for planning minima purposes. */
const CEILING_AMOUNTS = new Set(['BKN', 'OVC', 'VV']);

function emptyConditions(): TafConditions {
	return {
		wind: null,
		visibilityM: null,
		cavok: false,
		weather: [],
		thunderstorm: false,
		fog: false,
		clouds: [],
		ceilingFt: null
	};
}

/** Lowest `BKN`/`OVC`/`VV` base, in feet. Null when no layer forms a ceiling. */
export function lowestCeiling(clouds: TafCloudLayer[]): number | null {
	let lowest: number | null = null;
	for (const layer of clouds) {
		if (!CEILING_AMOUNTS.has(layer.amount)) continue;
		if (layer.heightFt === null) continue;
		if (lowest === null || layer.heightFt < lowest) lowest = layer.heightFt;
	}
	return lowest;
}

/**
 * Visibility a comparison can use. `CAVOK` is a statement about visibility
 * (10 km or more) expressed without a visibility group, so treating it as
 * "unknown" would make a clear-weather report fail a minima comparison.
 */
export function effectiveVisibilityM(conditions: TafConditions): number | null {
	if (conditions.visibilityM !== null) return conditions.visibilityM;
	return conditions.cavok ? CAVOK_VISIBILITY_M : null;
}

/** Parse `DDHH` or `DDHHMM`. Hour 24 means the end of that day. */
function parseDayHour(token: string, minute: number): TafTime | null {
	const match = /^(\d{2})(\d{2})(\d{2})?$/.exec(token);
	if (!match) return null;
	const day = Number(match[1]);
	const hour = Number(match[2]);
	if (day < 1 || day > 31 || hour > 24) return null;
	if (hour === 24) return { day: day + 1, hour: 0, minute };
	return { day, hour, minute: match[3] ? Number(match[3]) : minute };
}

function parseWind(token: string): TafWind | null {
	const match = WIND.exec(token);
	if (!match) return null;
	const factor = match[4] === 'MPS' ? MPS_TO_KT : 1;
	return {
		directionDeg: match[1] === 'VRB' ? null : Number(match[1]),
		speedKt: Math.round(Number(match[2]) * factor),
		gustKt: match[3] ? Math.round(Number(match[3]) * factor) : null,
		variable: match[1] === 'VRB'
	};
}

function parseCloud(token: string): TafCloudLayer | null {
	const match = CLOUD.exec(token);
	if (match) {
		return {
			amount: match[1]!,
			heightFt: match[2] === '///' ? null : Number(match[2]) * 100,
			cumulonimbus: match[3] === 'CB',
			toweringCumulus: match[3] === 'TCU'
		};
	}
	const vertical = VERTICAL_VISIBILITY.exec(token);
	if (vertical) {
		return {
			amount: 'VV',
			heightFt: vertical[1] === '///' ? null : Number(vertical[1]) * 100,
			cumulonimbus: false,
			toweringCumulus: false
		};
	}
	return null;
}

/**
 * Split a weather token into its two-character groups.
 *
 * A token is only accepted when every group is a known descriptor or
 * phenomenon *and* at least one phenomenon is present. That second condition is
 * what stops `SH` or `FZ` alone — which are descriptors, not weather — from
 * being read as significant weather, while still accepting `TS` on its own,
 * which is how a thunderstorm without precipitation is reported.
 */
export function parseWeatherToken(token: string): string[] | null {
	const cleaned = token.replace(/^[+-]/, '').replace(/^VC/, '');
	if (cleaned.length < 2 || cleaned.length % 2 !== 0) return null;
	const parts: string[] = [];
	for (let index = 0; index < cleaned.length; index += 2) {
		const part = cleaned.slice(index, index + 2);
		if (!DESCRIPTORS.has(part) && !PHENOMENA.has(part)) return null;
		parts.push(part);
	}
	if (parts.length === 1 && parts[0] === 'TS') return parts;
	if (!parts.some(part => PHENOMENA.has(part))) return null;
	return parts;
}

/** Read the element tokens of one group into conditions. */
function parseConditions(tokens: string[]): { conditions: TafConditions; unparsed: string[] } {
	const conditions = emptyConditions();
	const unparsed: string[] = [];

	for (const token of tokens) {
		if (token === 'CAVOK') {
			conditions.cavok = true;
			continue;
		}
		// NSC / NCD assert the absence of significant cloud. They are recognised as
		// content but do not clear a ceiling inherited from an earlier group; doing
		// so would let a later group silently raise the ceiling.
		if (token === 'NSC' || token === 'NCD') continue;

		const wind = parseWind(token);
		if (wind) {
			conditions.wind = wind;
			continue;
		}
		const visibility = VISIBILITY.exec(token);
		if (visibility) {
			conditions.visibilityM = Number(visibility[1]);
			continue;
		}
		const cloud = parseCloud(token);
		if (cloud) {
			conditions.clouds.push(cloud);
			continue;
		}
		const weather = parseWeatherToken(token);
		if (weather) {
			conditions.weather.push(token);
			if (weather.includes('TS')) conditions.thunderstorm = true;
			if (weather.includes('FG')) conditions.fog = true;
			continue;
		}
		if (NOT_CONSUMED.test(token)) continue;
		unparsed.push(token);
	}

	conditions.ceilingFt = lowestCeiling(conditions.clouds);
	return { conditions, unparsed };
}

/** Split the group tokens into the leading time window and the elements after it. */
function takeWindow(tokens: string[]): { from: TafTime; to: TafTime; rest: string[] } | null {
	const head = tokens[0];
	if (head === undefined || !VALIDITY.test(head)) return null;
	const [fromToken, toToken] = head.split('/');
	const from = parseDayHour(fromToken!, 0);
	const to = parseDayHour(toToken!, 0);
	if (!from || !to) return null;
	return { from, to, rest: tokens.slice(1) };
}

/**
 * Decode a raw TAF.
 *
 * Returns null only when the text is not a TAF at all — no validity period is
 * the one thing that cannot be defaulted, because every window comparison is
 * relative to it. Everything else degrades to a partially populated forecast
 * with the unrecognised tokens reported in `unparsed`.
 */
export function decodeTaf(raw: string): TafForecast | null {
	const text = String(raw ?? '')
		.toUpperCase()
		.replace(/=+\s*$/, '')
		.trim();
	if (!text) return null;

	const tokens = text.split(/\s+/);
	let index = 0;
	while (index < tokens.length && REPORT_PREFIX.test(tokens[index]!)) index += 1;

	const station = tokens[index] !== undefined && /^[A-Z]{4}$/.test(tokens[index]!) ? tokens[index++]! : null;

	const issuedAt = tokens[index] !== undefined && ISSUE_TIME.test(tokens[index]!) ? parseDayHour(tokens[index++]!.slice(0, -1), 0) : null;

	const validityToken = tokens[index];
	if (validityToken === undefined || !VALIDITY.test(validityToken)) return null;
	index += 1;
	const [validFromToken, validToToken] = validityToken.split('/');
	const validFrom = parseDayHour(validFromToken!, 0);
	const validTo = parseDayHour(validToToken!, 0);
	if (!validFrom || !validTo) return null;

	// Group the remaining tokens: a change marker opens a group and the tokens up
	// to the next marker belong to it. The implicit first group is the base
	// (prevailing) conditions.
	const grouped: Array<{ marker: string; tokens: string[] }> = [{ marker: 'BASE', tokens: [] }];
	for (; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		// `PROB40 TEMPO` is one group, not two. Reading the qualifier and the temporal
		// indicator separately would split the group in half and leave the validity
		// window attached to the wrong half.
		if (/^PROB\d{2}$/.test(token) && tokens[index + 1] === 'TEMPO') {
			grouped.push({ marker: `${token} TEMPO`, tokens: [] });
			index += 1;
			continue;
		}
		if (CHANGE_MARKER.test(token)) {
			grouped.push({ marker: token, tokens: [] });
			continue;
		}
		grouped[grouped.length - 1]!.tokens.push(token);
	}

	const unparsed: string[] = [];
	const changes: TafChangeGroup[] = [];
	let prevailing = emptyConditions();

	for (const group of grouped) {
		if (group.marker === 'BASE') {
			const decoded = parseConditions(group.tokens);
			prevailing = decoded.conditions;
			unparsed.push(...decoded.unparsed);
			continue;
		}

		const rawGroup = [group.marker, ...group.tokens].join(' ');
		let type: TafChangeType;
		let probability: number | null = null;
		let body = group.tokens;

		if (group.marker.startsWith('FM')) {
			type = 'FM';
			const instant = parseDayHour(group.marker.slice(2), 0);
			if (!instant) {
				unparsed.push(group.marker, ...group.tokens);
				continue;
			}
			const decoded = parseConditions(body);
			unparsed.push(...decoded.unparsed);
			changes.push({ type, probability, from: instant, to: validTo, conditions: decoded.conditions, raw: rawGroup });
			continue;
		}

		if (group.marker.startsWith('PROB')) {
			probability = Number(group.marker.slice(4, 6));
			// `PROB40 TEMPO ...` is a probability-qualified temporary fluctuation, so
			// it keeps the TEMPO semantics (and with them the 60-minute fuel rule)
			// rather than becoming a separate class.
			type = group.marker.endsWith('TEMPO') ? 'TEMPO' : 'PROB';
		} else {
			type = group.marker as TafChangeType;
		}

		const window = takeWindow(body);
		const from = window ? window.from : validFrom;
		const to = window ? window.to : validTo;
		const elements = window ? window.rest : body;
		const decoded = parseConditions(elements);
		unparsed.push(...decoded.unparsed);
		changes.push({ type, probability, from, to, conditions: decoded.conditions, raw: rawGroup });
	}

	return { station, issuedAt, validFrom, validTo, prevailing, changes, raw: text, unparsed };
}

/**
 * Resolve a TAF day-of-month time to an absolute instant.
 *
 * `reference` is the flight's own time (date of flight at the scheduled time of
 * arrival). The month before and after the reference are both candidates, and
 * the closest one wins. That handles a TAF that spans a month boundary — a
 * report issued on the 31st and valid into the 1st — without the decoder having
 * to know which month it is.
 */
export function resolveTafTime(time: TafTime, reference: Date): Date {
	const year = reference.getUTCFullYear();
	const month = reference.getUTCMonth();
	let best: Date | null = null;
	for (const offset of [-1, 0, 1]) {
		const candidate = new Date(Date.UTC(year, month + offset, time.day, time.hour, time.minute));
		if (best === null || Math.abs(candidate.getTime() - reference.getTime()) < Math.abs(best.getTime() - reference.getTime())) {
			best = candidate;
		}
	}
	return best!;
}

/**
 * Merge a change group's conditions onto the conditions they replace.
 *
 * A change group only states the elements that change, so the unspecified ones
 * carry over. The ceiling is recomputed from whichever cloud set survived rather
 * than copied, because a group that replaces the cloud layers can also remove
 * the ceiling.
 */
export function mergeConditions(base: TafConditions, overlay: TafConditions): TafConditions {
	const clouds = overlay.clouds.length ? overlay.clouds : base.clouds;
	return {
		wind: overlay.wind ?? base.wind,
		visibilityM: overlay.visibilityM ?? base.visibilityM,
		cavok: overlay.cavok || base.cavok,
		weather: overlay.weather.length ? overlay.weather : base.weather,
		thunderstorm: overlay.thunderstorm || base.thunderstorm,
		fog: overlay.fog || base.fog,
		clouds,
		ceilingFt: lowestCeiling(clouds)
	};
}

/**
 * Read a TAF against one time window.
 *
 * `FM` and `BECMG` are permanent: one that has completed before the window opens
 * changes the prevailing conditions, and one that takes effect inside the window
 * is reported as a transition. `TEMPO`/`INTER`/`PROB` are fluctuations and are
 * reported as conditional deteriorations. The worst case across the prevailing
 * group and every conditional group is what a minima comparison must use, since
 * planning has to survive the whole window rather than its best moment.
 */
export function assessTafWindow(taf: TafForecast, windowFrom: Date, windowTo: Date, reference: Date): TafWindowAssessment {
	const validFrom = resolveTafTime(taf.validFrom, reference);
	const validTo = resolveTafTime(taf.validTo, reference);
	const covered = validFrom.getTime() <= windowFrom.getTime() && validTo.getTime() >= windowTo.getTime();

	let prevailing = taf.prevailing;
	const transitions: TafChangeGroup[] = [];
	const conditional: TafChangeGroup[] = [];

	const ordered = [...taf.changes].sort(
		(left, right) => resolveTafTime(left.from, reference).getTime() - resolveTafTime(right.from, reference).getTime()
	);

	for (const group of ordered) {
		const from = resolveTafTime(group.from, reference).getTime();
		const to = resolveTafTime(group.to, reference).getTime();

		if (group.type === 'FM') {
			if (from <= windowFrom.getTime()) {
				prevailing = mergeConditions(prevailing, group.conditions);
			} else if (from < windowTo.getTime()) {
				transitions.push(group);
			}
			continue;
		}

		if (group.type === 'BECMG') {
			if (to <= windowFrom.getTime()) {
				prevailing = mergeConditions(prevailing, group.conditions);
			} else if (from < windowTo.getTime() && to > windowFrom.getTime()) {
				transitions.push(group);
			}
			continue;
		}

		if (from < windowTo.getTime() && to > windowFrom.getTime()) conditional.push(group);
	}

	const visibilities: number[] = [];
	const prevailingVisibility = effectiveVisibilityM(prevailing);
	if (prevailingVisibility !== null) visibilities.push(prevailingVisibility);
	for (const group of conditional) {
		const value = effectiveVisibilityM(group.conditions);
		if (value !== null) visibilities.push(value);
	}

	const ceilings: number[] = [];
	if (prevailing.ceilingFt !== null) ceilings.push(prevailing.ceilingFt);
	for (const group of conditional) {
		if (group.conditions.ceilingFt !== null) ceilings.push(group.conditions.ceilingFt);
	}

	return {
		covered,
		prevailing,
		transitions,
		conditional,
		hasInter: conditional.some(group => group.type === 'INTER'),
		hasTempo: conditional.some(group => group.type === 'TEMPO' || group.type === 'PROB'),
		worstVisibilityM: visibilities.length ? Math.min(...visibilities) : null,
		lowestCeilingFt: ceilings.length ? Math.min(...ceilings) : null,
		thunderstorm: prevailing.thunderstorm || conditional.some(group => group.conditions.thunderstorm),
		fog: prevailing.fog || conditional.some(group => group.conditions.fog)
	};
}

/**
 * Deterministic dispatch evaluation.
 *
 * Why the outcome is computed here and not written by a model
 *   The evaluation workflow ends in an assessment outcome. DESIGN.md §10
 *   requires that a language model may explain findings and cite corpus clauses
 *   but must not determine readiness or decide release, so the outcome is
 *   produced by the rules in this module and the model is handed the result.
 *   Every finding therefore carries the clause references that justify it, and
 *   the same input always yields the same outcome.
 *
 * What the rules are grounded in
 *   Every clause reference in this module was read out of the indexed corpus
 *   before the rule was written. The agreed sources are the two company manuals
 *   (PRD §5); CASR is deliberately absent from this module and from every
 *   reference it emits:
 *
 *     OM Part A 8.1.2.2.3       destination suitability across ETA ± 1 hr
 *     OM Part A 8.1.2.2.4,
 *       Table 8.1-5             planning minima required for a destination
 *                               alternate, and the note that a State-published
 *                               `Alternate Minima` or the company minima,
 *                               whichever is higher, governs
 *     OM Part A 8.1.6 b.iii     the destination alternate TEMPO concession, which
 *                               is available only when the alternate stays above
 *                               its landing minima, the destination is at or above
 *                               destination alternate planning minima, and an
 *                               additional 30 minutes of holding fuel is carried
 *     OM Part A 8.1.6.4,
 *       Table 8.1-20 (cont.),
 *       page 8.1-47             classification of TEMPO/PROB change groups for
 *                               `DEST AT ETA ±1HR`
 *     FDM 5.11 FUEL PADDING
 *       (Standard), page 5.11-16  the standard 10 minutes @ 1500 ft padding
 *
 * Known limitation
 *   The corpus carries the minima *rules*, not per-aerodrome minima *values*
 *   (the minima tables did not survive extraction — see DESIGN.md §9). A minima
 *   value therefore enters this module from the minima registry, where it only
 *   becomes usable after an `ADMIN` dispatcher has compared it against the AIP
 *   chart PDF and approved it. When usable minima is absent the engine does not
 *   infer compliance: it records that minima could not be evaluated, which
 *   produces `REVIEW REQUIRED`.
 *
 * What the engine must never do
 *   No `TEMPO`-without-alternate holding figure is produced. The review of the
 *   source manuals found no company rule requiring 60 minutes of holding for a
 *   destination TEMPO group when no alternate is nominated, so this product does
 *   not state one (PRD §11, acceptance §12).
 */

import type { FindingSeverity } from './findings';
import { RULE_REFERENCES, type ApproachMinima } from './minima';
import {
	assessTafWindow,
	decodeTaf,
	effectiveVisibilityM,
	type TafChangeGroup,
	type TafConditions,
	type TafForecast,
	type TafWindowAssessment
} from './taf';

export type { ApproachMinima, MinimaKind, MinimaRecord, MinimaStatus } from './minima';

/**
 * The assessment outcome.
 *
 * `REVIEW REQUIRED` and `NOTAM REVIEW PENDING` are outcomes, not qualifiers: the
 * product must be able to say that a required piece of data is missing (PRD §12)
 * rather than collapsing that into a low-confidence GO. `MARGINAL` is only ever
 * produced from a threshold a source states; where no source states one, the
 * outcome is `REVIEW REQUIRED` (PRD §12, acceptance §8).
 */
export type DispatchOutcome = 'GO' | 'NO-GO' | 'MARGINAL' | 'REVIEW REQUIRED' | 'NOTAM REVIEW PENDING';

/**
 * Clause references, grouped by the rule they support.
 *
 * Each entry names the document, the clause or table and, where the corpus
 * records it, the printed page. A reference that cannot be resolved to a clause
 * of a company manual must not be emitted, because PRD §5 makes an incomplete
 * citation a `REVIEW REQUIRED` condition rather than a silent omission.
 */
export const CLAUSE_REFERENCES = {
	destinationSuitability: [RULE_REFERENCES.destinationSuitability],
	alternatePlanningMinima: [RULE_REFERENCES.alternatePlanningMinima],
	changeIndicatorTable: [RULE_REFERENCES.changeIndicatorTable, RULE_REFERENCES.belowMinimum],
	destinationAlternateTempo: [RULE_REFERENCES.destinationAlternateTempo],
	fuelPadding: [RULE_REFERENCES.fuelPadding],
	chartSource: [RULE_REFERENCES.chartSource]
} as const;

export type DispatchFindingCode =
	| 'INPUT_INCOMPLETE'
	| 'SCHEDULE_NEEDS_CONFIRMATION'
	| 'TAF_UNPARSEABLE'
	| 'TAF_TOKENS_UNRECOGNISED'
	| 'TAF_WINDOW_NOT_COVERED'
	| 'TAF_NOT_CURRENT'
	| 'TAF_STATUS_UNKNOWN'
	| 'DEST_BELOW_LANDING_MINIMA'
	| 'DEST_CONDITIONAL_DETERIORATION'
	| 'DEST_CONDITIONAL_IMPROVEMENT_IGNORED'
	| 'DEST_CONVECTIVE_WEATHER'
	| 'DEST_LOW_VISIBILITY_PHENOMENA'
	| 'ALT_NOT_NOMINATED'
	| 'ALT_TAF_UNAVAILABLE'
	| 'ALT_BELOW_PLANNING_MINIMA'
	| 'ALT_CONDITIONAL_BELOW_PLANNING_MINIMA'
	| 'ALT_TEMPO_CONCESSION_UNAVAILABLE'
	| 'MINIMA_NOT_AVAILABLE'
	| 'MINIMA_INCOMPLETE'
	| 'NOTAM_REVIEW_PENDING'
	| 'NOTAM_RUNWAY_CLOSURE'
	| 'WX_ROUTE_IMPACT'
	| 'WX_NOT_FRESH'
	| 'WX_FRESHNESS_UNKNOWN'
	| 'FUEL_ADDITIONAL_HOLDING'
	| 'FUEL_PADDING_STANDARD';

export type DispatchFinding = {
	severity: FindingSeverity;
	code: DispatchFindingCode;
	/** States what the data shows. Never a recommendation and never a release decision. */
	message: string;
	evidence: string;
	/** Corpus clauses that justify the finding, so the claim is checkable. */
	references: readonly string[];
	/**
	 * True when the condition is one the workflow treats as incompatible with
	 * release. Kept explicit rather than inferred from severity, because a
	 * critical-but-unassessable condition (unapproved minima) must produce
	 * `REVIEW REQUIRED` rather than a release-blocking outcome.
	 */
	blocksRelease: boolean;
	/**
	 * True when the finding records that required data or a required citation is
	 * missing, rather than a rule that was evaluated and failed. Only these
	 * findings produce `REVIEW REQUIRED`.
	 */
	missingData?: boolean;
	/** The manual states an ambiguous condition here, so `MARGINAL` is a sourced call. */
	marginalByRule?: boolean;
	source: 'system';
};

/** A weather advisory the upstream feed has already evaluated as touching the route. */
export type RouteImpactWarning = {
	source: string;
	kind: string;
	title: string;
	severity: string | null;
	/** Distance from the route, in nautical miles, when the feed states one. */
	nm: number | null;
};

export type EtaWindow = { from: Date; to: Date };

export type EtaWindows = {
	destination: EtaWindow;
	primaryAlternate: EtaWindow;
	/**
	 * True when the alternate window came from the 2-hour default rather than a
	 * published diversion time. The UI and the PDF must state the assumption and
	 * that the source was unavailable (PRD §7, acceptance §3).
	 */
	alternateUsesDefaultDiversionTime: boolean;
};

/**
 * How the fuel requirement is grounded.
 *
 * `no-padding-triggered` and `padding-standard` cover the standard 10 minutes @
 * 1500 ft of FDM 5.11 page 5.11-16. `alternate-tempo-holding` covers the
 * additional 30 minutes of OM Part A 8.1.6 b.iii. Nothing else is produced: the
 * source review found no other fuel rule with a complete citation (PRD §11), and
 * a `TEMPO`-without-alternate holding figure is not part of this product.
 */
export type FuelBasis =
	| 'no-padding-triggered'
	| 'padding-standard'
	| 'alternate-tempo-holding'
	| 'alternate-tempo-holding-with-padding';

/** One triggered criterion of the FDM 5.11 FUEL PADDING table, with its citation. */
export type FuelPaddingCriterion = {
	code: 'destination-below-alternate-planning-minima' | 'destination-low-visibility-thunderstorm';
	/** The criterion as the table words it. */
	statement: string;
	/** What the forecast showed, so the dispatcher can check the trigger. */
	evidence: string;
	minutes: number;
	references: readonly string[];
};

export type FuelRequirement = {
	/** Additional holding fuel the cited manual rules require, in minutes. */
	mandatoryHoldingMinutes: number;
	basis: FuelBasis;
	rationale: string;
	references: readonly string[];
	/** Standard padding from the cited FUEL PADDING table. Discretionary per that table. */
	advisoryPaddingMinutes: number;
	advisoryRationale: string | null;
	/** Every table criterion that fired, so the total is itemised rather than asserted. */
	paddingCriteria: FuelPaddingCriterion[];
};

export type DispatchInput = {
	/** Date of flight. Used as the reference for resolving TAF day-of-month times. */
	dof: Date | null;
	/** Scheduled time of arrival, Zulu. */
	staZ: Date | null;
	/**
	 * Published diversion time to the primary alternate, in minutes. When absent
	 * the engine applies `DEFAULT_DIVERSION_MINUTES` and marks the window as an
	 * assumption so the UI and PDF state it (PRD §7).
	 */
	diversionMinutes: number | null;
	/** Departure aerodrome, for the flight picture in the snapshot and the report. */
	originIcao?: string | null;
	/** Destination aerodrome ICAO. */
	destinationIcao?: string | null;
	/** Raw TAF for the destination. */
	destinationTaf: string | null;
	/** The aerodrome the primary alternate belongs to. */
	alternateIcao?: string | null;
	/** Raw TAF for the primary alternate. */
	alternateTaf: string | null;
	/** Approved destination landing minima, or null when none is usable. */
	destinationMinima: ApproachMinima | null;
	/**
	 * Planning minima the primary alternate must meet — the AIP chart's published
	 * `Alternate Minima`, or the company minima of OM Part A Table 8.1-5,
	 * whichever is higher.
	 */
	alternatePlanningMinima: ApproachMinima | null;
	/**
	 * Landing minima of the primary alternate. The destination-alternate TEMPO
	 * concession of OM Part A 8.1.6 b.iii is only available while the alternate
	 * stays above these, so without them the concession cannot be applied.
	 */
	alternateLandingMinima: ApproachMinima | null;
	/**
	 * NOTAM the dispatcher has selected for this flight. Empty means the check has
	 * not been performed, which is `NOTAM REVIEW PENDING` — never a statement that
	 * NOTAM is clean (PRD §9, acceptance §9).
	 */
	selectedNotams?: readonly SelectedNotam[];
	/**
	 * Route-impacting advisories from the weather monitoring feed (volcanic ash,
	 * tropical cyclone, SIGMET). Optional so the engine still runs without them,
	 * but omitting them removes a hazard from the outcome.
	 */
	routeImpactWarnings?: readonly RouteImpactWarning[];
	/**
	 * The feed's own currency verdict for the destination TAF. Distinct from
	 * window coverage, which this engine computes: a report can cover the window
	 * and still have been superseded. Optional — omitting it skips the check, so
	 * the adapter is expected to always supply it.
	 */
	destinationTafCurrency?: 'current' | 'stale' | 'unknown';
	/** Freshness of the weather monitoring feed. Omitted when not published. */
	weatherFreshness?: 'fresh' | 'stale' | 'unknown';
	/**
	 * True when the schedule had to be inferred or corrected to produce the ETA
	 * windows. The windows are still computed from the assumed value, but they are
	 * provisional until a human confirms the date.
	 */
	scheduleNeedsConfirmation?: boolean;
};

/** A NOTAM the dispatcher selected, with the provenance the snapshot must keep. */
export type SelectedNotam = {
	id: string;
	location: string;
	/** The NOTAM text, as retrieved from AWQ Cloud. */
	message: string;
	validFrom: string | null;
	validTo: string | null;
	riskLevel: string | null;
	/** When the dispatcher retrieved it. */
	fetchedAt: string;
};

/** Classification of one TEMPO/INTER/PROB group for the destination window. */
export type ConditionalClassification = {
	groupType: string;
	/** True when the table applies the group to destination planning minima. */
	applies: boolean;
	/** `transient-showery`, `persistent-continuous`, or `indeterminate`. */
	nature: 'transient-showery' | 'persistent-continuous' | 'indeterminate';
	/** The phenomenon codes that decided the classification. */
	phenomena: readonly string[];
	reference: string;
};

export type DispatchAssessment = {
	outcome: DispatchOutcome;
	windows: EtaWindows | null;
	fuel: FuelRequirement;
	findings: DispatchFinding[];
	destination: TafWindowAssessment | null;
	alternate: TafWindowAssessment | null;
	/** Classification of every conditional group affecting the destination window. */
	destinationConditional: ConditionalClassification[];
	/** True only when the dispatcher selected at least one NOTAM. */
	notamReviewed: boolean;
};

/** Half-width of every ETA window, per the evaluation workflow. */
export const ETA_WINDOW_MINUTES = 60;

/**
 * Diversion time assumed when the feed publishes none, per the evaluation
 * workflow (PRD §7). The resulting alternate window is destination STA +1 hr to
 * +3 hr.
 */
export const DEFAULT_DIVERSION_MINUTES = 120;

/** Section 8.1.6 b.iii requires this much additional holding fuel for the concession. */
export const DESTINATION_ALTERNATE_TEMPO_HOLDING_MINUTES = 30;

/**
 * The standard FUEL PADDING figure from FDM 5.11 page 5.11-16.
 *
 * The printed table lists the category once and applies it to more than one
 * criterion, so each criterion that fires contributes the same figure and an
 * itemised total is reported rather than a single opaque number.
 */
export const STANDARD_FUEL_PADDING_MINUTES = 10;

/** The visibility at or below which the table's TSRA criterion fires. */
export const FUEL_PADDING_VISIBILITY_M = 3000;

const MINUTE_MS = 60_000;

function finding(
	severity: FindingSeverity,
	code: DispatchFindingCode,
	message: string,
	evidence: string,
	references: readonly string[],
	options: { blocksRelease?: boolean; missingData?: boolean; marginalByRule?: boolean } = {}
): DispatchFinding {
	return {
		severity,
		code,
		message,
		evidence,
		references,
		blocksRelease: options.blocksRelease === true,
		missingData: options.missingData === true,
		marginalByRule: options.marginalByRule === true,
		source: 'system'
	};
}

/**
 * ETA windows for the destination and the primary alternate.
 *
 * Destination: `STA ± 1 hr`.
 *
 * Alternate with a published diversion time `D`: `STA + D ± 1 hr`.
 *
 * Alternate without one: the workflow's 2-hour default makes the window
 * `STA + 1 hr` to `STA + 3 hr`, and `alternateUsesDefaultDiversionTime` marks it
 * as an assumption so the UI and PDF state both the default and that the source
 * was unavailable (PRD §7, acceptance §3).
 */
export function computeEtaWindows(staZ: Date, diversionMinutes: number | null): EtaWindows {
	const hasPublished = diversionMinutes !== null && Number.isFinite(diversionMinutes) && diversionMinutes >= 0;
	const diversion = hasPublished ? (diversionMinutes as number) : DEFAULT_DIVERSION_MINUTES;
	const sta = staZ.getTime();
	return {
		destination: {
			from: new Date(sta - ETA_WINDOW_MINUTES * MINUTE_MS),
			to: new Date(sta + ETA_WINDOW_MINUTES * MINUTE_MS)
		},
		primaryAlternate: {
			from: new Date(sta + (diversion - ETA_WINDOW_MINUTES) * MINUTE_MS),
			to: new Date(sta + (diversion + ETA_WINDOW_MINUTES) * MINUTE_MS)
		},
		alternateUsesDefaultDiversionTime: !hasPublished
	};
}

/**
 * Transient or persistent nature of a conditional group, per the
 * `DEST AT ETA ±1HR` column of OM Part A Table 8.1-20 (continued), page 8.1-47.
 *
 * That column distinguishes transient/showery phenomena — thunderstorm and
 * showers — which are `Not applicable` to destination planning, from continuous
 * phenomena — haze, mist, fog, dust or sandstorm and continuous precipitation —
 * which are `Applicable`. Improvements inside these groups are to be disregarded
 * for minima planning.
 *
 * A group carrying both kinds is read as persistent, because the persistent part
 * is what affects planning minima. A group carrying neither is `indeterminate`,
 * which is recorded for review instead of being treated as harmless.
 */
export function classifyConditionalNature(conditions: TafConditions): {
	nature: ConditionalClassification['nature'];
	phenomena: string[];
} {
	const transient = new Set(['TS', 'SH']);
	/**
	 * Continuous phenomena, restricted to the codes that are continuous on their
	 * own. Precipitation is listed here without its descriptors, and the transient
	 * check runs first below, because `TSRA` is a thunderstorm with rain and the
	 * table classifies thunderstorm as transient — reading the `RA` would call it
	 * continuous and defeat the row the table actually states.
	 */
	const persistent = new Set(['HZ', 'BR', 'FG', 'FU', 'DU', 'SA', 'SS', 'DS', 'DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP']);
	const phenomena = conditions.weather.map(code => code.toUpperCase());
	const carries = (set: Set<string>): boolean =>
		phenomena.some(code => {
			for (let index = 0; index + 2 <= code.length; index += 2) {
				if (set.has(code.slice(index, index + 2))) return true;
			}
			return false;
		});
	if (carries(transient)) return { nature: 'transient-showery', phenomena };
	if (carries(persistent)) return { nature: 'persistent-continuous', phenomena };
	return { nature: 'indeterminate', phenomena };
}

/** The table's own wording for a group type, without the probability figure. */
function tableGroupLabel(group: TafChangeGroup): string {
	if (group.type === 'TEMPO') {
		const sameDay = group.to.day === group.from.day;
		return sameDay ? 'TEMPO (alone)' : 'TEMPO FM / TEMPO TL';
	}
	if (group.type === 'PROB') return `PROB ${group.probability ?? ''}`.trim();
	return group.type;
}

/**
 * Classify every conditional group of the destination window.
 *
 * Only `TEMPO`, `INTER` and `PROB` groups are conditional; `FM` and `BECMG` are
 * transitions, which the window assessment already folds into the prevailing
 * conditions. The classification applies to the destination only: the PRD is
 * explicit that it must not be transferred to the alternate without a rule of
 * its own (PRD §8, acceptance §5).
 */
export function classifyDestinationConditionals(assessment: TafWindowAssessment): ConditionalClassification[] {
	return assessment.conditional.map(group => {
		const { nature, phenomena } = classifyConditionalNature(group.conditions);
		return {
			groupType: tableGroupLabel(group),
			applies: nature === 'persistent-continuous',
			nature,
			phenomena,
			reference: RULE_REFERENCES.changeIndicatorTable
		};
	});
}

/**
 * Additional holding fuel and standard fuel padding.
 *
 * Only two grounded figures exist in this release:
 *
 *   30 minutes of additional holding fuel
 *     When a forecast prefixed by TEMPO takes the destination alternate below its
 *     planning minima at ETA ± 1 hr, OM Part A 8.1.6 b.iii keeps the aerodrome
 *     usable as a designated alternate only if the conditions remain above the
 *     applicable landing minima, the destination is at or above destination
 *     alternate planning minima, and the additional 30 minutes is carried.
 *
 *   10 minutes @ 1500 ft of standard padding
 *     FDM 5.11 page 5.11-16, when either printed criterion is met. The table
 *     itself calls padding recommended or advisory and subject to Commander
 *     discretion, so it is reported as padding and never merged into a legal
 *     figure.
 *
 * No other fuel rule is produced. In particular there is no
 * `TEMPO`-without-alternate holding figure, because no company rule stating one
 * was found (PRD §11, acceptance §12).
 */
export function evaluateHoldingFuel(input: {
	/** A conditional group takes the alternate below its planning minima. */
	alternateConditionalBelowPlanningMinima: boolean;
	/** The alternate stays above its applicable landing minima inside the window. */
	alternateAboveLandingMinima: boolean;
	/** The destination is at or above destination alternate planning minima. */
	destinationAtOrAboveAlternatePlanningMinima: boolean;
	/**
	 * Padding criterion 1: at ETA ± 1 hr the destination ceiling or visibility is
	 * at or below the planning minima required for the destination alternate.
	 */
	paddingDestinationBelowAlternatePlanningMinima: boolean;
	/** What the forecast showed for criterion 1. */
	paddingCriterionOneEvidence: string;
	/** Padding criterion 2: at ETA ± 1 hr destination visibility ≤ 3000 m and TSRA. */
	paddingDestinationLowVisibilityThunderstorm: boolean;
	/** What the forecast showed for criterion 2. */
	paddingCriterionTwoEvidence: string;
}): FuelRequirement {
	const paddingCriteria: FuelPaddingCriterion[] = [];
	if (input.paddingDestinationBelowAlternatePlanningMinima) {
		paddingCriteria.push({
			code: 'destination-below-alternate-planning-minima',
			statement:
				'At ETA ± 1 hour the ceiling or visibility at destination is at or below the planning minima required for the destination alternate.',
			evidence: input.paddingCriterionOneEvidence,
			minutes: STANDARD_FUEL_PADDING_MINUTES,
			references: [RULE_REFERENCES.fuelPadding]
		});
	}
	if (input.paddingDestinationLowVisibilityThunderstorm) {
		paddingCriteria.push({
			code: 'destination-low-visibility-thunderstorm',
			statement: `At ETA ± 1 hour the visibility at destination is ${FUEL_PADDING_VISIBILITY_M} m or below and the forecast contains TSRA.`,
			evidence: input.paddingCriterionTwoEvidence,
			minutes: STANDARD_FUEL_PADDING_MINUTES,
			references: [RULE_REFERENCES.fuelPadding]
		});
	}
	const advisoryPaddingMinutes = paddingCriteria.reduce((total, criterion) => total + criterion.minutes, 0);
	const advisoryRationale = advisoryPaddingMinutes
		? `The FUEL PADDING - Standard table (FDM 5.11, printed page 5.11-16) lists ${paddingCriteria.length} criterion matched by this forecast, each contributing ${STANDARD_FUEL_PADDING_MINUTES} minutes at 1500 ft. The table states padding is recommended or advisory and subject to Pilot-in-Command discretion.`
		: null;

	// The concession needs all three conditions the manual states. A missing
	// condition is not a satisfied one: the aerodrome is not treated as a usable
	// alternate on an assumption.
	const concessionAvailable =
		input.alternateConditionalBelowPlanningMinima &&
		input.alternateAboveLandingMinima &&
		input.destinationAtOrAboveAlternatePlanningMinima;

	if (concessionAvailable) {
		return {
			mandatoryHoldingMinutes: DESTINATION_ALTERNATE_TEMPO_HOLDING_MINUTES,
			basis: advisoryPaddingMinutes > 0 ? 'alternate-tempo-holding-with-padding' : 'alternate-tempo-holding',
			rationale:
				'A forecast prefixed by TEMPO takes the destination alternate below its planning minima at ETA ± 1 hour. OM Part A 8.1.6 b.iii keeps the aerodrome usable as a designated alternate when the conditions remain above the applicable landing minima, the destination is at or above destination alternate planning minima, and an additional 30 minutes of holding fuel is carried.',
			references: [RULE_REFERENCES.destinationAlternateTempo, RULE_REFERENCES.alternatePlanningMinima],
			advisoryPaddingMinutes,
			advisoryRationale,
			paddingCriteria
		};
	}

	return {
		mandatoryHoldingMinutes: 0,
		basis: advisoryPaddingMinutes > 0 ? 'padding-standard' : 'no-padding-triggered',
		rationale:
			advisoryPaddingMinutes > 0
				? 'No additional holding fuel is required by a cited rule. Standard fuel padding applies as advisory extra fuel.'
				: 'No cited fuel rule is triggered by the forecast in these windows.',
		references: advisoryPaddingMinutes > 0 ? [RULE_REFERENCES.fuelPadding] : [],
		advisoryPaddingMinutes,
		advisoryRationale,
		paddingCriteria
	};
}

/**
 * Remarks a dispatcher typed for this flight, scanned for a runway or aerodrome
 * closure.
 *
 * Deliberately conservative. The scan only looks for unambiguous closure
 * wording, because a false positive here blocks a release while a false negative
 * merely leaves the NOTAM text visible for review. The text itself is always
 * carried into the assessment, so nothing is hidden by a missed keyword.
 */
export function detectClosureRemarks(remarks: string): string[] {
	const matches = String(remarks ?? '')
		.toUpperCase()
		.match(/\b(?:RWY|RUNWAY|AD|AERODROME|AIRPORT)?\s*(?:CLOSED|CLSD)\b/g);
	return matches ? [...new Set(matches.map(match => match.trim()))] : [];
}

type MinimaComparison = {
	visibilityBelow: boolean;
	ceilingBelow: boolean;
};

/**
 * Compare a visibility/ceiling pair against minima.
 *
 * A missing value on either side is not treated as a pass. `null` visibility in
 * the forecast means the TAF did not state one, and comparing it as if it were
 * unlimited is exactly the silent pass the design forbids; the caller decides
 * how to degrade instead.
 */
export function compareToMinima(
	visibilityM: number | null,
	ceilingFt: number | null,
	minima: ApproachMinima
): MinimaComparison {
	return {
		visibilityBelow: visibilityM !== null && minima.visibilityM !== null && visibilityM < minima.visibilityM,
		ceilingBelow: ceilingFt !== null && minima.ceilingFt !== null && ceilingFt < minima.ceilingFt
	};
}

function describeWeather(assessment: TafWindowAssessment): string {
	const parts: string[] = [];
	parts.push(assessment.worstVisibilityM === null ? 'visibility not stated' : `worst visibility ${assessment.worstVisibilityM} m`);
	parts.push(assessment.lowestCeilingFt === null ? 'ceiling not stated' : `lowest ceiling ${assessment.lowestCeilingFt} ft`);
	if (assessment.thunderstorm) parts.push('thunderstorm');
	if (assessment.fog) parts.push('fog');
	return parts.join(', ');
}

/**
 * The assessment outcome the evidence supports.
 *
 * The order encodes the product's safety rule: a finding that records missing
 * required data is never presented as a clean result and never as a violation
 * either, so it produces `REVIEW REQUIRED` and takes precedence over everything
 * below it. A NOTAM check that has not been performed is its own outcome, which
 * must not be read as "NOTAM clean" (PRD §9, §12).
 *
 * `MARGINAL` is only returned when a finding is explicitly marked as a threshold
 * the manual states (`marginalByRule`). No synthetic threshold is invented here:
 * PRD §12 says that where the manual does not state a threshold, the outcome is
 * `REVIEW REQUIRED`, not an assumed mid-band.
 */
export function deriveOutcome(findings: DispatchFinding[]): DispatchOutcome {
	if (findings.some(item => item.severity === 'CRITICAL' && item.blocksRelease)) return 'NO-GO';
	if (findings.some(item => item.missingData === true)) return 'REVIEW REQUIRED';
	if (findings.some(item => item.code === 'NOTAM_REVIEW_PENDING')) return 'NOTAM REVIEW PENDING';
	if (findings.some(item => item.marginalByRule === true)) return 'MARGINAL';
	if (findings.some(item => item.severity === 'CRITICAL' || item.severity === 'CAUTION')) return 'REVIEW REQUIRED';
	return 'GO';
}

/** Precedence used to order findings for display, highest first. */
function rank(severity: FindingSeverity): number {
	return severity === 'CRITICAL' ? 2 : severity === 'CAUTION' ? 1 : 0;
}

/**
 * True when a minima value states at least one component.
 *
 * Deliberately returns a plain boolean rather than narrowing the argument: the
 * callers keep the value in a local so an unreadable record is reported with its
 * own label and references, which a narrowed `never` branch could not do.
 */
function minimaUsable(minima: ApproachMinima | null): boolean {
	return minima !== null && (minima.ceilingFt !== null || minima.visibilityM !== null);
}

/** The neutral fuel requirement, used when no ETA window could be computed. */
function emptyFuel(): FuelRequirement {
	return evaluateHoldingFuel({
		alternateConditionalBelowPlanningMinima: false,
		alternateAboveLandingMinima: false,
		destinationAtOrAboveAlternatePlanningMinima: false,
		paddingDestinationBelowAlternatePlanningMinima: false,
		paddingCriterionOneEvidence: '',
		paddingDestinationLowVisibilityThunderstorm: false,
		paddingCriterionTwoEvidence: ''
	});
}

/**
 * Evaluate one flight against the agreed dispatch workflow.
 *
 * Order matters: windows first, because everything else is relative to them;
 * then the destination; then the alternate, whose TEMPO concession feeds the
 * fuel calculation; then the NOTAM state, which is its own outcome; and the
 * standard fuel padding last, because it reads the destination comparison.
 */
export function assessDispatch(input: DispatchInput): DispatchAssessment {
	const findings: DispatchFinding[] = [];
	const selectedNotams = input.selectedNotams ?? [];
	const notamReviewed = selectedNotams.length > 0;

	if (input.dof === null || input.staZ === null) {
		findings.push(
			finding(
				'CRITICAL',
				'INPUT_INCOMPLETE',
				'Date of flight or scheduled time of arrival is missing, so no ETA window could be computed.',
				`dof=${input.dof ? input.dof.toISOString() : 'absent'}; staZ=${input.staZ ? input.staZ.toISOString() : 'absent'}`,
				[],
				{ missingData: true }
			)
		);
		return {
			outcome: deriveOutcome(findings),
			windows: null,
			fuel: emptyFuel(),
			findings,
			destination: null,
			alternate: null,
			destinationConditional: [],
			notamReviewed
		};
	}

	const reference = input.staZ;
	const windows = computeEtaWindows(input.staZ, input.diversionMinutes);

	if (input.scheduleNeedsConfirmation) {
		findings.push(
			finding(
				'CAUTION',
				'SCHEDULE_NEEDS_CONFIRMATION',
				'The flight schedule needed a date to be inferred or corrected, so the ETA windows are provisional.',
				'the published schedule does not state these dates unambiguously; confirm the date of flight and the arrival date',
				CLAUSE_REFERENCES.destinationSuitability,
				{ missingData: true }
			)
		);
	}

	// ---- Destination ------------------------------------------------------
	const destinationForecast: TafForecast | null = input.destinationTaf ? decodeTaf(input.destinationTaf) : null;
	let destination: TafWindowAssessment | null = null;
	let destinationConditional: ConditionalClassification[] = [];
	/** Prevailing destination weather is at or above the alternate planning minima. */
	let destinationAtOrAboveAlternatePlanningMinima = false;
	/** Criterion 1 of the FUEL PADDING table matched. */
	let paddingCriterionOne = false;
	let paddingCriterionOneEvidence = '';
	/** Criterion 2 of the FUEL PADDING table matched. */
	let paddingCriterionTwo = false;
	let paddingCriterionTwoEvidence = '';

	if (!destinationForecast) {
		findings.push(
			finding(
				'CRITICAL',
				'TAF_UNPARSEABLE',
				'No readable TAF is available for the destination.',
				input.destinationTaf ? 'destination TAF could not be decoded' : 'destination TAF is absent',
				CLAUSE_REFERENCES.destinationSuitability,
				{ missingData: true }
			)
		);
	} else {
		destination = assessTafWindow(destinationForecast, windows.destination.from, windows.destination.to, reference);
		destinationConditional = classifyDestinationConditionals(destination);

		if (!destination.covered) {
			findings.push(
				finding(
					'CRITICAL',
					'TAF_WINDOW_NOT_COVERED',
					'The destination TAF validity does not cover the whole arrival window.',
					`destination TAF ${destinationForecast.validFrom.day}/${destinationForecast.validFrom.hour}Z-${destinationForecast.validTo.day}/${destinationForecast.validTo.hour}Z against the window ${windows.destination.from.toISOString()}-${windows.destination.to.toISOString()}`,
					CLAUSE_REFERENCES.destinationSuitability,
					{ missingData: true }
				)
			);
		}
		if (destinationForecast.unparsed.length) {
			findings.push(
				finding(
					'CAUTION',
					'TAF_TOKENS_UNRECOGNISED',
					`${destinationForecast.unparsed.length} destination TAF token(s) were not recognised.`,
					destinationForecast.unparsed.join(', '),
					CLAUSE_REFERENCES.destinationSuitability,
					{ marginalByRule: true }
				)
			);
		}

		if (input.destinationTafCurrency === 'stale') {
			findings.push(
				finding(
					'CRITICAL',
					'TAF_NOT_CURRENT',
					'The destination TAF is not current.',
					'the feed reports the destination TAF as superseded or expired',
					CLAUSE_REFERENCES.destinationSuitability,
					{ missingData: true }
				)
			);
		} else if (input.destinationTafCurrency === 'unknown') {
			findings.push(
				finding(
					'CAUTION',
					'TAF_STATUS_UNKNOWN',
					'Destination TAF currency could not be determined.',
					'the feed did not state a status for the destination TAF',
					CLAUSE_REFERENCES.destinationSuitability,
					{ missingData: true }
				)
			);
		}

		// The DEST AT ETA ±1HR column of Table 8.1-20 (continued). A group the table
		// does not apply is recorded as disregarded, with its citation, so the
		// classification itself is auditable rather than invisible.
		for (const classification of destinationConditional) {
			if (classification.nature === 'indeterminate') {
				findings.push(
					finding(
						'CAUTION',
						'DEST_CONDITIONAL_DETERIORATION',
						`A ${classification.groupType} group affects the destination arrival window and carries no phenomenon the change-indicator table classifies.`,
						`group ${classification.groupType}; phenomena ${classification.phenomena.join(', ') || 'none stated'}`,
						[classification.reference],
						{ missingData: true }
					)
				);
			} else if (!classification.applies) {
				findings.push(
					finding(
						'INFO',
						'DEST_CONDITIONAL_IMPROVEMENT_IGNORED',
						`A ${classification.groupType} group affects the destination arrival window and is transient or showery, so the table does not apply it to destination planning minima.`,
						`group ${classification.groupType}; phenomena ${classification.phenomena.join(', ') || 'none stated'}; classification ${classification.nature}`,
						[classification.reference]
					)
				);
			}
		}

		const prevailingVisibility = effectiveVisibilityM(destination.prevailing);
		const destinationMinima = input.destinationMinima;

		if (!destinationMinima) {
			findings.push(
				finding(
					'CAUTION',
					'MINIMA_NOT_AVAILABLE',
					'No approved destination landing minima is available, so compliance could not be assessed.',
					'no approved minima record was selected for the destination approach',
					CLAUSE_REFERENCES.chartSource,
					{ missingData: true }
				)
			);
		} else if (!minimaUsable(destinationMinima)) {
			findings.push(
				finding(
					'CAUTION',
					'MINIMA_INCOMPLETE',
					'Destination minima carries neither a ceiling nor a visibility value, so nothing could be compared against the forecast.',
					`approach "${destinationMinima.approach}" carries neither a ceiling nor a visibility value`,
					[...CLAUSE_REFERENCES.chartSource, ...destinationMinima.references],
					{ missingData: true }
				)
			);
		} else {
			const minima = destinationMinima;
			const prevailingComparison = compareToMinima(prevailingVisibility, destination.prevailing.ceilingFt, minima);
			if (prevailingComparison.visibilityBelow || prevailingComparison.ceilingBelow) {
				findings.push(
					finding(
						'CRITICAL',
						'DEST_BELOW_LANDING_MINIMA',
						'Prevailing destination weather is below the landing minima for the nominated approach.',
						`forecast ${prevailingVisibility === null ? 'visibility not stated' : `${prevailingVisibility} m`} / ${destination.prevailing.ceilingFt === null ? 'ceiling not stated' : `${destination.prevailing.ceilingFt} ft`} against minima ${minima.visibilityM ?? 'n/a'} m / ${minima.ceilingFt ?? 'n/a'} ft for ${minima.approach}`,
						[...CLAUSE_REFERENCES.destinationSuitability, ...minima.references],
						{ blocksRelease: true }
					)
				);
			} else {
				const worstComparison = compareToMinima(destination.worstVisibilityM, destination.lowestCeilingFt, minima);
				if (worstComparison.visibilityBelow || worstComparison.ceilingBelow) {
					findings.push(
						finding(
							'CAUTION',
							'DEST_CONDITIONAL_DETERIORATION',
							'A conditional deterioration in the arrival window reaches below the destination landing minima.',
							`worst case ${describeWeather(destination)} against minima ${minima.visibilityM ?? 'n/a'} m / ${minima.ceilingFt ?? 'n/a'} ft for ${minima.approach}`,
							[...CLAUSE_REFERENCES.destinationSuitability, ...minima.references],
							{ marginalByRule: true }
						)
					);
				}
			}
		}

		if (destination.thunderstorm) {
			findings.push(
				finding(
					'CAUTION',
					'DEST_CONVECTIVE_WEATHER',
					'Thunderstorm activity is forecast in the destination arrival window.',
					describeWeather(destination),
					CLAUSE_REFERENCES.changeIndicatorTable,
					{ marginalByRule: true }
				)
			);
		}
		if (destination.fog) {
			findings.push(
				finding(
					'CAUTION',
					'DEST_LOW_VISIBILITY_PHENOMENA',
					'Fog is forecast in the destination arrival window.',
					describeWeather(destination),
					CLAUSE_REFERENCES.changeIndicatorTable,
					{ marginalByRule: true }
				)
			);
		}

		// ---- Destination checks the fuel rules read --------------------------
		// OM Part A 8.1.6 b.iii condition 2 needs the destination at or above
		// destination alternate planning minima, and criterion 1 of the FUEL PADDING
		// table needs the destination at or below the same figure.
		const destinationPlanningMinima = input.alternatePlanningMinima;
		if (destinationPlanningMinima && minimaUsable(destinationPlanningMinima)) {
			const prevailingAgainstPlanning = compareToMinima(
				prevailingVisibility,
				destination.prevailing.ceilingFt,
				destinationPlanningMinima
			);
			destinationAtOrAboveAlternatePlanningMinima =
				!prevailingAgainstPlanning.visibilityBelow && !prevailingAgainstPlanning.ceilingBelow;
			const worstAgainstPlanning = compareToMinima(
				destination.worstVisibilityM,
				destination.lowestCeilingFt,
				destinationPlanningMinima
			);
			paddingCriterionOne = worstAgainstPlanning.visibilityBelow || worstAgainstPlanning.ceilingBelow;
			paddingCriterionOneEvidence = `worst case ${describeWeather(destination)} against destination alternate planning minima ${destinationPlanningMinima.visibilityM ?? 'n/a'} m / ${destinationPlanningMinima.ceilingFt ?? 'n/a'} ft for ${destinationPlanningMinima.approach}`;
		}

		// Criterion 2 of the FUEL PADDING table. The printed row is `visibility at
		// destination at or below 3,000 m; and TSRA`, so both halves must hold.
		const reportedVisibility = destination.worstVisibilityM ?? prevailingVisibility;
		const tsra = destination.conditional.some(group =>
			group.conditions.weather.some(code => code.toUpperCase().includes('TSRA'))
		);
		paddingCriterionTwo = reportedVisibility !== null && reportedVisibility <= FUEL_PADDING_VISIBILITY_M && tsra;
		paddingCriterionTwoEvidence = `forecast visibility ${reportedVisibility === null ? 'not stated' : `${reportedVisibility} m`} against the ${FUEL_PADDING_VISIBILITY_M} m trigger with TSRA ${tsra ? 'present' : 'absent'} in the arrival window`;
	}

	// ---- Primary alternate ------------------------------------------------
	const alternateForecast: TafForecast | null = input.alternateTaf ? decodeTaf(input.alternateTaf) : null;
	let alternate: TafWindowAssessment | null = null;
	/** A conditional group takes the alternate below its planning minima. */
	let alternateConditionalBelow = false;
	/** The alternate stays above its applicable landing minima, which the TEMPO rule needs. */
	let alternateAboveLandingMinima = false;
	let alternateLandingMinimaKnown = false;

	if (!input.alternateIcao) {
		findings.push(
			finding(
				'CAUTION',
				'ALT_NOT_NOMINATED',
				'No destination alternate has been selected for this flight.',
				'no primary alternate was selected in this assessment',
				CLAUSE_REFERENCES.alternatePlanningMinima,
				{ missingData: true }
			)
		);
	} else if (!alternateForecast) {
		findings.push(
			finding(
				'CAUTION',
				'ALT_TAF_UNAVAILABLE',
				'No readable TAF is available for the selected alternate, so its suitability could not be assessed.',
				input.alternateTaf ? 'alternate TAF could not be decoded' : 'alternate TAF is absent',
				CLAUSE_REFERENCES.alternatePlanningMinima,
				{ missingData: true }
			)
		);
	} else {
		alternate = assessTafWindow(alternateForecast, windows.primaryAlternate.from, windows.primaryAlternate.to, reference);

		if (!alternate.covered) {
			findings.push(
				finding(
					'CAUTION',
					'ALT_TAF_UNAVAILABLE',
					'The alternate TAF validity does not cover the whole diversion window.',
					`alternate TAF ${alternateForecast.validFrom.day}/${alternateForecast.validFrom.hour}Z-${alternateForecast.validTo.day}/${alternateForecast.validTo.hour}Z against the window ${windows.primaryAlternate.from.toISOString()}-${windows.primaryAlternate.to.toISOString()}`,
					CLAUSE_REFERENCES.alternatePlanningMinima,
					{ missingData: true }
				)
			);
		}

		// The TEMPO concession is only available while the alternate stays above its
		// applicable landing minima, so that comparison is made first and separately
		// from the planning comparison.
		const alternateLanding = input.alternateLandingMinima;
		if (alternateLanding && minimaUsable(alternateLanding)) {
			alternateLandingMinimaKnown = true;
			const againstLanding = compareToMinima(alternate.worstVisibilityM, alternate.lowestCeilingFt, alternateLanding);
			alternateAboveLandingMinima = !againstLanding.visibilityBelow && !againstLanding.ceilingBelow;
		}

		const planning = input.alternatePlanningMinima;
		if (!planning || !minimaUsable(planning)) {
			findings.push(
				finding(
					'CAUTION',
					'MINIMA_NOT_AVAILABLE',
					'No approved alternate planning minima is available, so alternate suitability could not be assessed.',
					'no approved minima record or company planning minima was available for the selected alternate',
					CLAUSE_REFERENCES.alternatePlanningMinima,
					{ missingData: true }
				)
			);
		} else {
			const prevailing = compareToMinima(
				effectiveVisibilityM(alternate.prevailing),
				alternate.prevailing.ceilingFt,
				planning
			);
			const worst = compareToMinima(alternate.worstVisibilityM, alternate.lowestCeilingFt, planning);

			if (prevailing.visibilityBelow || prevailing.ceilingBelow) {
				// A persistent shortfall is not something the TEMPO concession covers, so
				// the alternate is not suitable on this forecast alone. It is reported as
				// requiring review rather than as a release-blocking condition: PRD
				// acceptance criterion 10 is explicit that an unsuitable alternate asks
				// the dispatcher for another selection and does not decide the flight.
				findings.push(
					finding(
						'CRITICAL',
						'ALT_BELOW_PLANNING_MINIMA',
						'Prevailing alternate weather is below the alternate planning minima.',
						`forecast ${describeWeather(alternate)} against planning minima ${planning.visibilityM ?? 'n/a'} m / ${planning.ceilingFt ?? 'n/a'} ft for ${planning.approach}`,
						[...CLAUSE_REFERENCES.alternatePlanningMinima, ...planning.references],
						{ marginalByRule: true }
					)
				);
			} else if (worst.visibilityBelow || worst.ceilingBelow) {
				alternateConditionalBelow = true;
				if (!alternateLandingMinimaKnown) {
					findings.push(
						finding(
							'CAUTION',
							'ALT_TEMPO_CONCESSION_UNAVAILABLE',
							'A conditional group takes the alternate below its planning minima, and the landing minima needed to apply the TEMPO concession is not available.',
							`worst case ${describeWeather(alternate)} against planning minima ${planning.visibilityM ?? 'n/a'} m / ${planning.ceilingFt ?? 'n/a'} ft; alternate landing minima was not selected`,
							CLAUSE_REFERENCES.destinationAlternateTempo,
							{ missingData: true }
						)
					);
				}
				findings.push(
					finding(
						'CAUTION',
						'ALT_CONDITIONAL_BELOW_PLANNING_MINIMA',
						'A conditional group takes the alternate below its planning minima within the diversion window.',
						`worst case ${describeWeather(alternate)} against planning minima ${planning.visibilityM ?? 'n/a'} m / ${planning.ceilingFt ?? 'n/a'} ft for ${planning.approach}`,
						[...CLAUSE_REFERENCES.alternatePlanningMinima, ...CLAUSE_REFERENCES.destinationAlternateTempo],
						{ marginalByRule: true }
					)
				);
			}
		}
	}

	// ---- Weather monitoring freshness -------------------------------------
	if (input.weatherFreshness === 'stale') {
		findings.push(
			finding(
				'CAUTION',
				'WX_NOT_FRESH',
				'Weather monitoring data is not fresh.',
				'the feed reports the monitoring block as stale',
				CLAUSE_REFERENCES.destinationSuitability,
				{ missingData: true }
			)
		);
	} else if (input.weatherFreshness === 'unknown') {
		findings.push(
			finding(
				'CAUTION',
				'WX_FRESHNESS_UNKNOWN',
				'Weather monitoring freshness could not be determined.',
				'the feed did not state a freshness value',
				CLAUSE_REFERENCES.destinationSuitability,
				{ missingData: true }
			)
		);
	}

	// ---- Route-impacting weather advisories -------------------------------
	// Reported as critical but deliberately not release-blocking: the upstream feed
	// has decided the advisory touches the route, but whether a hazard at that
	// distance stops a release is an operator judgement, so the engine forces human
	// review instead of making the call itself.
	const routeWarnings = input.routeImpactWarnings ?? [];
	if (routeWarnings.length) {
		findings.push(
			finding(
				'CRITICAL',
				'WX_ROUTE_IMPACT',
				`${routeWarnings.length} route-impacting weather advisor${routeWarnings.length === 1 ? 'y requires' : 'ies require'} review.`,
				routeWarnings
					.map(warning => {
						const distance = warning.nm === null ? 'distance unknown' : `${warning.nm} NM from route`;
						return `${warning.source} ${warning.kind}: ${warning.title} (${warning.severity || 'severity unstated'}, ${distance})`;
					})
					.join('; '),
				CLAUSE_REFERENCES.destinationSuitability,
				{ marginalByRule: true }
			)
		);
	}

	// ---- NOTAM ------------------------------------------------------------
	// Selecting nothing is not the same as finding nothing. An unreviewed NOTAM
	// state is its own outcome so no reader can take it for a clean check.
	if (!notamReviewed) {
		findings.push(
			finding(
				'CAUTION',
				'NOTAM_REVIEW_PENDING',
				'No NOTAM has been selected for this flight, so approach and runway status has not been reviewed.',
				'no NOTAM was selected from the AWQ Cloud NOTAM list; this is not a statement that NOTAM is clear',
				CLAUSE_REFERENCES.chartSource
			)
		);
	} else {
		const closures = selectedNotams.flatMap(notam => detectClosureRemarks(notam.message));
		if (closures.length) {
			findings.push(
				finding(
					'CRITICAL',
					'NOTAM_RUNWAY_CLOSURE',
					'A selected NOTAM indicates a runway or aerodrome closure.',
					[...new Set(closures)].join(', '),
					CLAUSE_REFERENCES.chartSource,
					{ blocksRelease: true }
				)
			);
		}
	}

	// ---- Fuel -------------------------------------------------------------
	const fuel = evaluateHoldingFuel({
		alternateConditionalBelowPlanningMinima: alternateConditionalBelow,
		alternateAboveLandingMinima,
		destinationAtOrAboveAlternatePlanningMinima,
		paddingDestinationBelowAlternatePlanningMinima: paddingCriterionOne,
		paddingCriterionOneEvidence,
		paddingDestinationLowVisibilityThunderstorm: paddingCriterionTwo,
		paddingCriterionTwoEvidence
	});

	const concessionUsed =
		fuel.basis === 'alternate-tempo-holding' || fuel.basis === 'alternate-tempo-holding-with-padding';
	if (alternateConditionalBelow && !concessionUsed) {
		findings.push(
			finding(
				'CAUTION',
				'ALT_TEMPO_CONCESSION_UNAVAILABLE',
				'The destination alternate TEMPO concession is not available for this forecast.',
				`alternate above its landing minima: ${alternateAboveLandingMinima ? 'yes' : 'no'}; destination at or above destination alternate planning minima: ${destinationAtOrAboveAlternatePlanningMinima ? 'yes' : 'no'}; additional 30 minutes holding fuel carried: ${concessionUsed ? 'yes' : 'no'}`,
				CLAUSE_REFERENCES.destinationAlternateTempo,
				{ missingData: true }
			)
		);
	}

	if (fuel.mandatoryHoldingMinutes > 0) {
		findings.push(
			finding(
				'CAUTION',
				'FUEL_ADDITIONAL_HOLDING',
				`Additional holding fuel of ${fuel.mandatoryHoldingMinutes} minutes applies under the cited rule.`,
				fuel.rationale,
				fuel.references,
				{ marginalByRule: true }
			)
		);
	}
	if (fuel.advisoryPaddingMinutes > 0 && fuel.advisoryRationale) {
		findings.push(
			finding(
				'INFO',
				'FUEL_PADDING_STANDARD',
				`Standard fuel padding of ${fuel.advisoryPaddingMinutes} minutes at 1500 ft is recommended.`,
				fuel.paddingCriteria.map(criterion => `${criterion.statement} (${criterion.evidence})`).join(' '),
				CLAUSE_REFERENCES.fuelPadding
			)
		);
	}

	const ordered = [...findings].sort((left, right) => rank(right.severity) - rank(left.severity));
	return {
		outcome: deriveOutcome(ordered),
		windows,
		fuel,
		findings: ordered,
		destination,
		alternate,
		destinationConditional,
		notamReviewed
	};
}

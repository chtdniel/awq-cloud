/**
 * Deterministic dispatch evaluation.
 *
 * Why the verdict is computed here and not written by a model
 *   The evaluation workflow ends in a GO / NO-GO / MARGINAL call. DESIGN.md §10
 *   requires that a language model may explain findings and cite corpus clauses
 *   but must not determine readiness or decide release, so the verdict is
 *   produced by the rules in this module and the model is handed the result.
 *   Every finding therefore carries the clause references that justify it, and
 *   the same input always yields the same verdict.
 *
 * What the rules are grounded in
 *   The clause references below are not generic citations; they are the clauses
 *   that were located in the indexed corpus and read before the rule was written:
 *
 *     OM Part A 8.1.2 (family)  planning minima for destination, en-route and
 *                               isolated alternates, including the rule that a
 *                               TEMPO forecast below planning minima at
 *                               ETA ± 1 hr keeps an aerodrome usable as an
 *                               alternate when an additional 30 minutes of
 *                               holding fuel is carried
 *     OM Part A Table 8.1-17    effect of failed or downgraded equipment on
 *                               landing minima — the basis for an ILS U/S remark
 *     OM Part A 8.1.7.1.2       additional fuel
 *     OM Part A 8.4.4.2.2.1     holding fuel
 *     FDM 4.8.3.5.1, 4.8.4.3   additional fuel
 *     CASR 121.639, 121.646     additional fuel; en-route fuel supply
 *
 * Known limitation
 *   The corpus carries the minima *rules*, not per-aerodrome minima *values*
 *   (the minima tables did not survive extraction — see DESIGN.md §9). A minima
 *   value is therefore an input to this module, supplied from a chart or entered
 *   manually. When it is absent the engine does not infer compliance: it records
 *   that minima could not be evaluated, which caps the verdict below GO.
 */

import type { FindingSeverity } from './findings';
import {
	assessTafWindow,
	decodeTaf,
	effectiveVisibilityM,
	type TafForecast,
	type TafWindowAssessment
} from './taf';

export type DispatchVerdict = 'GO' | 'NO-GO' | 'MARGINAL';

/** Clause references, grouped by the rule they support. */
export const CLAUSE_REFERENCES = {
	planningMinima: ['OM Part A 8.1.2', 'OM Part A 8.1.2.2.3.1'],
	equipmentEffect: ['OM Part A Table 8.1-17'],
	additionalFuel: ['OM Part A 8.1.7.1.2', 'FDM 4.8.3.5.1', 'CASR 121.639'],
	holdingFuel: ['OM Part A 8.4.4.2.2.1'],
	tempoAlternate: ['OM Part A 8.1.2'],
	enRouteFuel: ['CASR 121.646']
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
	| 'DEST_CONVECTIVE_WEATHER'
	| 'DEST_LOW_VISIBILITY_PHENOMENA'
	| 'ALT_NOT_NOMINATED'
	| 'ALT_BELOW_PLANNING_MINIMA'
	| 'ALT_CONDITIONAL_BELOW_PLANNING_MINIMA'
	| 'MINIMA_NOT_AVAILABLE'
	| 'NOTAM_UNVERIFIED'
	| 'NOTAM_RUNWAY_CLOSURE'
	| 'WX_ROUTE_IMPACT'
	| 'WX_NOT_FRESH'
	| 'WX_FRESHNESS_UNKNOWN'
	| 'FUEL_ADDITIONAL_HOLDING'
	| 'FUEL_PADDING_ADVISORY';

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
	 * critical-but-unassessable condition (unknown minima) must degrade the
	 * verdict rather than block it.
	 */
	blocksRelease: boolean;
	source: 'system';
};

/** An approach minima value, from a chart or entered manually. */
export type ApproachMinima = {
	/** Human label, e.g. `ILS RWY 25L` or `RNP RWY 25R`. */
	approach: string;
	/** Decision height / minimum descent height requirement, in feet. */
	ceilingFt: number | null;
	/** RVR or visibility requirement, in metres. */
	visibilityM: number | null;
	/** Clause the value is traceable to. */
	references: readonly string[];
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
};

export type FuelBasis =
	| 'no-conditional-weather'
	| 'compliant-alternate'
	| 'inter-without-alternate'
	| 'tempo-without-alternate'
	| 'alternate-conditional';

export type FuelRequirement = {
	/** Legally required additional holding fuel, in minutes. */
	mandatoryHoldingMinutes: number;
	basis: FuelBasis;
	rationale: string;
	references: readonly string[];
	/** Advisory padding, in minutes. Discretionary, never a legal requirement. */
	advisoryPaddingMinutes: number;
	advisoryRationale: string | null;
};

export type DispatchInput = {
	/** Date of flight. Used as the reference for resolving TAF day-of-month times. */
	dof: Date | null;
	/** Scheduled time of arrival, Zulu. */
	staZ: Date | null;
	/** Estimated diversion time to the primary alternate, in minutes. Defaults to 60. */
	diversionMinutes: number | null;
	/** Raw TAF for the destination. */
	destinationTaf: string | null;
	/** Nominated destination alternates, in priority order. */
	destinationAlternates: string[];
	/** Raw TAF for the primary alternate. */
	alternateTaf: string | null;
	destinationMinima: ApproachMinima | null;
	alternateMinima: ApproachMinima | null;
	/** NOTAM / remarks entered by the dispatcher. Blank means the check is unevaluated. */
	notamRemarks: string | null;
	/**
	 * Route-impacting advisories from the weather monitoring feed (volcanic ash,
	 * tropical cyclone, SIGMET). Optional so the engine still runs without them,
	 * but omitting them removes a hazard from the verdict.
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
	 * windows — for example an arrival that reads earlier than its departure. The
	 * windows are still computed from the assumed value, but they are provisional
	 * until a human confirms the date.
	 */
	scheduleNeedsConfirmation?: boolean;
};

export type DispatchAssessment = {
	verdict: DispatchVerdict;
	windows: EtaWindows | null;
	fuel: FuelRequirement;
	findings: DispatchFinding[];
	destination: TafWindowAssessment | null;
	alternate: TafWindowAssessment | null;
	/** True when NOTAM/remarks were supplied, so the check is not silently skipped. */
	notamEvaluated: boolean;
};

/** Half-width of every ETA window, per the evaluation workflow. */
export const ETA_WINDOW_MINUTES = 60;

/** Diversion time assumed when none is supplied, per the evaluation workflow. */
export const DEFAULT_DIVERSION_MINUTES = 60;

const MINUTE_MS = 60_000;

function finding(
	severity: FindingSeverity,
	code: DispatchFindingCode,
	message: string,
	evidence: string,
	references: readonly string[],
	blocksRelease = false
): DispatchFinding {
	return { severity, code, message, evidence, references, blocksRelease, source: 'system' };
}

/**
 * ETA windows for the destination and the primary alternate.
 *
 * The destination window is STA ± 1 hr. The alternate window is centred on
 * STA + diversion time, which is the earliest the aircraft could realistically
 * arrive at the alternate after a diversion from the destination.
 */
export function computeEtaWindows(staZ: Date, diversionMinutes: number | null): EtaWindows {
	const diversion =
		diversionMinutes === null || !Number.isFinite(diversionMinutes) || diversionMinutes < 0
			? DEFAULT_DIVERSION_MINUTES
			: diversionMinutes;
	const sta = staZ.getTime();
	return {
		destination: {
			from: new Date(sta - ETA_WINDOW_MINUTES * MINUTE_MS),
			to: new Date(sta + ETA_WINDOW_MINUTES * MINUTE_MS)
		},
		primaryAlternate: {
			from: new Date(sta + (diversion - ETA_WINDOW_MINUTES) * MINUTE_MS),
			to: new Date(sta + (diversion + ETA_WINDOW_MINUTES) * MINUTE_MS)
		}
	};
}

/**
 * Mandatory additional holding fuel.
 *
 * The workflow distinguishes two cases. With a compliant destination alternate
 * nominated, the alternate itself satisfies the legal requirement and no
 * additional holding fuel is mandated. Without one, the fluctuation has to be
 * absorbed at the destination: 30 minutes for an `INTER` group and 60 minutes
 * for a `TEMPO` group.
 */
export function evaluateHoldingFuel(input: {
	hasInter: boolean;
	hasTempo: boolean;
	hasCompliantAlternate: boolean;
	hasConvectiveWeather: boolean;
	/**
	 * True when a TEMPO/INTER group takes the destination alternate below its
	 * planning minima inside the diversion window. OM Part A 8.1.2 keeps the
	 * aerodrome usable as an alternate in that case only if additional holding
	 * fuel is carried, which is why this is a fuel input and not only a finding.
	 */
	alternateConditionalBelowMinima?: boolean;
}): FuelRequirement {
	const references = [...CLAUSE_REFERENCES.tempoAlternate, ...CLAUSE_REFERENCES.holdingFuel, ...CLAUSE_REFERENCES.additionalFuel];

	// Shower and thunderstorm activity is the case the workflow names for
	// discretionary padding, because it produces holding that the forecast does
	// not quantify. Padding is advisory and is never folded into the legal figure.
	const advisoryPaddingMinutes = input.hasConvectiveWeather ? 15 : 0;
	const advisoryRationale = input.hasConvectiveWeather
		? 'Convective activity is forecast in the arrival window, which typically produces holding that a TAF does not quantify. Padding is discretionary and is not a legal requirement.'
		: null;

	// The destination rule from the evaluation workflow.
	let destinationMinutes = 0;
	let destinationBasis: FuelBasis = 'no-conditional-weather';
	let destinationRationale = 'No INTER or TEMPO group affects the destination arrival window.';

	if (input.hasInter || input.hasTempo) {
		if (input.hasCompliantAlternate) {
			destinationMinutes = 0;
			destinationBasis = 'compliant-alternate';
			destinationRationale =
				'A conditional deterioration affects the destination arrival window, but a compliant destination alternate is nominated, which satisfies the requirement.';
		} else if (input.hasTempo) {
			destinationMinutes = 60;
			destinationBasis = 'tempo-without-alternate';
			destinationRationale =
				'A TEMPO group affects the destination arrival window and no compliant alternate is nominated, so 60 minutes of additional holding fuel is required.';
		} else {
			destinationMinutes = 30;
			destinationBasis = 'inter-without-alternate';
			destinationRationale =
				'An INTER group affects the destination arrival window and no compliant alternate is nominated, so 30 minutes of additional holding fuel is required.';
		}
	}

	// The alternate rule from OM Part A 8.1.2. Both requirements are "additional
	// holding fuel" for the same flight, so the larger governs rather than their
	// sum, which would count the same holding twice.
	if (input.alternateConditionalBelowMinima && 30 > destinationMinutes) {
		return {
			mandatoryHoldingMinutes: 30,
			basis: 'alternate-conditional',
			rationale:
				'A TEMPO or INTER group takes the destination alternate below its planning minima inside the diversion window, so the alternate remains usable only with 30 minutes of additional holding fuel.',
			references,
			advisoryPaddingMinutes,
			advisoryRationale
		};
	}

	return {
		mandatoryHoldingMinutes: destinationMinutes,
		basis: destinationBasis,
		rationale: destinationRationale,
		references,
		advisoryPaddingMinutes,
		advisoryRationale
	};
}

/**
 * Remarks a dispatcher typed for this flight, scanned for a runway or aerodrome
 * closure.
 *
 * Deliberately conservative. The scan only looks for unambiguous closure
 * wording, because a false positive here blocks a release while a false negative
 * merely leaves the human remark visible for review. The remark text itself is
 * always carried into the assessment, so nothing is hidden by a missed keyword.
 */
export function detectClosureRemarks(remarks: string): string[] {
	const matches = String(remarks ?? '').toUpperCase().match(/\b(?:RWY|RUNWAY|AD|AERODROME|AIRPORT)?\s*(?:CLOSED|CLSD)\b/g);
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
 * Highest verdict the evidence supports.
 *
 * `NO-GO` requires a finding that is both critical and explicitly incompatible
 * with release. A critical condition that merely could not be assessed degrades
 * to `MARGINAL`, so an unknown is never presented as a violation and never as a
 * clean result.
 */
export function deriveVerdict(findings: DispatchFinding[]): DispatchVerdict {
	if (findings.some(item => item.severity === 'CRITICAL' && item.blocksRelease)) return 'NO-GO';
	if (findings.some(item => item.severity === 'CRITICAL' || item.severity === 'CAUTION')) return 'MARGINAL';
	return 'GO';
}

/**
 * Evaluate one flight against the dispatch workflow.
 *
 * Order matters: windows first (everything else is relative to them), then the
 * destination, then the alternate, then fuel, which depends on whether the
 * alternate turned out to be compliant. The NOTAM check is last because its
 * absence caps the verdict rather than changing any of the above.
 */
export function assessDispatch(input: DispatchInput): DispatchAssessment {
	const findings: DispatchFinding[] = [];

	if (input.dof === null || input.staZ === null) {
		findings.push(
			finding(
				'CRITICAL',
				'INPUT_INCOMPLETE',
				'Date of flight or scheduled time of arrival is missing, so no ETA window could be computed.',
				`dof=${input.dof ? input.dof.toISOString() : 'absent'}; staZ=${input.staZ ? input.staZ.toISOString() : 'absent'}`,
				[]
			)
		);
		return {
			verdict: deriveVerdict(findings),
			windows: null,
			fuel: evaluateHoldingFuel({ hasInter: false, hasTempo: false, hasCompliantAlternate: false, hasConvectiveWeather: false }),
			findings,
			destination: null,
			alternate: null,
			notamEvaluated: false
		};
	}

	const reference = input.staZ;
	const windows = computeEtaWindows(input.staZ, input.diversionMinutes);

	// The schedule decided the windows above, so a date that was inferred or
	// corrected has to be confirmed by a human before the windows can be relied
	// on. This caps the verdict below GO rather than blocking outright: the assumed
	// value is usually right, and the assessment is still worth reading while the
	// confirmation is outstanding.
	if (input.scheduleNeedsConfirmation) {
		findings.push(
			finding(
				'CAUTION',
				'SCHEDULE_NEEDS_CONFIRMATION',
				'The flight schedule needed a date to be inferred or corrected, so the ETA windows are provisional.',
				'the published schedule does not state these dates unambiguously; confirm the date of flight and the arrival date',
				[]
			)
		);
	}

	// ---- Destination ------------------------------------------------------
	const destinationForecast: TafForecast | null = input.destinationTaf ? decodeTaf(input.destinationTaf) : null;
	let destination: TafWindowAssessment | null = null;

	if (!destinationForecast) {
		findings.push(
			finding(
				'CRITICAL',
				'TAF_UNPARSEABLE',
				'No readable TAF is available for the destination.',
				input.destinationTaf ? 'destination TAF could not be decoded' : 'destination TAF is absent',
				CLAUSE_REFERENCES.planningMinima
			)
		);
	} else {
		destination = assessTafWindow(destinationForecast, windows.destination.from, windows.destination.to, reference);
		if (!destination.covered) {
			findings.push(
				finding(
					'CRITICAL',
					'TAF_WINDOW_NOT_COVERED',
					'The destination TAF validity does not cover the whole arrival window.',
					`destination TAF ${destinationForecast.validFrom.day}/${destinationForecast.validFrom.hour}Z-${destinationForecast.validTo.day}/${destinationForecast.validTo.hour}Z`,
					CLAUSE_REFERENCES.planningMinima
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
					CLAUSE_REFERENCES.planningMinima
				)
			);
		}

		// Currency is the feed's judgement that the report has not been superseded.
		// It is separate from coverage: a TAF can span the window and still be an
		// out-of-date issue.
		if (input.destinationTafCurrency === 'stale') {
			findings.push(
				finding(
					'CRITICAL',
					'TAF_NOT_CURRENT',
					'The destination TAF is not current.',
					'the feed reports the destination TAF as superseded or expired',
					CLAUSE_REFERENCES.planningMinima
				)
			);
		} else if (input.destinationTafCurrency === 'unknown') {
			findings.push(
				finding(
					'CAUTION',
					'TAF_STATUS_UNKNOWN',
					'Destination TAF currency could not be determined.',
					'the feed did not state a status for the destination TAF',
					CLAUSE_REFERENCES.planningMinima
				)
			);
		}

		const prevailingVisibility = effectiveVisibilityM(destination.prevailing);
		const prevailingComparison = input.destinationMinima
			? compareToMinima(prevailingVisibility, destination.prevailing.ceilingFt, input.destinationMinima)
			: null;

		if (!input.destinationMinima) {
			findings.push(
				finding(
					'CAUTION',
					'MINIMA_NOT_AVAILABLE',
					'No destination landing minima is available, so compliance could not be assessed.',
					'no minima value supplied for the destination approach',
					CLAUSE_REFERENCES.planningMinima
				)
			);
		} else if (prevailingComparison && (prevailingComparison.visibilityBelow || prevailingComparison.ceilingBelow)) {
			findings.push(
				finding(
					'CRITICAL',
					'DEST_BELOW_LANDING_MINIMA',
					'Prevailing destination weather is below the landing minima for the nominated approach.',
					`forecast ${prevailingVisibility === null ? 'visibility not stated' : `${prevailingVisibility} m`} / ${destination.prevailing.ceilingFt === null ? 'ceiling not stated' : `${destination.prevailing.ceilingFt} ft`} against minima ${input.destinationMinima.visibilityM ?? 'n/a'} m / ${input.destinationMinima.ceilingFt ?? 'n/a'} ft for ${input.destinationMinima.approach}`,
					input.destinationMinima.references,
					true
				)
			);
		} else {
			const worstComparison = compareToMinima(destination.worstVisibilityM, destination.lowestCeilingFt, input.destinationMinima);
			if (worstComparison.visibilityBelow || worstComparison.ceilingBelow) {
				findings.push(
					finding(
						'CAUTION',
						'DEST_CONDITIONAL_DETERIORATION',
						'A conditional deterioration in the arrival window reaches below the destination landing minima.',
						`worst case ${describeWeather(destination)} against minima ${input.destinationMinima.visibilityM ?? 'n/a'} m / ${input.destinationMinima.ceilingFt ?? 'n/a'} ft for ${input.destinationMinima.approach}`,
						input.destinationMinima.references
					)
				);
			}
		}

		if (destination.thunderstorm) {
			findings.push(
				finding(
					'CAUTION',
					'DEST_CONVECTIVE_WEATHER',
					'Thunderstorm activity is forecast in the destination arrival window.',
					describeWeather(destination),
					CLAUSE_REFERENCES.planningMinima
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
					[...CLAUSE_REFERENCES.planningMinima, ...CLAUSE_REFERENCES.equipmentEffect]
				)
			);
		}
	}

	// ---- Primary alternate ------------------------------------------------
	const alternateForecast: TafForecast | null = input.alternateTaf ? decodeTaf(input.alternateTaf) : null;
	let alternate: TafWindowAssessment | null = null;
	let alternateCompliant = false;
	/** Set when only a conditional group takes the alternate below planning minima. */
	let alternateConditionalBelow = false;

	if (!input.destinationAlternates.length) {
		findings.push(
			finding(
				'CAUTION',
				'ALT_NOT_NOMINATED',
				'No destination alternate is nominated for this flight.',
				'destinationAlternates is empty',
				CLAUSE_REFERENCES.tempoAlternate
			)
		);
	} else if (!alternateForecast) {
		findings.push(
			finding(
				'CAUTION',
				'ALT_BELOW_PLANNING_MINIMA',
				'No readable TAF is available for the nominated alternate, so its suitability could not be assessed.',
				input.alternateTaf ? 'alternate TAF could not be decoded' : 'alternate TAF is absent',
				CLAUSE_REFERENCES.planningMinima
			)
		);
	} else {
		alternate = assessTafWindow(alternateForecast, windows.primaryAlternate.from, windows.primaryAlternate.to, reference);
		alternateCompliant = alternate.covered;

		if (input.alternateMinima) {
			const prevailing = compareToMinima(
				effectiveVisibilityM(alternate.prevailing),
				alternate.prevailing.ceilingFt,
				input.alternateMinima
			);
			const worst = compareToMinima(alternate.worstVisibilityM, alternate.lowestCeilingFt, input.alternateMinima);

			if (prevailing.visibilityBelow || prevailing.ceilingBelow) {
				// A persistent shortfall is not something the TEMPO concession covers.
				alternateCompliant = false;
				findings.push(
					finding(
						'CRITICAL',
						'ALT_BELOW_PLANNING_MINIMA',
						'Prevailing alternate weather is below the alternate planning minima.',
						`forecast ${describeWeather(alternate)} against planning minima ${input.alternateMinima.visibilityM ?? 'n/a'} m / ${input.alternateMinima.ceilingFt ?? 'n/a'} ft for ${input.alternateMinima.approach}`,
						[...CLAUSE_REFERENCES.planningMinima, ...input.alternateMinima.references],
						true
					)
				);
			} else if (worst.visibilityBelow || worst.ceilingBelow) {
				// OM Part A 8.1.2 keeps the aerodrome usable as an alternate under a
				// TEMPO forecast below planning minima, provided the conditions stay
				// above landing minima and additional holding fuel is carried. The
				// fuel consequence is applied through `alternateConditionalBelow`.
				alternateConditionalBelow = true;
				findings.push(
					finding(
						'CAUTION',
						'ALT_CONDITIONAL_BELOW_PLANNING_MINIMA',
						'A TEMPO forecast takes the alternate below its planning minima within the diversion window.',
						`worst case ${describeWeather(alternate)} against planning minima ${input.alternateMinima.visibilityM ?? 'n/a'} m / ${input.alternateMinima.ceilingFt ?? 'n/a'} ft for ${input.alternateMinima.approach}`,
						[...CLAUSE_REFERENCES.planningMinima, ...CLAUSE_REFERENCES.holdingFuel]
					)
				);
			}
		} else {
			alternateCompliant = false;
			findings.push(
				finding(
					'CAUTION',
					'MINIMA_NOT_AVAILABLE',
					'No alternate planning minima is available, so alternate suitability could not be assessed.',
					'no planning minima value supplied for the alternate',
					CLAUSE_REFERENCES.planningMinima
				)
			);
		}
	}

	// ---- Weather monitoring freshness -------------------------------------
	// Carried over from the original findings engine so migrating to this one
	// does not drop the check: a stale monitoring feed means the advisories below
	// may not reflect current hazard information.
	if (input.weatherFreshness === 'stale') {
		findings.push(
			finding(
				'CAUTION',
				'WX_NOT_FRESH',
				'Weather monitoring data is not fresh.',
				'the feed reports the monitoring block as stale',
				CLAUSE_REFERENCES.planningMinima
			)
		);
	} else if (input.weatherFreshness === 'unknown') {
		findings.push(
			finding(
				'CAUTION',
				'WX_FRESHNESS_UNKNOWN',
				'Weather monitoring freshness could not be determined.',
				'the feed did not state a freshness value',
				CLAUSE_REFERENCES.planningMinima
			)
		);
	}

	// ---- Route-impacting weather advisories -------------------------------
	// Reported as critical but deliberately not release-blocking by this engine.
	// The upstream feed has already decided the advisory touches the route, but
	// whether a hazard at that distance stops a release is an operator judgement
	// (volcanic ash and a distant tropical cyclone are not the same decision), so
	// the engine forces human review instead of making the call itself.
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
				CLAUSE_REFERENCES.planningMinima
			)
		);
	}

	// ---- NOTAM / remarks --------------------------------------------------
	const remarks = String(input.notamRemarks ?? '').trim();
	const notamEvaluated = remarks.length > 0;
	if (!notamEvaluated) {
		findings.push(
			finding(
				'CAUTION',
				'NOTAM_UNVERIFIED',
				'No NOTAM or remarks were provided, so approach and runway status could not be checked.',
				'notamRemarks is blank',
				CLAUSE_REFERENCES.equipmentEffect
			)
		);
	} else {
		const closures = detectClosureRemarks(remarks);
		if (closures.length) {
			findings.push(
				finding(
					'CRITICAL',
					'NOTAM_RUNWAY_CLOSURE',
					'The supplied remarks indicate a runway or aerodrome closure.',
					closures.join(', '),
					CLAUSE_REFERENCES.equipmentEffect,
					true
				)
			);
		}
	}

	// ---- Fuel -------------------------------------------------------------
	const hasConvective = destination !== null && destination.thunderstorm;
	const fuel = evaluateHoldingFuel({
		hasInter: destination?.hasInter ?? false,
		hasTempo: destination?.hasTempo ?? false,
		hasCompliantAlternate: alternateCompliant,
		hasConvectiveWeather: hasConvective,
		alternateConditionalBelowMinima: alternateConditionalBelow
	});

	if (fuel.mandatoryHoldingMinutes > 0) {
		findings.push(
			finding(
				'CAUTION',
				'FUEL_ADDITIONAL_HOLDING',
				`Additional holding fuel of ${fuel.mandatoryHoldingMinutes} minutes is required.`,
				fuel.rationale,
				fuel.references
			)
		);
	}
	if (fuel.advisoryPaddingMinutes > 0 && fuel.advisoryRationale) {
		findings.push(
			finding('INFO', 'FUEL_PADDING_ADVISORY', `Advisory fuel padding of ${fuel.advisoryPaddingMinutes} minutes is recommended.`, fuel.advisoryRationale, [
				...CLAUSE_REFERENCES.additionalFuel,
				...CLAUSE_REFERENCES.enRouteFuel
			])
		);
	}

	const ordered = [...findings].sort((left, right) => rank(right.severity) - rank(left.severity));
	return {
		verdict: deriveVerdict(ordered),
		windows,
		fuel,
		findings: ordered,
		destination,
		alternate,
		notamEvaluated
	};
}

function rank(severity: FindingSeverity): number {
	return severity === 'CRITICAL' ? 2 : severity === 'CAUTION' ? 1 : 0;
}

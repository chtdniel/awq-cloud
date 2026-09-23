/**
 * Minima types and the company minima defaults.
 *
 * Two kinds of minima live in this product and they must not be confused:
 *
 *   Landing minima
 *     Numeric values published on an AIP approach chart (DA/H, MDA/H, RVR or
 *     visibility) for one aerodrome, runway, approach and aircraft category. The
 *     AIP is the source of these numbers (PRD §5). They are entered into the
 *     minima registry as drafts by AI extraction and become usable only after an
 *     `ADMIN` dispatcher compares them against the source PDF and approves them.
 *
 *   Planning minima
 *     The company rule that says which landing minima an aerodrome must meet to
 *     be usable as a destination alternate, en-route alternate or take-off
 *     alternate. This is a rule, not a chart value, and it is cited from
 *     Operations Manual Part A `8.1.2.2.4`, Table 8.1-5.
 *
 * The engine consumes both. A landing value with no approved source is not
 * usable, and a planning rule with no landing value to apply to produces
 * `REVIEW REQUIRED` rather than an assumed pass.
 */

/** A ceiling / visibility pair, in the units the chart publishes. */
export type ApproachMinima = {
	/** Human label, e.g. `ILS RWY 03` or `RNP RWY 21`. */
	approach: string;
	/** Decision height / minimum descent height, in feet. */
	ceilingFt: number | null;
	/** RVR or visibility requirement, in metres. */
	visibilityM: number | null;
	/** Clause the value is traceable to. */
	references: readonly string[];
};

/** Operational purpose of a minima value. */
export type MinimaKind = 'landing' | 'alternate';

/** Review states of a minima record. Only `approved` is usable by an assessment. */
export type MinimaStatus = 'draft' | 'approved' | 'superseded' | 'rejected';

/**
 * A minima value in the approved registry, with the provenance an audit needs.
 *
 * `id` and `contentHash` travel into the assessment snapshot, so a verdict can
 * always be traced to the exact record revision it was computed from even after
 * the record is later changed.
 */
export type MinimaRecord = {
	id: number;
	sourceObjectKey: string;
	pdfHash: string;
	aisAuthority: string;
	country: string;
	icao: string;
	chartIdentifier: string;
	chartPage: string | null;
	runway: string | null;
	approach: string;
	approachType: string | null;
	aircraftCategory: string | null;
	kind: MinimaKind;
	ceilingFt: number | null;
	visibilityM: number | null;
	valueType: string | null;
	aipCycle: string | null;
	effectiveFrom: string | null;
	effectiveTo: string | null;
	/** Model that produced the draft this record started as, for extraction provenance. */
	extractionModel: string | null;
	/** How sure the extractor was; `low` is a prompt to read the chart. */
	extractionConfidence: 'high' | 'medium' | 'low' | null;
	/** Extractor or reviewer notes, including values that were not readable. */
	reviewNotes: string | null;
	status: MinimaStatus;
	approvedBy: number | null;
	approvedAt: string | null;
	/** The record that replaced this one, when it was superseded. */
	supersededBy: number | null;
	contentHash: string;
	createdBy: number | null;
	createdAt: string;
	updatedAt: string;
};

/**
 * Clause references for the minima rules the engine applies.
 *
 * Every reference names the document number and the clause or table, so a
 * finding that carries it can be checked against the source manual. Operations
 * Manual Part A is `IAA/FOP/M/001` and the Flight Dispatch Manual is
 * `IAA/FOP/M/008` (PRD §5). No reference in this product points at CASR: the
 * agreed rule sources are the two company manuals (PRD §5, acceptance §15).
 */
export const RULE_REFERENCES = {
	/** OM Part A 8.1.6: interpretation of meteorological information. */
	changeIndicatorTable: 'OM Part A 8.1.6.4, Table 8.1-20 (continued), page 8.1-47',
	/** OM Part A 8.1.6 b.iii: destination alternate TEMPO concession. */
	destinationAlternateTempo: 'OM Part A 8.1.6 b.iii, page 8.1-41',
	/** OM Part A 8.1.2.2.4, Table 8.1-5: planning minima for a destination alternate. */
	alternatePlanningMinima: 'OM Part A 8.1.2.2.4, Table 8.1-5, page 8.1-11',
	/** OM Part A 8.1.2.2.3: destination suitability window. */
	destinationSuitability: 'OM Part A 8.1.2.2.3',
	/** Flight Dispatch Manual 5.11, FUEL PADDING table, printed page 5.11-16. */
	fuelPadding: 'FDM 5.11 FUEL PADDING (Standard), page 5.11-16',
	/** AIP chart is the numeric source for landing minima. */
	chartSource: 'AIP approach chart (minima source)',
	/** OM Part A 8.1.6.1.1: when an aerodrome is below minimum for planning. */
	belowMinimum: 'OM Part A 8.1.6.1.1, page 8.1-45'
} as const;

/** Approach types whose planning minima is expressed as a CAT I RVR (Table 8.1-5). */
const PRECISION_CAT_II_III = /\bCAT\s*(II|III|2|3)\b/i;
const PRECISION_CAT_I = /\bCAT\s*(I|1)\b/i;
const CIRCLING = /circling/i;

/** The 200 ft / 1000 m increment Table 8.1-5 adds to a non-precision minima. */
export const NON_PRECISION_PLANNING_INCREMENT_FT = 200;
export const NON_PRECISION_PLANNING_INCREMENT_M = 1000;

/**
 * Company planning minima for a destination alternate, from OM Part A Table 8.1-5.
 *
 * The table is read as:
 *   CAT II and III  -> CAT 1 RVR
 *   CAT I           -> non-precision approach minima (ceiling / RVR or VIS)
 *   Non-precision   -> non-precision approach minima plus 200 ft / 1000 m
 *   Circling        -> (MDH + 200 ft) / (RVR + 1000 m) or (VIS + 1000 m)
 *
 * The note under the table takes precedence when the State publishes alternate
 * minima: `the applicable minima are those specified under "Alternate Minima" on
 * the airport chart or Company alternate minima whichever is higher`. That
 * comparison is applied by `higherMinima`, and the caller is expected to pass the
 * chart-published alternate minima when the chart has one.
 *
 * A CAT II/III approach planning minima is published as a CAT I RVR, which is a
 * visibility figure with no ceiling component. Returning `null` for the ceiling
 * is deliberate: inventing a CAT I decision height here would manufacture a
 * limit the table does not state, and the engine treats a null component as
 * "not compared", never as a pass.
 */
export function planningMinimaForAlternate(landing: ApproachMinima, approachType: string | null): ApproachMinima {
	const label = `Alternate planning minima for ${landing.approach}`;
	const type = String(approachType ?? '');

	if (PRECISION_CAT_II_III.test(type)) {
		return {
			approach: label,
			ceilingFt: null,
			visibilityM: landing.visibilityM,
			references: [RULE_REFERENCES.alternatePlanningMinima]
		};
	}

	if (CIRCLING.test(type)) {
		return {
			approach: label,
			ceilingFt: landing.ceilingFt === null ? null : landing.ceilingFt + NON_PRECISION_PLANNING_INCREMENT_FT,
			visibilityM: landing.visibilityM === null ? null : landing.visibilityM + NON_PRECISION_PLANNING_INCREMENT_M,
			references: [RULE_REFERENCES.alternatePlanningMinima]
		};
	}

	if (PRECISION_CAT_I.test(type)) {
		return {
			approach: label,
			ceilingFt: landing.ceilingFt,
			visibilityM: landing.visibilityM,
			references: [RULE_REFERENCES.alternatePlanningMinima]
		};
	}

	return {
		approach: label,
		ceilingFt: landing.ceilingFt === null ? null : landing.ceilingFt + NON_PRECISION_PLANNING_INCREMENT_FT,
		visibilityM: landing.visibilityM === null ? null : landing.visibilityM + NON_PRECISION_PLANNING_INCREMENT_M,
		references: [RULE_REFERENCES.alternatePlanningMinima]
	};
}

/**
 * The higher of two minima, component by component.
 *
 * The Table 8.1-5 note asks for the higher of the chart's published alternate
 * minima and the company minima, and a component that only one side states is
 * taken as stated rather than treated as zero.
 */
export function higherMinima(chart: ApproachMinima, company: ApproachMinima): ApproachMinima {
	const higher = (left: number | null, right: number | null): number | null => {
		if (left === null) return right;
		if (right === null) return left;
		return Math.max(left, right);
	};
	return {
		approach: chart.approach,
		ceilingFt: higher(chart.ceilingFt, company.ceilingFt),
		visibilityM: higher(chart.visibilityM, company.visibilityM),
		references: [...new Set([...chart.references, ...company.references])]
	};
}

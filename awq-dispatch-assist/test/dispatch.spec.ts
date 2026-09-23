import { describe, expect, it } from 'vitest';
import {
	assessDispatch,
	classifyConditionalNature,
	compareToMinima,
	computeEtaWindows,
	detectClosureRemarks,
	deriveOutcome,
	evaluateHoldingFuel,
	type ApproachMinima,
	type DispatchFinding,
	type DispatchInput,
	type SelectedNotam
} from '../src/dispatch';
import { planningMinimaForAlternate, higherMinima } from '../src/minima';

/**
 * Dispatch engine contract tests.
 *
 * These pin the agreed evaluation workflow: the ETA windows and the 2-hour
 * default diversion time, the destination TEMPO classification of OM Part A
 * Table 8.1-20 (continued) page 8.1-47, the destination alternate TEMPO
 * concession of OM Part A 8.1.6 b.iii, the standard FUEL PADDING criteria of FDM
 * 5.11 page 5.11-16, and the rules that keep unapproved minima or an unreviewed
 * NOTAM out of a clean outcome.
 *
 * The bounds worth defending are the ones asserted here by name:
 *   - the product never states a `TEMPO`-without-alternate holding figure,
 *   - a destination TEMPO classification is never applied to the alternate,
 *   - missing or unapproved minima produce `REVIEW REQUIRED`, never a pass,
 *   - an unreviewed NOTAM produces `NOTAM REVIEW PENDING`, never a clean check,
 *   - no finding cites CASR.
 */

const STA = new Date(Date.UTC(2026, 8, 21, 20, 0, 0));
const DOF = new Date(Date.UTC(2026, 8, 21));

const DEST_TAF = 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020';
const ALT_TAF = 'TAF WADD 211700Z 2118/2224 09008KT 9999 SCT020';

const MINIMA: ApproachMinima = {
	approach: 'ILS RWY 25L',
	ceilingFt: 500,
	visibilityM: 1500,
	references: ['Airservices Australia AIP WIII ILS RWY 25L']
};

/** A selected NOTAM, so the NOTAM review counts as performed. */
const NOTAM: SelectedNotam = {
	id: 'A1234/26',
	location: 'WIII',
	message: 'A1234/26 NOTAMN A) WIII E) ILS RWY 25L SERVICEABLE.',
	validFrom: '2026-09-20T00:00:00.000Z',
	validTo: '2026-09-30T00:00:00.000Z',
	riskLevel: null,
	fetchedAt: '2026-09-21T18:00:00.000Z'
};

function baseInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dof: DOF,
		staZ: STA,
		diversionMinutes: 60,
		originIcao: 'WARR',
		destinationIcao: 'WIII',
		alternateIcao: 'WADD',
		destinationTaf: DEST_TAF,
		alternateTaf: ALT_TAF,
		destinationMinima: MINIMA,
		alternateLandingMinima: MINIMA,
		alternatePlanningMinima: MINIMA,
		selectedNotams: [NOTAM],
		...overrides
	};
}

function codes(findings: DispatchFinding[]): string[] {
	return findings.map(finding => finding.code);
}

function findingFor(findings: DispatchFinding[], code: string): DispatchFinding | undefined {
	return findings.find(finding => finding.code === code);
}

function allReferences(findings: DispatchFinding[]): string {
	return findings.flatMap(finding => [...finding.references]).join(' | ');
}

describe('ETA windows', () => {
	it('centres the destination window on STA and the alternate window on STA plus diversion', () => {
		const windows = computeEtaWindows(STA, 60);
		expect(windows.destination.from.toISOString()).toBe('2026-09-21T19:00:00.000Z');
		expect(windows.destination.to.toISOString()).toBe('2026-09-21T21:00:00.000Z');
		expect(windows.primaryAlternate.from.toISOString()).toBe('2026-09-21T20:00:00.000Z');
		expect(windows.primaryAlternate.to.toISOString()).toBe('2026-09-21T22:00:00.000Z');
		expect(windows.alternateUsesDefaultDiversionTime).toBe(false);
	});

	it('defaults a missing diversion time to 2 hours and marks the window as an assumption', () => {
		// PRD section 7 and acceptance criterion 3: the alternate window becomes
		// destination STA +1 hour to +3 hours, and the default is stated.
		const windows = computeEtaWindows(STA, null);
		expect(windows.primaryAlternate.from.toISOString()).toBe('2026-09-21T21:00:00.000Z');
		expect(windows.primaryAlternate.to.toISOString()).toBe('2026-09-21T23:00:00.000Z');
		expect(windows.alternateUsesDefaultDiversionTime).toBe(true);
	});

	it('is exactly the destination STA +1 to +3 hours when the diversion time is absent', () => {
		const windows = computeEtaWindows(STA, null);
		expect(windows.primaryAlternate.from.getTime()).toBe(STA.getTime() + 60 * 60_000);
		expect(windows.primaryAlternate.to.getTime()).toBe(STA.getTime() + 180 * 60_000);
	});

	it('shifts the alternate window by a non-default diversion time', () => {
		const windows = computeEtaWindows(STA, 120);
		expect(windows.primaryAlternate.from.toISOString()).toBe('2026-09-21T21:00:00.000Z');
		expect(windows.primaryAlternate.to.toISOString()).toBe('2026-09-21T23:00:00.000Z');
		expect(windows.alternateUsesDefaultDiversionTime).toBe(false);
	});
});

describe('destination change-indicator classification', () => {
	it('treats thunderstorm and showers as transient and therefore not applicable', () => {
		expect(classifyConditionalNature({ ...emptyConditions(), weather: ['TSRA'] }).nature).toBe('transient-showery');
		expect(classifyConditionalNature({ ...emptyConditions(), weather: ['SHRA'] }).nature).toBe('transient-showery');
	});

	it('treats haze, mist, fog, dust or sandstorm and continuous precipitation as persistent', () => {
		for (const code of ['HZ', 'BR', 'FG', 'DS', 'SS', 'RA', 'DZ', 'SN']) {
			expect(classifyConditionalNature({ ...emptyConditions(), weather: [code] }).nature).toBe('persistent-continuous');
		}
	});

	it('reads a group that carries a transient descriptor as transient, even alongside persistent codes', () => {
		// The table's transient column is what a thunderstorm or a shower falls under,
		// so `SHRA` decides the group even when the same group also carries `BR`.
		// `TSRA` is the case that matters most: its `RA` is continuous precipitation on
		// its own, so reading it as persistent would defeat the row the table states.
		expect(classifyConditionalNature({ ...emptyConditions(), weather: ['SHRA', 'BR'] }).nature).toBe('transient-showery');
		expect(classifyConditionalNature({ ...emptyConditions(), weather: ['TSRA'] }).nature).toBe('transient-showery');
	});

	it('reports a group with no classified phenomenon as indeterminate rather than harmless', () => {
		const result = classifyConditionalNature({ ...emptyConditions(), weather: [] });
		expect(result.nature).toBe('indeterminate');
		expect(result.phenomena).toEqual([]);
	});
});

describe('holding fuel and standard padding', () => {
	const neutral = {
		alternateConditionalBelowPlanningMinima: false,
		alternateAboveLandingMinima: true,
		destinationAtOrAboveAlternatePlanningMinima: true,
		paddingDestinationBelowAlternatePlanningMinima: false,
		paddingCriterionOneEvidence: '',
		paddingDestinationLowVisibilityThunderstorm: false,
		paddingCriterionTwoEvidence: ''
	};

	it('requires nothing when no cited rule is triggered', () => {
		const fuel = evaluateHoldingFuel(neutral);
		expect(fuel.mandatoryHoldingMinutes).toBe(0);
		expect(fuel.basis).toBe('no-padding-triggered');
		expect(fuel.advisoryPaddingMinutes).toBe(0);
	});

	it('requires 30 minutes when the destination alternate TEMPO concession applies', () => {
		// OM Part A 8.1.6 b.iii: below planning minima on TEMPO, above landing
		// minima, destination above destination alternate planning minima, and the
		// additional 30 minutes carried.
		const fuel = evaluateHoldingFuel({ ...neutral, alternateConditionalBelowPlanningMinima: true });
		expect(fuel.mandatoryHoldingMinutes).toBe(30);
		expect(fuel.basis).toBe('alternate-tempo-holding');
		expect(fuel.references.join(' ')).toContain('OM Part A 8.1.6 b.iii');
	});

	it('withholds the concession when the alternate is not shown above its landing minima', () => {
		const fuel = evaluateHoldingFuel({
			...neutral,
			alternateConditionalBelowPlanningMinima: true,
			alternateAboveLandingMinima: false
		});
		expect(fuel.mandatoryHoldingMinutes).toBe(0);
	});

	it('withholds the concession when the destination is not at or above destination alternate planning minima', () => {
		const fuel = evaluateHoldingFuel({
			...neutral,
			alternateConditionalBelowPlanningMinima: true,
			destinationAtOrAboveAlternatePlanningMinima: false
		});
		expect(fuel.mandatoryHoldingMinutes).toBe(0);
	});

	it('pads 10 minutes for each matched FUEL PADDING criterion, with its citation', () => {
		const one = evaluateHoldingFuel({ ...neutral, paddingDestinationBelowAlternatePlanningMinima: true });
		expect(one.advisoryPaddingMinutes).toBe(10);
		expect(one.paddingCriteria).toHaveLength(1);
		expect(one.paddingCriteria[0]!.references.join(' ')).toContain('FDM 5.11');
		expect(one.paddingCriteria[0]!.references.join(' ')).toContain('5.11-16');

		const both = evaluateHoldingFuel({
			...neutral,
			paddingDestinationBelowAlternatePlanningMinima: true,
			paddingDestinationLowVisibilityThunderstorm: true
		});
		expect(both.advisoryPaddingMinutes).toBe(20);
		expect(both.paddingCriteria).toHaveLength(2);
		expect(both.basis).toBe('padding-standard');
	});

	it('never states a TEMPO-without-alternate holding figure', () => {
		// The source review found no company rule requiring 60 minutes of holding for
		// a destination TEMPO group with no alternate, so the engine has no such
		// input and cannot produce such a basis (PRD section 11, acceptance 12).
		const fuel = evaluateHoldingFuel({ ...neutral, alternateConditionalBelowPlanningMinima: false });
		expect(fuel.mandatoryHoldingMinutes).toBe(0);
		expect(['no-padding-triggered', 'padding-standard']).toContain(fuel.basis);
		expect(JSON.stringify(fuel)).not.toContain('60 minutes');
		expect(JSON.stringify(fuel)).not.toContain('tempo-without-alternate');
	});
});

describe('planning minima for a destination alternate', () => {
	it('uses the CAT 1 RVR for a CAT II or III approach and states no ceiling', () => {
		const derived = planningMinimaForAlternate(MINIMA, 'CAT II/III');
		expect(derived.visibilityM).toBe(1500);
		expect(derived.ceilingFt).toBeNull();
	});

	it('adds 200 ft and 1000 m for a non-precision approach', () => {
		const derived = planningMinimaForAlternate(MINIMA, 'Non-precision');
		expect(derived.ceilingFt).toBe(700);
		expect(derived.visibilityM).toBe(2500);
	});

	it('takes the higher of a chart-published alternate minima and the company minima', () => {
		const chart: ApproachMinima = { approach: 'Published alternate', ceilingFt: 600, visibilityM: 3000, references: ['chart'] };
		const company = planningMinimaForAlternate(MINIMA, 'Non-precision');
		const higher = higherMinima(chart, company);
		expect(higher.ceilingFt).toBe(700);
		expect(higher.visibilityM).toBe(3000);
	});
});

describe('minima comparison', () => {
	it('flags visibility and ceiling shortfalls', () => {
		expect(compareToMinima(800, 200, MINIMA)).toEqual({ visibilityBelow: true, ceilingBelow: true });
		expect(compareToMinima(9999, 1000, MINIMA)).toEqual({ visibilityBelow: false, ceilingBelow: false });
	});

	it('does not treat a missing value as a pass', () => {
		expect(compareToMinima(null, null, MINIMA)).toEqual({ visibilityBelow: false, ceilingBelow: false });
		// No shortfall is reported, but the caller must not read that as compliance;
		// assessDispatch records MINIMA_NOT_AVAILABLE separately.
	});
});

describe('closure detection in selected NOTAM', () => {
	it('detects closure wording', () => {
		expect(detectClosureRemarks('RWY 25L CLOSED FOR MAINTENANCE')).toContain('CLOSED');
		expect(detectClosureRemarks('RWY CLOSED')).toContain('RWY CLOSED');
		expect(detectClosureRemarks('AERODROME CLSD')).toContain('AERODROME CLSD');
	});

	it('does not report ordinary NOTAM text or an equipment downgrade', () => {
		expect(detectClosureRemarks(NOTAM.message)).toEqual([]);
		expect(detectClosureRemarks('ILS 25L U/S')).toEqual([]);
	});
});

describe('outcome derivation', () => {
	const critical = (options: { blocksRelease?: boolean; missingData?: boolean } = {}): DispatchFinding => ({
		severity: 'CRITICAL',
		code: 'TAF_WINDOW_NOT_CURVED' as DispatchFinding['code'],
		message: 'x',
		evidence: 'y',
		references: [],
		blocksRelease: options.blocksRelease === true,
		missingData: options.missingData === true,
		source: 'system'
	});

	it('returns NO-GO only for a condition that blocks release', () => {
		expect(deriveOutcome([critical({ blocksRelease: true })])).toBe('NO-GO');
		expect(deriveOutcome([critical({})])).toBe('REVIEW REQUIRED');
	});

	it('prefers REVIEW REQUIRED over NOTAM REVIEW PENDING, because a gap is the stronger statement', () => {
		expect(
			deriveOutcome([
				critical({ missingData: true }),
				{ severity: 'CAUTION', code: 'NOTAM_REVIEW_PENDING', message: 'x', evidence: 'y', references: [], blocksRelease: false, source: 'system' }
			])
		).toBe('REVIEW REQUIRED');
	});

	it('returns NOTAM REVIEW PENDING when that is the only outstanding item', () => {
		expect(
			deriveOutcome([
				{ severity: 'CAUTION', code: 'NOTAM_REVIEW_PENDING', message: 'x', evidence: 'y', references: [], blocksRelease: false, source: 'system' }
			])
		).toBe('NOTAM REVIEW PENDING');
	});

	it('returns MARGINAL only when a finding is marked as a threshold the manual states', () => {
		expect(
			deriveOutcome([
				{ severity: 'CAUTION', code: 'DEST_CONDITIONAL_DETERIORATION', message: 'x', evidence: 'y', references: [], blocksRelease: false, marginalByRule: true, source: 'system' }
			])
		).toBe('MARGINAL');
		expect(
			deriveOutcome([
				{ severity: 'CAUTION', code: 'DEST_CONDITIONAL_DETERIORATION', message: 'x', evidence: 'y', references: [], blocksRelease: false, source: 'system' }
			])
		).toBe('REVIEW REQUIRED');
	});

	it('returns GO only for an empty finding list', () => {
		expect(deriveOutcome([])).toBe('GO');
	});
});

describe('end to end assessment', () => {
	it('reaches GO when every check is verified', () => {
		const result = assessDispatch(baseInput());
		expect(result.findings).toEqual([]);
		expect(result.outcome).toBe('GO');
		expect(result.notamReviewed).toBe(true);
	});

	it('reports NOTAM REVIEW PENDING when no NOTAM was selected, and still assesses', () => {
		const result = assessDispatch(baseInput({ selectedNotams: [] }));
		expect(codes(result.findings)).toContain('NOTAM_REVIEW_PENDING');
		expect(result.notamReviewed).toBe(false);
		expect(result.outcome).toBe('NOTAM REVIEW PENDING');
		// The assessment is still produced: PRD acceptance criterion 9.
		expect(result.windows).not.toBeNull();
	});

	it('never presents an unreviewed NOTAM as a clean check', () => {
		const result = assessDispatch(baseInput({ selectedNotams: [] }));
		const pending = findingFor(result.findings, 'NOTAM_REVIEW_PENDING');
		expect(pending?.message.toLowerCase()).not.toContain('notam is clear');
		expect(pending?.evidence).toContain('not a statement that NOTAM is clear');
	});

	it('returns NO-GO when prevailing destination weather is below landing minima', () => {
		const result = assessDispatch(baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 0800 FG OVC002' }));
		const blocking = findingFor(result.findings, 'DEST_BELOW_LANDING_MINIMA');
		expect(blocking?.severity).toBe('CRITICAL');
		expect(blocking?.blocksRelease).toBe(true);
		expect(result.outcome).toBe('NO-GO');
	});

	it('returns NO-GO when a selected NOTAM indicates a closure', () => {
		const result = assessDispatch(
			baseInput({ selectedNotams: [{ ...NOTAM, message: 'A1/26 NOTAMN A) WIII E) RWY 25L CLOSED DUE WIP' }] })
		);
		expect(findingFor(result.findings, 'NOTAM_RUNWAY_CLOSURE')?.blocksRelease).toBe(true);
		expect(result.outcome).toBe('NO-GO');
	});

	it('does not turn an unsuitable alternate into NO-GO', () => {
		// PRD acceptance criterion 10: a failed alternate states why and asks for
		// another selection; it is not a release-blocking outcome by itself.
		const result = assessDispatch(
			baseInput({ alternateTaf: 'TAF WADD 211700Z 2118/2224 09008KT 0800 FG OVC002' })
		);
		expect(codes(result.findings)).toContain('ALT_BELOW_PLANNING_MINIMA');
		expect(result.outcome).not.toBe('NO-GO');
	});

	it('ignores a transient destination deterioration for planning minima and says so', () => {
		const result = assessDispatch(
			baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB' })
		);
		expect(codes(result.findings)).toContain('DEST_CONDITIONAL_IMPROVEMENT_IGNORED');
		expect(result.destinationConditional[0]!.nature).toBe('transient-showery');
		expect(result.destinationConditional[0]!.applies).toBe(false);
	});

	it('applies a persistent destination deterioration to planning minima', () => {
		const result = assessDispatch(
			baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 1000 BR OVC003' })
		);
		expect(codes(result.findings)).toContain('DEST_CONDITIONAL_DETERIORATION');
		expect(result.destinationConditional[0]!.nature).toBe('persistent-continuous');
		expect(result.destinationConditional[0]!.applies).toBe(true);
		expect(result.outcome).toBe('MARGINAL');
	});

	it('produces no fuel figure for a destination TEMPO group when no alternate is selected', () => {
		const result = assessDispatch(
			baseInput({
				destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB',
				alternateIcao: null,
				alternateTaf: null,
				alternateLandingMinima: null,
				alternatePlanningMinima: null
			})
		);
		expect(codes(result.findings)).toContain('ALT_NOT_NOMINATED');
		expect(result.fuel.mandatoryHoldingMinutes).toBe(0);
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('requires the 30 minutes when a TEMPO group takes the alternate below planning minima', () => {
		const result = assessDispatch(
			baseInput({
				// Alternate landing minima 500/1500; planning minima 700/2500. TEMPO
				// reaches 1500 m / 600 ft: below planning, above landing. The group is
				// BR, which the table applies to planning minima.
				alternateLandingMinima: { ...MINIMA, approach: 'ILS RWY 05' },
				alternatePlanningMinima: { ...MINIMA, approach: 'Alternate planning', ceilingFt: 700, visibilityM: 2500 },
				alternateTaf: 'TAF WADD 211700Z 2118/2224 09008KT 9999 SCT020 TEMPO 2120/2123 1500 BR BKN006'
			})
		);
		expect(codes(result.findings)).toContain('ALT_CONDITIONAL_BELOW_PLANNING_MINIMA');
		expect(result.fuel.mandatoryHoldingMinutes).toBe(30);
		expect(result.fuel.basis).toContain('alternate-tempo-holding');
		expect(result.fuel.references.join(' ')).toContain('OM Part A 8.1.6 b.iii');
	});

	it('withholds the concession and asks for review when the alternate landing minima is missing', () => {
		const result = assessDispatch(
			baseInput({
				alternateLandingMinima: null,
				alternatePlanningMinima: { ...MINIMA, approach: 'Alternate planning', ceilingFt: 700, visibilityM: 2500 },
				alternateTaf: 'TAF WADD 211700Z 2118/2224 09008KT 9999 SCT020 TEMPO 2120/2123 1500 BR BKN006'
			})
		);
		expect(codes(result.findings)).toContain('ALT_TEMPO_CONCESSION_UNAVAILABLE');
		expect(result.fuel.mandatoryHoldingMinutes).toBe(0);
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('never applies the destination change-indicator classification to the alternate', () => {
		// A transient alternate TEMPO group must still be compared against the
		// alternate planning minima; only the destination column of Table 8.1-20 is
		// applied, and only to the destination (PRD section 8, acceptance 5).
		const result = assessDispatch(
			baseInput({
				alternateLandingMinima: { ...MINIMA, approach: 'ILS RWY 05' },
				alternatePlanningMinima: { ...MINIMA, approach: 'Alternate planning', ceilingFt: 700, visibilityM: 2500 },
				alternateTaf: 'TAF WADD 211700Z 2118/2224 09008KT 9999 SCT020 TEMPO 2120/2123 1500 TSRA BKN008'
			})
		);
		expect(codes(result.findings)).toContain('ALT_CONDITIONAL_BELOW_PLANNING_MINIMA');
		expect(result.destinationConditional).toEqual([]);
	});

	it('pads 10 minutes when the destination is at or below destination alternate planning minima', () => {
		const result = assessDispatch(
			baseInput({
				destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 2000 BR BKN008',
				alternatePlanningMinima: { ...MINIMA, approach: 'Alternate planning', ceilingFt: 900, visibilityM: 3000 }
			})
		);
		expect(result.fuel.advisoryPaddingMinutes).toBe(10);
		expect(result.fuel.paddingCriteria[0]!.code).toBe('destination-below-alternate-planning-minima');
		expect(codes(result.findings)).toContain('FUEL_PADDING_STANDARD');
	});

	it('pads 10 minutes when destination visibility is at or below 3000 m with TSRA', () => {
		const result = assessDispatch(
			baseInput({
				destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 2500 TSRA BKN010CB',
				alternatePlanningMinima: { ...MINIMA, approach: 'Alternate planning', ceilingFt: 400, visibilityM: 1000 }
			})
		);
		expect(result.fuel.paddingCriteria.map(criterion => criterion.code)).toContain('destination-low-visibility-thunderstorm');
		expect(result.fuel.advisoryPaddingMinutes).toBeGreaterThanOrEqual(10);
	});

	it('requires REVIEW REQUIRED, not a pass, when no approved minima was selected', () => {
		const result = assessDispatch(baseInput({ destinationMinima: null, alternateLandingMinima: null, alternatePlanningMinima: null }));
		expect(codes(result.findings)).toContain('MINIMA_NOT_AVAILABLE');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('does not treat a labelled approach with no minima values as compliance', () => {
		// Comparing against an all-null minima finds no shortfall for the wrong reason,
		// which reads as a pass while nothing was actually checked.
		const result = assessDispatch(
			baseInput({ destinationMinima: { approach: 'ILS RWY 21', ceilingFt: null, visibilityM: null, references: [] } })
		);
		expect(codes(result.findings)).toContain('MINIMA_INCOMPLETE');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('does not treat a labelled alternate planning minima with no values as compliance', () => {
		const result = assessDispatch(
			baseInput({ alternatePlanningMinima: { approach: 'Alternate planning', ceilingFt: null, visibilityM: null, references: [] } })
		);
		expect(codes(result.findings)).toContain('MINIMA_NOT_AVAILABLE');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('reports REVIEW REQUIRED when the arrival window is missing', () => {
		const result = assessDispatch(baseInput({ staZ: null }));
		expect(codes(result.findings)).toContain('INPUT_INCOMPLETE');
		expect(result.windows).toBeNull();
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('reports REVIEW REQUIRED when the destination TAF cannot be read', () => {
		const result = assessDispatch(baseInput({ destinationTaf: null }));
		expect(codes(result.findings)).toContain('TAF_UNPARSEABLE');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('reports REVIEW REQUIRED when the destination TAF does not cover the window', () => {
		const result = assessDispatch(baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2120 27008KT 9999 SCT020' }));
		expect(codes(result.findings)).toContain('TAF_WINDOW_NOT_COVERED');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('reports REVIEW REQUIRED when a superseded destination TAF is in use', () => {
		const result = assessDispatch(baseInput({ destinationTafCurrency: 'stale' }));
		expect(codes(result.findings)).toContain('TAF_NOT_CURRENT');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('flags an undetermined destination TAF currency', () => {
		const result = assessDispatch(baseInput({ destinationTafCurrency: 'unknown' }));
		expect(codes(result.findings)).toContain('TAF_STATUS_UNKNOWN');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('flags a stale weather monitoring feed', () => {
		const result = assessDispatch(baseInput({ weatherFreshness: 'stale' }));
		expect(codes(result.findings)).toContain('WX_NOT_FRESH');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('treats an omitted currency or freshness signal as not checked, not as unknown', () => {
		const result = assessDispatch(baseInput());
		expect(codes(result.findings)).not.toContain('TAF_STATUS_UNKNOWN');
		expect(codes(result.findings)).not.toContain('WX_FRESHNESS_UNKNOWN');
	});

	it('reports REVIEW REQUIRED when the schedule needed a date confirmed', () => {
		const result = assessDispatch(baseInput({ scheduleNeedsConfirmation: true }));
		expect(codes(result.findings)).toContain('SCHEDULE_NEEDS_CONFIRMATION');
		expect(result.outcome).toBe('REVIEW REQUIRED');
	});

	it('forces review when a weather advisory touches the route', () => {
		const result = assessDispatch(
			baseInput({
				routeImpactWarnings: [{ source: 'ISIGMET', kind: 'VA', title: 'VA SIGMET SEMERU (WAAF)', severity: 'Warning', nm: 29 }]
			})
		);
		const finding = findingFor(result.findings, 'WX_ROUTE_IMPACT');
		expect(finding?.severity).toBe('CRITICAL');
		expect(finding?.evidence).toContain('29 NM from route');
		// Critical so it cannot be a GO, but not release-blocking: whether a hazard at
		// that distance stops a release is an operator judgement.
		expect(finding?.blocksRelease).toBe(false);
		expect(result.outcome).toBe('MARGINAL');
	});

	it('is deterministic for the same input', () => {
		const input = baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB' });
		expect(assessDispatch(input)).toEqual(assessDispatch(input));
	});

	it('orders critical findings before context', () => {
		const result = assessDispatch(baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 0800 FG OVC002' }));
		const severities = result.findings.map(finding => finding.severity);
		const firstInfo = severities.indexOf('INFO');
		const lastCritical = severities.lastIndexOf('CRITICAL');
		if (firstInfo !== -1 && lastCritical !== -1) expect(lastCritical).toBeLessThan(firstInfo);
	});
});

describe('reference sources', () => {
	it('never cites CASR on any finding', () => {
		// PRD acceptance criterion 15: CASR is not part of the agreed rule sources.
		const scenarios: DispatchInput[] = [
			baseInput(),
			baseInput({ selectedNotams: [] }),
			baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 0800 FG OVC002' }),
			baseInput({ destinationMinima: null, alternateLandingMinima: null, alternatePlanningMinima: null }),
			baseInput({ alternateTaf: 'TAF WADD 211700Z 2118/2224 09008KT 0800 FG OVC002' }),
			baseInput({ routeImpactWarnings: [{ source: 'SIGMET', kind: 'VA', title: 'VA', severity: 'Warning', nm: 12 }] })
		];
		for (const scenario of scenarios) {
			const references = allReferences(assessDispatch(scenario).findings);
			expect(references).not.toMatch(/\bCASR\b/);
			expect(references).not.toMatch(/121\./);
		}
	});

	it('cites the agreed clause for every rule it applies', () => {
		const result = assessDispatch(
			baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 1000 BR OVC003' })
		);
		const references = allReferences(result.findings);
		expect(references).toContain('OM Part A');
		for (const finding of result.findings) {
			expect(finding.references.length).toBeGreaterThan(0);
		}
	});
});

/** Neutral conditions for the classification helper. */
function emptyConditions(): Parameters<typeof classifyConditionalNature>[0] {
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

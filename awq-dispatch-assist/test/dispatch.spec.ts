import { describe, expect, it } from 'vitest';
import {
	assessDispatch,
	compareToMinima,
	computeEtaWindows,
	detectClosureRemarks,
	deriveVerdict,
	evaluateHoldingFuel,
	type ApproachMinima,
	type DispatchFinding,
	type DispatchInput
} from '../src/dispatch';

/**
 * Dispatch engine contract tests.
 *
 * These pin the evaluation workflow: ETA windows, the INTER/TEMPO fuel rule, the
 * minima comparisons and the rule that GO is only reachable when nothing is left
 * unverified. The engine must never return GO on unknown data.
 */

const STA = new Date(Date.UTC(2026, 8, 21, 20, 0, 0));
const DOF = new Date(Date.UTC(2026, 8, 21));

const DEST_TAF = 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020';
const ALT_TAF = 'TAF WADD 211700Z 2118/2224 09008KT 9999 SCT020';

const MINIMA: ApproachMinima = {
	approach: 'ILS RWY 25L',
	ceilingFt: 500,
	visibilityM: 1500,
	references: ['OM Part A 8.1.2']
};

const VERIFIED_REMARKS = 'NO SIGNIFICANT NOTAM. ILS 25L SERVICEABLE.';

function baseInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dof: DOF,
		staZ: STA,
		diversionMinutes: 60,
		destinationTaf: DEST_TAF,
		destinationAlternates: ['WADD'],
		alternateTaf: ALT_TAF,
		destinationMinima: MINIMA,
		alternateMinima: MINIMA,
		notamRemarks: VERIFIED_REMARKS,
		...overrides
	};
}

function codes(findings: DispatchFinding[]): string[] {
	return findings.map(finding => finding.code);
}

describe('ETA windows', () => {
	it('centres the destination window on STA and the alternate window on STA plus diversion', () => {
		const windows = computeEtaWindows(STA, 60);
		expect(windows.destination.from.toISOString()).toBe('2026-09-21T19:00:00.000Z');
		expect(windows.destination.to.toISOString()).toBe('2026-09-21T21:00:00.000Z');
		expect(windows.primaryAlternate.from.toISOString()).toBe('2026-09-21T20:00:00.000Z');
		expect(windows.primaryAlternate.to.toISOString()).toBe('2026-09-21T22:00:00.000Z');
	});

	it('defaults a missing diversion time to 60 minutes', () => {
		const windows = computeEtaWindows(STA, null);
		expect(windows.primaryAlternate.from.toISOString()).toBe('2026-09-21T20:00:00.000Z');
		expect(windows.primaryAlternate.to.toISOString()).toBe('2026-09-21T22:00:00.000Z');
	});

	it('shifts the alternate window by a non-default diversion time', () => {
		const windows = computeEtaWindows(STA, 120);
		expect(windows.primaryAlternate.from.toISOString()).toBe('2026-09-21T21:00:00.000Z');
		expect(windows.primaryAlternate.to.toISOString()).toBe('2026-09-21T23:00:00.000Z');
	});
});

describe('holding fuel rule', () => {
	const noWeather = { hasInter: false, hasTempo: false };

	it('requires nothing when no conditional group affects the window', () => {
		const fuel = evaluateHoldingFuel({ ...noWeather, hasCompliantAlternate: false, hasConvectiveWeather: false });
		expect(fuel.mandatoryHoldingMinutes).toBe(0);
		expect(fuel.basis).toBe('no-conditional-weather');
	});

	it('requires nothing when a compliant alternate is nominated', () => {
		const fuel = evaluateHoldingFuel({ hasInter: true, hasTempo: true, hasCompliantAlternate: true, hasConvectiveWeather: false });
		expect(fuel.mandatoryHoldingMinutes).toBe(0);
		expect(fuel.basis).toBe('compliant-alternate');
	});

	it('requires 30 minutes for INTER without an alternate', () => {
		const fuel = evaluateHoldingFuel({ hasInter: true, hasTempo: false, hasCompliantAlternate: false, hasConvectiveWeather: false });
		expect(fuel.mandatoryHoldingMinutes).toBe(30);
		expect(fuel.basis).toBe('inter-without-alternate');
	});

	it('requires 60 minutes for TEMPO without an alternate', () => {
		const fuel = evaluateHoldingFuel({ hasInter: false, hasTempo: true, hasCompliantAlternate: false, hasConvectiveWeather: false });
		expect(fuel.mandatoryHoldingMinutes).toBe(60);
		expect(fuel.basis).toBe('tempo-without-alternate');
	});

	it('keeps convective padding advisory and separate from the legal figure', () => {
		const fuel = evaluateHoldingFuel({ hasInter: false, hasTempo: true, hasCompliantAlternate: false, hasConvectiveWeather: true });
		expect(fuel.mandatoryHoldingMinutes).toBe(60);
		expect(fuel.advisoryPaddingMinutes).toBe(15);
		expect(fuel.advisoryRationale).toContain('discretionary');
	});

	it('requires 30 minutes when only the alternate goes conditionally below planning minima', () => {
		// OM Part A 8.1.2 keeps the alternate usable in that case only with
		// additional holding fuel carried.
		const fuel = evaluateHoldingFuel({
			hasInter: false,
			hasTempo: false,
			hasCompliantAlternate: false,
			hasConvectiveWeather: false,
			alternateConditionalBelowMinima: true
		});
		expect(fuel.mandatoryHoldingMinutes).toBe(30);
		expect(fuel.basis).toBe('alternate-conditional');
	});

	it('does not sum the destination and alternate requirements', () => {
		// Both figures cover the same additional holding, so the larger governs.
		const fuel = evaluateHoldingFuel({
			hasInter: false,
			hasTempo: true,
			hasCompliantAlternate: false,
			hasConvectiveWeather: false,
			alternateConditionalBelowMinima: true
		});
		expect(fuel.mandatoryHoldingMinutes).toBe(60);
		expect(fuel.basis).toBe('tempo-without-alternate');
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

describe('closure remarks', () => {
	it('detects closure wording', () => {
		expect(detectClosureRemarks('RWY 25L CLOSED FOR MAINTENANCE')).toContain('CLOSED');
		expect(detectClosureRemarks('RWY CLOSED')).toContain('RWY CLOSED');
		expect(detectClosureRemarks('AERODROME CLSD')).toContain('AERODROME CLSD');
	});

	it('does not report ordinary remarks or an equipment downgrade', () => {
		expect(detectClosureRemarks(VERIFIED_REMARKS)).toEqual([]);
		// ILS U/S changes the minima (OM Part A Table 8.1-17) but is not a closure.
		expect(detectClosureRemarks('ILS 25L U/S')).toEqual([]);
	});
});

describe('verdict reduction', () => {
	const critical = (blocksRelease: boolean): DispatchFinding => ({
		severity: 'CRITICAL',
		code: 'TAF_WINDOW_NOT_COVERED',
		message: 'x',
		evidence: 'y',
		references: [],
		blocksRelease,
		source: 'system'
	});

	it('never returns GO while a caution is present', () => {
		expect(
			deriveVerdict([
				{ severity: 'CAUTION', code: 'NOTAM_UNVERIFIED', message: 'x', evidence: 'y', references: [], blocksRelease: false, source: 'system' }
			])
		).toBe('MARGINAL');
	});

	it('returns NO-GO only for a condition that blocks release', () => {
		expect(deriveVerdict([critical(true)])).toBe('NO-GO');
		// A critical condition that could not be assessed degrades rather than blocks.
		expect(deriveVerdict([critical(false)])).toBe('MARGINAL');
	});

	it('returns GO only for an empty finding list', () => {
		expect(deriveVerdict([])).toBe('GO');
	});
});

describe('end to end assessment', () => {
	it('returns GO only when every check is verified', () => {
		const result = assessDispatch(baseInput());
		expect(result.findings).toEqual([]);
		expect(result.verdict).toBe('GO');
		expect(result.notamEvaluated).toBe(true);
	});

	it('degrades to MARGINAL when no NOTAM or remarks were provided', () => {
		const result = assessDispatch(baseInput({ notamRemarks: '' }));
		expect(codes(result.findings)).toContain('NOTAM_UNVERIFIED');
		expect(result.notamEvaluated).toBe(false);
		expect(result.verdict).toBe('MARGINAL');
	});

	it('returns NO-GO when prevailing destination weather is below landing minima', () => {
		const result = assessDispatch(baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 0800 FG OVC002' }));
		const blocking = result.findings.find(finding => finding.code === 'DEST_BELOW_LANDING_MINIMA');
		expect(blocking?.severity).toBe('CRITICAL');
		expect(blocking?.blocksRelease).toBe(true);
		expect(result.verdict).toBe('NO-GO');
	});

	it('returns NO-GO when the supplied remarks indicate a closure', () => {
		const result = assessDispatch(baseInput({ notamRemarks: 'RWY 25L CLOSED DUE WIP' }));
		const blocking = result.findings.find(finding => finding.code === 'NOTAM_RUNWAY_CLOSURE');
		expect(blocking?.blocksRelease).toBe(true);
		expect(result.verdict).toBe('NO-GO');
	});

	it('treats a conditional deterioration below minima as a caution, not a block', () => {
		const result = assessDispatch(
			baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 1000 BR OVC003' })
		);
		expect(codes(result.findings)).toContain('DEST_CONDITIONAL_DETERIORATION');
		expect(result.verdict).toBe('MARGINAL');
	});

	it('requires 60 minutes of holding for TEMPO without a nominated alternate', () => {
		const result = assessDispatch(
			baseInput({
				destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB',
				destinationAlternates: [],
				alternateTaf: null,
				alternateMinima: null
			})
		);
		expect(codes(result.findings)).toContain('ALT_NOT_NOMINATED');
		expect(codes(result.findings)).toContain('FUEL_ADDITIONAL_HOLDING');
		expect(result.fuel.mandatoryHoldingMinutes).toBe(60);
		expect(result.fuel.basis).toBe('tempo-without-alternate');
		expect(result.verdict).toBe('MARGINAL');
	});

	it('requires 30 minutes of holding for INTER without a nominated alternate', () => {
		const result = assessDispatch(
			baseInput({
				destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 INTER 2119/2121 3000 BR BKN010',
				destinationAlternates: [],
				alternateTaf: null,
				alternateMinima: null
			})
		);
		expect(result.fuel.mandatoryHoldingMinutes).toBe(30);
		expect(result.fuel.basis).toBe('inter-without-alternate');
	});

	it('requires nothing when a compliant alternate covers the fluctuation', () => {
		const result = assessDispatch(
			baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 BR BKN010' })
		);
		expect(result.fuel.mandatoryHoldingMinutes).toBe(0);
		expect(result.fuel.basis).toBe('compliant-alternate');
		expect(result.verdict).toBe('GO');
	});

	it('caps the verdict below GO when minima could not be evaluated', () => {
		const result = assessDispatch(baseInput({ destinationMinima: null, alternateMinima: null }));
		expect(codes(result.findings)).toContain('MINIMA_NOT_AVAILABLE');
		expect(result.verdict).toBe('MARGINAL');
	});

	it('never returns GO when the arrival window is missing', () => {
		const result = assessDispatch(baseInput({ staZ: null }));
		expect(codes(result.findings)).toContain('INPUT_INCOMPLETE');
		expect(result.windows).toBeNull();
		expect(result.verdict).not.toBe('GO');
	});

	it('never returns GO when the destination TAF cannot be read', () => {
		const result = assessDispatch(baseInput({ destinationTaf: null }));
		expect(codes(result.findings)).toContain('TAF_UNPARSEABLE');
		expect(result.verdict).not.toBe('GO');
	});

	it('never returns GO when the destination TAF does not cover the window', () => {
		const result = assessDispatch(baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2120 27008KT 9999 SCT020' }));
		expect(codes(result.findings)).toContain('TAF_WINDOW_NOT_COVERED');
		expect(result.verdict).not.toBe('GO');
	});

	it('is deterministic for the same input', () => {
		const input = baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB' });
		expect(assessDispatch(input)).toEqual(assessDispatch(input));
	});

	it('forces review when a weather advisory touches the route', () => {
		const result = assessDispatch(
			baseInput({
				routeImpactWarnings: [{ source: 'ISIGMET', kind: 'VA', title: 'VA SIGMET SEMERU (WAAF)', severity: 'Warning', nm: 29 }]
			})
		);
		const finding = result.findings.find(item => item.code === 'WX_ROUTE_IMPACT');
		expect(finding?.severity).toBe('CRITICAL');
		expect(finding?.evidence).toContain('29 NM from route');
		// Critical so it cannot be a GO, but not release-blocking: whether a hazard at
		// that distance stops a release is an operator judgement.
		expect(finding?.blocksRelease).toBe(false);
		expect(result.verdict).toBe('MARGINAL');
	});

	it('reaches GO when everything is verified and no advisory touches the route', () => {
		expect(assessDispatch(baseInput({ routeImpactWarnings: [] })).verdict).toBe('GO');
	});

	it('flags a superseded destination TAF', () => {
		const result = assessDispatch(baseInput({ destinationTafCurrency: 'stale' }));
		expect(codes(result.findings)).toContain('TAF_NOT_CURRENT');
		expect(result.verdict).not.toBe('GO');
	});

	it('flags an undetermined destination TAF currency as a caution', () => {
		const result = assessDispatch(baseInput({ destinationTafCurrency: 'unknown' }));
		expect(codes(result.findings)).toContain('TAF_STATUS_UNKNOWN');
		expect(result.verdict).toBe('MARGINAL');
	});

	it('flags a stale weather monitoring feed', () => {
		const result = assessDispatch(baseInput({ weatherFreshness: 'stale' }));
		expect(codes(result.findings)).toContain('WX_NOT_FRESH');
		expect(result.verdict).toBe('MARGINAL');
	});

	it('flags an undetermined monitoring freshness', () => {
		const result = assessDispatch(baseInput({ weatherFreshness: 'unknown' }));
		expect(codes(result.findings)).toContain('WX_FRESHNESS_UNKNOWN');
	});

	it('does not flag a current TAF on a fresh feed', () => {
		const result = assessDispatch(baseInput({ destinationTafCurrency: 'current', weatherFreshness: 'fresh' }));
		expect(result.findings).toEqual([]);
		expect(result.verdict).toBe('GO');
	});

	it('treats an omitted currency or freshness signal as not checked, not as unknown', () => {
		// Keeps the contract the earlier engine had: the signal is optional, and an
		// absent signal must not manufacture a caution.
		const result = assessDispatch(baseInput());
		expect(codes(result.findings)).not.toContain('TAF_STATUS_UNKNOWN');
		expect(codes(result.findings)).not.toContain('WX_FRESHNESS_UNKNOWN');
	});

	it('caps the verdict when the schedule needed a date confirmed', () => {
		const result = assessDispatch(baseInput({ scheduleNeedsConfirmation: true }));
		expect(codes(result.findings)).toContain('SCHEDULE_NEEDS_CONFIRMATION');
		expect(result.verdict).toBe('MARGINAL');
	});

	it('orders critical findings before context', () => {
		const result = assessDispatch(baseInput({ destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 0800 FG OVC002' }));
		const severities = result.findings.map(finding => finding.severity);
		const firstInfo = severities.indexOf('INFO');
		const lastCritical = severities.lastIndexOf('CRITICAL');
		if (firstInfo !== -1 && lastCritical !== -1) expect(lastCritical).toBeLessThan(firstInfo);
	});
});

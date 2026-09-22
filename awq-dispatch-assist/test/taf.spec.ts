import { describe, expect, it } from 'vitest';
import {
	CAVOK_VISIBILITY_M,
	assessTafWindow,
	decodeTaf,
	effectiveVisibilityM,
	lowestCeiling,
	parseWeatherToken,
	resolveTafTime,
	type TafForecast
} from '../src/taf';

/**
 * Decoder contract tests.
 *
 * These pin the behaviour the dispatch rules depend on: which change group is
 * active inside a window, and what the worst case inside that window is. The
 * payloads mirror real TAF shape, including `2224` style validity (day 22,
 * hour 24) which the decoder normalises to the following midnight.
 */

/** 2026-09-21T20:00Z — the reference instant for day-of-month resolution. */
const REFERENCE = new Date(Date.UTC(2026, 8, 21, 20, 0, 0));

/** Zulu instant helper, September 2026. */
function at(hour: number, minute = 0, day = 21): Date {
	return new Date(Date.UTC(2026, 8, day, hour, minute, 0));
}

function decoded(raw: string): TafForecast {
	const taf = decodeTaf(raw);
	if (!taf) throw new Error(`expected to decode: ${raw}`);
	return taf;
}

describe('decoding a base TAF', () => {
	it('reads the station, validity and prevailing conditions', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020');
		expect(taf.station).toBe('WIII');
		expect(taf.issuedAt).toEqual({ day: 21, hour: 17, minute: 0 });
		expect(taf.validFrom).toEqual({ day: 21, hour: 18, minute: 0 });
		// 2224 is day 22 at hour 24, which normalises to the following midnight.
		expect(taf.validTo).toEqual({ day: 23, hour: 0, minute: 0 });
		expect(taf.prevailing.wind).toEqual({ directionDeg: 270, speedKt: 8, gustKt: null, variable: false });
		expect(taf.prevailing.visibilityM).toBe(9999);
		expect(taf.prevailing.clouds).toHaveLength(1);
		// SCT is not a ceiling: only BKN, OVC and VV define one.
		expect(taf.prevailing.ceilingFt).toBeNull();
	});

	it('reads a gusting wind and a metric wind speed', () => {
		expect(decoded('TAF WIII 211700Z 2118/2224 25010G20KT 9999 SCT020').prevailing.wind).toEqual({
			directionDeg: 250,
			speedKt: 10,
			gustKt: 20,
			variable: false
		});
		expect(decoded('TAF WIII 211700Z 2118/2224 27008MPS 9999 SCT020').prevailing.wind?.speedKt).toBe(16);
		expect(decoded('TAF WIII 211700Z 2118/2224 VRB03KT 9999 SCT020').prevailing.wind?.variable).toBe(true);
	});

	it('uses the lowest BKN/OVC/VV layer as the ceiling', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 BKN035 OVC080');
		expect(taf.prevailing.ceilingFt).toBe(3500);
		expect(decoded('TAF WIII 211700Z 2118/2224 27008KT 2000 BR VV002').prevailing.ceilingFt).toBe(200);
	});

	it('treats CAVOK as a visibility and clears the need for a visibility group', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT CAVOK');
		expect(taf.prevailing.cavok).toBe(true);
		expect(taf.prevailing.visibilityM).toBeNull();
		expect(effectiveVisibilityM(taf.prevailing)).toBe(CAVOK_VISIBILITY_M);
	});

	it('reports unrecognised tokens instead of dropping them', () => {
		expect(decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 XXXXX').unparsed).toEqual(['XXXXX']);
	});

	it('does not report recognised but unused elements as unrecognised', () => {
		expect(decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 Q1013 NOSIG TX31/2206Z').unparsed).toEqual([]);
	});

	it('returns null when there is no validity period to anchor the windows to', () => {
		expect(decodeTaf('')).toBeNull();
		expect(decodeTaf('NOT A TAF')).toBeNull();
		expect(decodeTaf('TAF WIII 211700Z 27008KT 9999 SCT020')).toBeNull();
	});
});

describe('weather token parsing', () => {
	it('accepts descriptor and phenomenon combinations', () => {
		expect(parseWeatherToken('TSRA')).toEqual(['TS', 'RA']);
		expect(parseWeatherToken('-SHRA')).toEqual(['SH', 'RA']);
		expect(parseWeatherToken('FZFG')).toEqual(['FZ', 'FG']);
		expect(parseWeatherToken('VCTS')).toEqual(['TS']);
		// A thunderstorm without precipitation is reported as TS alone.
		expect(parseWeatherToken('TS')).toEqual(['TS']);
	});

	it('rejects a bare descriptor, a cloud layer and a visibility value', () => {
		expect(parseWeatherToken('SH')).toBeNull();
		expect(parseWeatherToken('FZ')).toBeNull();
		expect(parseWeatherToken('BKN010')).toBeNull();
		expect(parseWeatherToken('9999')).toBeNull();
	});
});

describe('change groups', () => {
	it('reads TEMPO and FM groups with their windows', () => {
		const taf = decoded(
			'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB FM220300 24010KT 9999 BKN015'
		);
		expect(taf.changes).toHaveLength(2);

		const tempo = taf.changes.find(group => group.type === 'TEMPO')!;
		expect(tempo.from).toEqual({ day: 21, hour: 19, minute: 0 });
		expect(tempo.to).toEqual({ day: 21, hour: 22, minute: 0 });
		expect(tempo.conditions.visibilityM).toBe(3000);
		expect(tempo.conditions.thunderstorm).toBe(true);
		expect(tempo.conditions.ceilingFt).toBe(1000);

		const fm = taf.changes.find(group => group.type === 'FM')!;
		expect(fm.from).toEqual({ day: 22, hour: 3, minute: 0 });
		expect(fm.conditions.wind?.directionDeg).toBe(240);
	});

	it('reads INTER and a probability-qualified TEMPO', () => {
		const taf = decoded(
			'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 INTER 2119/2121 4000 SHRA BKN012 PROB40 TEMPO 2120/2122 2000 TSRA BKN008CB'
		);
		expect(taf.changes.map(group => group.type)).toEqual(['INTER', 'TEMPO']);
		expect(taf.changes[0]!.probability).toBeNull();
		// PROB40 TEMPO keeps TEMPO semantics, which is what carries the fuel rule.
		expect(taf.changes[1]!.probability).toBe(40);
	});

	it('reads a BECMG group', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 BECMG 2120/2122 2000 BR BKN008');
		const becmg = taf.changes[0]!;
		expect(becmg.type).toBe('BECMG');
		expect(becmg.from).toEqual({ day: 21, hour: 20, minute: 0 });
		expect(becmg.conditions.visibilityM).toBe(2000);
	});
});

describe('resolving TAF times', () => {
	it('picks the month nearest the flight', () => {
		expect(resolveTafTime({ day: 21, hour: 18, minute: 0 }, REFERENCE).toISOString()).toBe('2026-09-21T18:00:00.000Z');
	});

	it('rolls a validity into the next month when the flight is at a month end', () => {
		const reference = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));
		expect(resolveTafTime({ day: 1, hour: 6, minute: 0 }, reference).toISOString()).toBe('2026-10-01T06:00:00.000Z');
		// A day that does not exist in the current month rolls forward.
		expect(resolveTafTime({ day: 31, hour: 18, minute: 0 }, reference).toISOString()).toBe('2026-10-01T18:00:00.000Z');
	});
});

describe('reading a TAF against the destination window', () => {
	// Destination window for STA 2026-09-21T20:00Z.
	const windowFrom = at(19);
	const windowTo = at(21);

	it('reports coverage and the prevailing conditions', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020');
		const assessment = assessTafWindow(taf, windowFrom, windowTo, REFERENCE);
		expect(assessment.covered).toBe(true);
		expect(assessment.worstVisibilityM).toBe(9999);
		expect(assessment.hasTempo).toBe(false);
		expect(assessment.hasInter).toBe(false);
	});

	it('fails coverage when the validity ends before the window does', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2120 27008KT 9999 SCT020');
		expect(assessTafWindow(taf, windowFrom, windowTo, REFERENCE).covered).toBe(false);
	});

	it('collects a TEMPO group that intersects the window as a conditional deterioration', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 1500 FG OVC003');
		const assessment = assessTafWindow(taf, windowFrom, windowTo, REFERENCE);
		expect(assessment.hasTempo).toBe(true);
		expect(assessment.conditional).toHaveLength(1);
		// The worst case is what a minima comparison must use.
		expect(assessment.worstVisibilityM).toBe(1500);
		expect(assessment.lowestCeilingFt).toBe(300);
		expect(assessment.fog).toBe(true);
	});

	it('ignores a TEMPO group that falls outside the window', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2122/2202 1500 FG OVC003');
		const assessment = assessTafWindow(taf, windowFrom, windowTo, REFERENCE);
		expect(assessment.hasTempo).toBe(false);
		expect(assessment.worstVisibilityM).toBe(9999);
	});

	it('folds a completed BECMG into the prevailing conditions', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 BECMG 2115/2117 4000 BR BKN010');
		const assessment = assessTafWindow(taf, windowFrom, windowTo, REFERENCE);
		expect(assessment.transitions).toHaveLength(0);
		expect(assessment.prevailing.visibilityM).toBe(4000);
		expect(assessment.prevailing.ceilingFt).toBe(1000);
	});

	it('reports an FM change that takes effect inside the window as a transition', () => {
		const taf = decoded('TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 FM212000 24010KT 9999 BKN015');
		const assessment = assessTafWindow(taf, windowFrom, windowTo, REFERENCE);
		expect(assessment.transitions).toHaveLength(1);
		// The transition has not taken effect at the start of the window.
		expect(assessment.prevailing.wind?.directionDeg).toBe(270);
	});
});

describe('ceiling helper', () => {
	it('ignores non-ceiling layers and unknown heights', () => {
		expect(lowestCeiling([{ amount: 'SCT', heightFt: 500, cumulonimbus: false, toweringCumulus: false }])).toBeNull();
		expect(
			lowestCeiling([
				{ amount: 'BKN', heightFt: null, cumulonimbus: false, toweringCumulus: false },
				{ amount: 'OVC', heightFt: 1200, cumulonimbus: false, toweringCumulus: false }
			])
		).toBe(1200);
	});
});

import { describe, expect, it } from 'vitest';
import { visibilityMetresFromChart } from '../src/minima-extraction';

/**
 * Visibility unit tests.
 *
 * The case these exist for was measured on a real chart: a LIDO approach chart prints
 * the visibility in kilometres (`ft610 - 3.4`), and the extractor reported `3.4` as
 * **3 metres** — wrong by a factor of 1000, in the direction that removes an
 * operational restriction. A wrong minima that is too low reads as permissive, which
 * is the failure mode that matters, so the conversion is deterministic and tested here
 * rather than asked of a model.
 */

describe('visibility unit conversion', () => {
	it('converts a stated kilometre figure to metres', () => {
		expect(visibilityMetresFromChart(3.4, 'km', 'ft610 - 3.4')).toEqual({ metres: 3400, convertedFrom: 'ft610 - 3.4' });
		expect(visibilityMetresFromChart(1.5, 'KM', null)).toEqual({ metres: 1500, convertedFrom: '1.5 km' });
		expect(visibilityMetresFromChart(5, 'kilometres', null)).toEqual({ metres: 5000, convertedFrom: '5 km' });
	});

	it('keeps the fractional part of a kilometre value', () => {
		// The bug this pins: the value was rounded to an integer *before* the unit was
		// known, so 2.2 km became 2 km and was stored as 2000 m instead of 2200 m.
		// Measured on the real YPKG chart, whose line reads `ft390 - 2.2V1590`.
		expect(visibilityMetresFromChart(2.2, 'km', 'ft390 - 2.2V1590').metres).toBe(2200);
		expect(visibilityMetresFromChart(3.3, 'km', '580 - 3.3V1780').metres).toBe(3300);
		expect(visibilityMetresFromChart(4.8, 'km', '850 - 4.8V2050').metres).toBe(4800);
	});

	it('leaves a stated metre figure alone', () => {
		expect(visibilityMetresFromChart(502, 'm', '560 (502-1.9)')).toEqual({ metres: 502, convertedFrom: null });
		expect(visibilityMetresFromChart(1900, 'metres', null)).toEqual({ metres: 1900, convertedFrom: null });
	});

	it('converts the LIDO shape when the parsed value lost the decimal', () => {
		// Measured: the extractor returned 3 for a line reading `ft610 - 3.4`, so the
		// integer it reported had already lost the decimal that identifies kilometres.
		expect(visibilityMetresFromChart(3, null, 'ft610 - 3.4V1810').metres).toBe(3400);
		expect(visibilityMetresFromChart(1, null, 'ft280 - 1.5').metres).toBe(1500);
		expect(visibilityMetresFromChart(5, null, 'ft960 - 5.0').metres).toBe(5000);
	});

	it('does not convert the bracketed nautical-mile decimal that shares a LIDO fragment', () => {
		expect(visibilityMetresFromChart(4, null, 'ft640 - 3.6(4.4)').metres).toBe(3600);
	});

	it('leaves an AIP fragment alone, whose decimals are nautical miles', () => {
		// `560 (502-1.9)`: 1.9 is a distance in NM and 502 is already metres. The only
		// decimal is bracketed, so nothing is converted.
		expect(visibilityMetresFromChart(502, null, '560 (502-1.9)').metres).toBe(502);
		expect(visibilityMetresFromChart(null, null, '560 (502-1.9)').metres).toBeNull();
	});

	it('refuses to convert a fragment carrying more than one decimal', () => {
		// Two decimals and no stated unit is genuinely ambiguous; the record is left for
		// review rather than converted on a guess.
		expect(visibilityMetresFromChart(1900, null, '502-1.9 1373-4.0').metres).toBe(1900);
	});

	it('leaves a whole number alone rather than guessing a unit', () => {
		// `3` could be 3 km, but it could also be a malformed reading. A whole number is
		// reported as printed and marked for review instead of being silently multiplied.
		expect(visibilityMetresFromChart(3, null, 'ft610 - 3').metres).toBe(3);
		expect(visibilityMetresFromChart(3, null, '3').metres).toBe(3);
	});

	it('leaves a value at or above the ceiling alone', () => {
		expect(visibilityMetresFromChart(800, null, '800').metres).toBe(800);
		expect(visibilityMetresFromChart(1373.0, null, '1373-4.0').metres).toBe(1373);
	});

	it('reports no conversion when there is no value', () => {
		expect(visibilityMetresFromChart(null, 'km', 'ft610 -')).toEqual({ metres: null, convertedFrom: null });
		expect(visibilityMetresFromChart(null, null, '')).toEqual({ metres: null, convertedFrom: null });
	});

	it('states what it converted from, so the reviewer can check the chart figure', () => {
		const result = visibilityMetresFromChart(3, null, 'ft610 - 3.4V1810');
		expect(result.convertedFrom).toBe('ft610 - 3.4V1810');
	});
});

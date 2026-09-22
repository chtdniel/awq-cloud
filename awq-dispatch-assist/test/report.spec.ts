import { describe, expect, it } from 'vitest';
import { evaluateWeather } from '../src/findings';

/**
 * These cases pin the behaviour that the printable dispatch report and the
 * assessment snapshot depend on. They assert on the live AWQ Cloud payload shape.
 */

const baseTaf = {
	role: 'DESTINATION',
	station: 'WIII',
	status: 'Current',
	coverage: 'Covered',
	raw: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020',
};

const cleanMonitoring = { freshness: 'Fresh', warningCount: 0, warnings: [] };

describe('report-facing guarantees', () => {
	it('always returns an array of findings, even for a hostile payload', () => {
		for (const payload of [{}, { taf: null }, { taf: {} }, { weatherMonitoring: [] }, { taf: 0, weatherMonitoring: 'x' }]) {
			const result = evaluateWeather(payload);
			expect(Array.isArray(result.findings)).toBe(true);
			expect(Array.isArray(result.messages)).toBe(true);
		}
	});

	it('gives every finding a message, evidence, code and source', () => {
		const result = evaluateWeather({
			taf: [{ ...baseTaf, status: 'Expired', coverage: 'Not covered' }],
			weatherMonitoring: { freshness: 'Stale', warnings: [{ kind: 'VA', impact: { hit: true, severity: 'Critical', nm: 5 } }] },
		});
		for (const finding of result.findings) {
			expect(finding.message.length).toBeGreaterThan(0);
			expect(finding.evidence.length).toBeGreaterThan(0);
			expect(finding.code.length).toBeGreaterThan(0);
			expect(finding.source).toBe('system');
		}
	});

	it('never emits a recommendation or a release decision in a message', () => {
		const result = evaluateWeather({
			taf: [{ ...baseTaf, status: 'Expired' }],
			weatherMonitoring: { freshness: 'Stale', warnings: [{ kind: 'VA', impact: { hit: true, severity: 'Critical', nm: 5 } }] },
		});
		// The rules layer states what the data shows; it must not decide the flight.
		for (const message of result.messages) {
			expect(message.toLowerCase()).not.toMatch(/\b(dispatch|release|depart|go|no-go|safe to|may fly|airworthy)\b/);
		}
	});

	it('keeps the flat message list aligned with structured findings', () => {
		const result = evaluateWeather({ taf: [baseTaf], weatherMonitoring: cleanMonitoring });
		expect(result.messages).toEqual(result.findings.map(finding => finding.message));
	});

	it('is deterministic for the same input', () => {
		const payload = {
			taf: [{ ...baseTaf, status: 'Expired' }],
			weatherMonitoring: { ...cleanMonitoring, warnings: [{ kind: 'VA', impact: { hit: true, nm: 9 } }] },
		};
		expect(evaluateWeather(payload)).toEqual(evaluateWeather(payload));
	});

	it('distinguishes NO_DATA from READY so a dead feed cannot look clean', () => {
		expect(evaluateWeather({ taf: [], weatherMonitoring: { warnings: [] } }).status).toBe('NO_DATA');
		expect(evaluateWeather({ taf: [baseTaf], weatherMonitoring: cleanMonitoring }).status).toBe('READY');
	});
});

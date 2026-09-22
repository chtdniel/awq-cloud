import { describe, expect, it } from 'vitest';
import { deriveStatus, evaluateWeather, highestSeverity, type Finding } from '../src/findings';

/**
 * The payloads below mirror the AWQ Cloud flight-weather contract: a `taf` array
 * of route stations and a `weatherMonitoring` block carrying warnings whose
 * `impact.hit` decides whether a warning touches the route. The warning fields
 * match live rows from the `wx_warnings` table (ISIGMET / VAAC advisories).
 */

const currentTaf = {
	role: 'DESTINATION',
	station: 'WIII',
	status: 'Current',
	coverage: 'Covered',
	raw: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020',
};

const freshMonitoring = { freshness: 'Fresh', warningCount: 0, warnings: [], fetchedAt: '2026-09-21T19:20:00.000Z' };

function warning(overrides: Record<string, unknown> = {}) {
	return {
		kind: 'VA',
		title: 'VA SIGMET DUKONO (WAAF)',
		source: 'ISIGMET',
		impact: { hit: false, severity: 'Advisory', nm: 120 },
		...overrides,
	};
}

describe('clean weather', () => {
	it('reports READY with no critical findings', () => {
		const result = evaluateWeather({ taf: [currentTaf], weatherMonitoring: freshMonitoring });
		expect(result.status).toBe('READY');
		expect(result.findings.filter(finding => finding.severity !== 'INFO')).toHaveLength(0);
	});
});

describe('TAF problems', () => {
	it('flags a missing TAF as critical', () => {
		const result = evaluateWeather({ taf: [], weatherMonitoring: { ...freshMonitoring, warnings: [warning()] } });
		const finding = result.findings.find(item => item.code === 'TAF_ABSENT');
		expect(finding?.severity).toBe('CRITICAL');
		expect(result.status).toBe('REVIEW_REQUIRED');
	});

	it('flags a non-current TAF as critical', () => {
		const result = evaluateWeather({
			taf: [{ ...currentTaf, status: 'Expired' }],
			weatherMonitoring: freshMonitoring,
		});
		const finding = result.findings.find(item => item.code === 'TAF_NOT_CURRENT');
		expect(finding?.severity).toBe('CRITICAL');
		expect(finding?.evidence).toContain('WIII');
		expect(result.status).toBe('REVIEW_REQUIRED');
	});

	it('flags an uncovered flight window as critical', () => {
		const result = evaluateWeather({
			taf: [{ ...currentTaf, coverage: 'Not covered' }],
			weatherMonitoring: freshMonitoring,
		});
		expect(result.findings.find(item => item.code === 'TAF_WINDOW_NOT_COVERED')?.severity).toBe('CRITICAL');
	});

	it('treats an absent status field as unknown rather than critical', () => {
		const result = evaluateWeather({
			taf: [{ ...currentTaf, status: undefined }],
			weatherMonitoring: freshMonitoring,
		});
		expect(result.findings.find(item => item.code === 'TAF_STATUS_UNKNOWN')?.severity).toBe('CAUTION');
		expect(result.status).toBe('READY');
	});
});

describe('weather monitoring freshness', () => {
	it('flags stale monitoring as a caution', () => {
		const result = evaluateWeather({
			taf: [currentTaf],
			weatherMonitoring: { ...freshMonitoring, freshness: 'Stale' },
		});
		expect(result.findings.find(item => item.code === 'WX_NOT_FRESH')?.severity).toBe('CAUTION');
	});

	it('flags absent freshness as a caution rather than passing silently', () => {
		const result = evaluateWeather({ taf: [currentTaf], weatherMonitoring: { warnings: [] } });
		expect(result.findings.find(item => item.code === 'WX_FRESHNESS_UNKNOWN')?.severity).toBe('CAUTION');
	});
});

describe('route-impacting warnings', () => {
	it('flags a route-impacting warning as critical and records the distance', () => {
		const result = evaluateWeather({
			taf: [currentTaf],
			weatherMonitoring: { ...freshMonitoring, warningCount: 1, warnings: [warning({ impact: { hit: true, severity: 'Critical', nm: 12 } })] },
		});
		const finding = result.findings.find(item => item.code === 'WX_ROUTE_IMPACT');
		expect(finding?.severity).toBe('CRITICAL');
		expect(finding?.evidence).toContain('12 NM from route');
		expect(finding?.evidence).toContain('DUKONO');
		expect(result.status).toBe('REVIEW_REQUIRED');
	});

	it('records a non-impacting advisory as info, not as a warning', () => {
		const result = evaluateWeather({
			taf: [currentTaf],
			weatherMonitoring: { ...freshMonitoring, warningCount: 1, warnings: [warning()] },
		});
		const finding = result.findings.find(item => item.code === 'WX_ADVISORY_IN_REGION');
		expect(finding?.severity).toBe('INFO');
		expect(result.status).toBe('READY');
	});

	it('accepts a string "true" impact flag from an upstream serialiser', () => {
		const result = evaluateWeather({
			taf: [currentTaf],
			weatherMonitoring: { ...freshMonitoring, warnings: [warning({ impact: { hit: 'true', severity: 'Warning' } })] },
		});
		expect(result.findings.find(item => item.code === 'WX_ROUTE_IMPACT')).toBeDefined();
	});
});

describe('malformed upstream data', () => {
	it('returns NO_DATA for an empty payload instead of crashing', () => {
		const result = evaluateWeather({});
		expect(result.status).toBe('NO_DATA');
		expect(result.findings.some(finding => finding.code === 'NO_DATA')).toBe(true);
	});

	it('tolerates wrong types in place of the expected arrays', () => {
		const result = evaluateWeather({ taf: 'not-an-array', weatherMonitoring: 42 });
		expect(result.status).toBe('NO_DATA');
	});

	it('tolerates a null weather block', () => {
		expect(() => evaluateWeather({ taf: [currentTaf], weatherMonitoring: null })).not.toThrow();
	});
});

describe('ordering and reduction', () => {
	it('orders critical findings before context', () => {
		const result = evaluateWeather({
			taf: [{ ...currentTaf, status: 'Expired' }],
			weatherMonitoring: { ...freshMonitoring, warnings: [warning()] },
		});
		const severities = result.findings.map(finding => finding.severity);
		const firstInfo = severities.indexOf('INFO');
		const lastCritical = severities.lastIndexOf('CRITICAL');
		if (firstInfo !== -1 && lastCritical !== -1) expect(lastCritical).toBeLessThan(firstInfo);
	});

	it('exposes flat messages for the existing report contract', () => {
		const result = evaluateWeather({ taf: [], weatherMonitoring: { ...freshMonitoring, warnings: [warning()] } });
		expect(result.messages.length).toBe(result.findings.length);
		expect(result.messages[0]).toBe(result.findings[0].message);
	});

	it('never returns READY when a critical finding exists', () => {
		const findings: Finding[] = [
			{ severity: 'CRITICAL', code: 'TAF_NOT_CURRENT', message: 'x', evidence: 'y', source: 'system' },
		];
		expect(deriveStatus(findings, 1, 0)).toBe('REVIEW_REQUIRED');
	});

	it('does not report READY when the upstream provided no data at all', () => {
		expect(deriveStatus([], 0, 0)).toBe('NO_DATA');
	});

	it('reports the highest severity present', () => {
		const findings: Finding[] = [
			{ severity: 'INFO', code: 'NO_DATA', message: 'a', evidence: 'b', source: 'system' },
			{ severity: 'CAUTION', code: 'WX_NOT_FRESH', message: 'c', evidence: 'd', source: 'system' },
		];
		expect(highestSeverity(findings)).toBe('CAUTION');
	});
});

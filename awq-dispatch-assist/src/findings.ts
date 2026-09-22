/**
 * Deterministic weather findings for a dispatch assessment.
 *
 * Why this is separate from any AI step
 *   Readiness status must not depend on a language model. This module is the
 *   authority on what the weather data actually shows; the AI layer is only ever
 *   allowed to explain these findings and cite the manual clauses that bear on
 *   them. Keeping the two apart means the status stays reproducible and testable,
 *   and an AI outage degrades the explanation rather than the decision.
 *
 * Severity meanings, used consistently by the UI, the printable report, and the
 * prompt later sent to a model:
 *   CRITICAL — dispatch release cannot proceed on this data alone
 *   CAUTION  — requires the dispatcher to verify before release
 *   INFO     — context that does not gate release
 */

export type FindingSeverity = 'CRITICAL' | 'CAUTION' | 'INFO';

export type FindingCode =
	| 'TAF_ABSENT'
	| 'TAF_NOT_CURRENT'
	| 'TAF_WINDOW_NOT_COVERED'
	| 'TAF_STATUS_UNKNOWN'
	| 'WX_NOT_FRESH'
	| 'WX_FRESHNESS_UNKNOWN'
	| 'WX_ROUTE_IMPACT'
	| 'WX_ADVISORY_IN_REGION'
	| 'NO_DATA';

export type FindingSource = 'system';

export type Finding = {
	severity: FindingSeverity;
	code: FindingCode;
	/** Short statement of what the data shows. Never a recommendation. */
	message: string;
	/** The data this finding was derived from, so the claim can be re-checked. */
	evidence: string;
	source: FindingSource;
};

export type AssessmentStatus = 'READY' | 'REVIEW_REQUIRED' | 'NO_DATA';

export type WeatherEvaluation = {
	status: AssessmentStatus;
	findings: Finding[];
	/** Flat messages, retained for the existing report and API contract. */
	messages: string[];
};

/** Severity order used when reducing findings to an overall status. */
const SEVERITY_RANK: Record<FindingSeverity, number> = { INFO: 0, CAUTION: 1, CRITICAL: 2 };

/**
 * Shape accepted here is the AWQ Cloud flight-weather payload. It is treated as
 * untrusted: every field is narrowed before use, because a malformed upstream
 * response must produce a NO_DATA verdict rather than a crash or a silent pass.
 */
export type WeatherInput = {
	taf?: unknown;
	weatherMonitoring?: unknown;
};

type TafEntry = Record<string, unknown>;

type WarningImpact = { hit?: unknown; severity?: unknown; nm?: unknown };

type Warning = {
	kind?: unknown;
	title?: unknown;
	source?: unknown;
	impact?: unknown;
	validTo?: unknown;
};

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
	return value === null || value === undefined ? '' : String(value);
}

/** `current` is the only status that satisfies the currency requirement. */
function tafCurrency(entry: TafEntry): 'current' | 'stale' | 'unknown' {
	const status = asText(entry.status).trim().toLowerCase();
	if (!status) return 'unknown';
	return status === 'current' ? 'current' : 'stale';
}

function tafCoverage(entry: TafEntry): 'covered' | 'not_covered' | 'unknown' {
	const coverage = asText(entry.coverage).trim().toLowerCase();
	if (!coverage) return 'unknown';
	return coverage === 'covered' ? 'covered' : 'not_covered';
}

function monitoringFreshness(monitoring: Record<string, unknown>): 'fresh' | 'stale' | 'unknown' {
	const freshness = asText(monitoring.freshness).trim().toLowerCase();
	if (!freshness) return 'unknown';
	return freshness === 'fresh' ? 'fresh' : 'stale';
}

/** A warning affects the route only when the upstream impact evaluation says so. */
function routeImpact(warning: Warning): { hit: boolean; severity: string; nm: number | null } {
	const impact = asRecord(warning.impact) as WarningImpact;
	const hit = impact.hit === true || asText(impact.hit).toLowerCase() === 'true';
	const severity = asText(impact.severity).trim();
	const nmRaw = impact.nm;
	const nm = typeof nmRaw === 'number' && Number.isFinite(nmRaw) ? nmRaw : null;
	return { hit, severity, nm };
}

function label(warning: Warning): string {
	const kind = asText(warning.kind) || 'Weather';
	const title = asText(warning.title) || asText(warning.source) || 'advisory';
	return `${kind} · ${title}`;
}

/**
 * Evaluate the weather payload into ordered, severity-ranked findings.
 *
 * Findings are ordered CRITICAL first so that a reader — human or model — meets
 * the release-blocking items before the context.
 */
export function evaluateWeather(input: WeatherInput): WeatherEvaluation {
	const tafEntries = asArray(input.taf).map(asRecord);
	const monitoring = asRecord(input.weatherMonitoring);
	const warnings = asArray(monitoring.warnings).map(entry => asRecord(entry) as Warning);

	const affecting = warnings.filter(warning => routeImpact(warning).hit);
	const findings: Finding[] = [];

	if (!tafEntries.length) {
		findings.push({
			severity: 'CRITICAL',
			code: 'TAF_ABSENT',
			message: 'No TAF data is available for any route station.',
			evidence: 'weather.taf is empty',
			source: 'system',
		});
	} else {
		const stale = tafEntries.filter(entry => tafCurrency(entry) === 'stale');
		const unknown = tafEntries.filter(entry => tafCurrency(entry) === 'unknown');
		const uncovered = tafEntries.filter(entry => tafCoverage(entry) !== 'covered');

		if (stale.length) {
			findings.push({
				severity: 'CRITICAL',
				code: 'TAF_NOT_CURRENT',
				message: `${stale.length} of ${tafEntries.length} route TAF reports are not current.`,
				evidence: stale
					.map(entry => `${asText(entry.station) || 'unknown station'} status=${asText(entry.status) || 'absent'}`)
					.join('; '),
				source: 'system',
			});
		}
		if (unknown.length) {
			findings.push({
				severity: 'CAUTION',
				code: 'TAF_STATUS_UNKNOWN',
				message: `Currency could not be determined for ${unknown.length} of ${tafEntries.length} route TAF reports.`,
				evidence: unknown
					.map(entry => `${asText(entry.station) || 'unknown station'} has no status field`)
					.join('; '),
				source: 'system',
			});
		}
		if (uncovered.length) {
			findings.push({
				severity: 'CRITICAL',
				code: 'TAF_WINDOW_NOT_COVERED',
				message: `The flight window is not covered by ${uncovered.length} of ${tafEntries.length} route TAF reports.`,
				evidence: uncovered
					.map(entry => `${asText(entry.station) || 'unknown station'} coverage=${asText(entry.coverage) || 'absent'}`)
					.join('; '),
				source: 'system',
			});
		}
	}

	const freshness = monitoringFreshness(monitoring);
	if (freshness === 'stale') {
		findings.push({
			severity: 'CAUTION',
			code: 'WX_NOT_FRESH',
			message: 'Weather Monitoring data is not fresh.',
			evidence: `weatherMonitoring.freshness=${asText(monitoring.freshness)}`,
			source: 'system',
		});
	}
	if (freshness === 'unknown') {
		findings.push({
			severity: 'CAUTION',
			code: 'WX_FRESHNESS_UNKNOWN',
			message: 'Weather Monitoring freshness could not be determined.',
			evidence: 'weatherMonitoring.freshness is absent',
			source: 'system',
		});
	}

	if (affecting.length) {
		const severities = [...new Set(affecting.map(warning => routeImpact(warning).severity.toLowerCase()).filter(Boolean))];
		findings.push({
			severity: 'CRITICAL',
			code: 'WX_ROUTE_IMPACT',
			message: `${affecting.length} route-impacting weather warning${affecting.length === 1 ? '' : 's'} require review.`,
			evidence: affecting
				.map(warning => {
					const impact = routeImpact(warning);
					const distance = impact.nm === null ? 'distance unknown' : `${impact.nm} NM from route`;
					return `${label(warning)} (${impact.severity || 'severity unstated'}, ${distance})`;
				})
				.join('; '),
			source: 'system',
		});
	}

	const advisories = warnings.filter(warning => !routeImpact(warning).hit);
	if (advisories.length) {
		findings.push({
			severity: 'INFO',
			code: 'WX_ADVISORY_IN_REGION',
			message: `${advisories.length} active weather advisor${advisories.length === 1 ? 'y is' : 'ies are'} published but not evaluated as affecting the route.`,
			evidence: advisories.map(label).join('; '),
			source: 'system',
		});
	}

	if (!tafEntries.length && !warnings.length) {
		findings.push({
			severity: 'INFO',
			code: 'NO_DATA',
			message: 'No TAF or weather warning data is available for this flight.',
			evidence: 'weather.taf and weatherMonitoring.warnings are both empty',
			source: 'system',
		});
	}

	const ordered = findings.sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]);
	const status = deriveStatus(ordered, tafEntries.length, warnings.length);

	return { status, findings: ordered, messages: ordered.map(finding => finding.message) };
}

/**
 * Reduce findings to the assessment status.
 *
 * A CRITICAL finding forces REVIEW_REQUIRED. With no data at all the status is
 * NO_DATA, which is deliberately distinct from READY so that a missing upstream
 * feed can never be mistaken for a clean result.
 */
export function deriveStatus(findings: Finding[], tafCount: number, warningCount: number): AssessmentStatus {
	if (findings.some(finding => finding.code === 'NO_DATA')) return 'NO_DATA';
	if (!tafCount && !warningCount) return 'NO_DATA';
	if (findings.some(finding => finding.severity === 'CRITICAL')) return 'REVIEW_REQUIRED';
	return 'READY';
}

/** Highest severity present, used for the UI status band. */
export function highestSeverity(findings: Finding[]): FindingSeverity {
	return findings.reduce<FindingSeverity>(
		(highest, finding) => (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest] ? finding.severity : highest),
		'INFO'
	);
}

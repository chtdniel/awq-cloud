import { describe, expect, it } from 'vitest';
import { assessDispatch } from '../src/dispatch';
import {
	buildDispatchInput,
	hasUsableTaf,
	resolveSchedule,
	selectRouteWarnings,
	selectTaf,
	selectTafForStation,
	toTafEntries,
	type AwqFlight,
	type AwqFlightWeather
} from '../src/awq';

/**
 * Adapter contract tests.
 *
 * The fixtures below are the live AWQ Cloud payloads captured on 2026-09-21,
 * trimmed to the rows the assertions need. They are used verbatim rather than
 * hand-written because three of the defects these tests pin — a schedule with no
 * date, an arrival that precedes its departure, and a `NIL` TAF — only exist in
 * the real feed and would never have been invented.
 */

const BOARD_FETCHED_AT = new Date('2026-09-21T22:00:14.054Z');

/** Bare `HH:MM` schedule, no date. The board fetch instant is all there is. */
const BARE_CLOCK_FLIGHT: AwqFlight = {
	id: 125,
	callsign: '809',
	flightNumber: null,
	operator: null,
	origin: 'WADD',
	destination: 'WIII',
	std: '23:00',
	sta: '00:50',
	aircraft: { type_code: null, registration: 'PK-AXY' },
	destinationAlternates: ['WIPP'],
	enrouteAlternates: ['WILL']
};

/** ISO schedule whose arrival date was not rolled past midnight. */
const OVERNIGHT_ISO_FLIGHT: AwqFlight = {
	id: 129,
	callsign: '534',
	origin: 'WADD',
	destination: 'YPPH',
	std: '2026-09-11T23:05:00.000Z',
	sta: '2026-09-11T03:00:00.000Z',
	aircraft: { type_code: null, registration: 'PK-AXD' },
	destinationAlternates: ['YPKG'],
	enrouteAlternates: ['YPPD']
};

/** ISO schedule that does not cross midnight, so no correction is expected. */
const DAYTIME_ISO_FLIGHT: AwqFlight = {
	id: 130,
	callsign: '535',
	origin: 'YPPH',
	destination: 'WADD',
	std: '2026-09-12T03:40:00.000Z',
	sta: '2026-09-12T07:25:00.000Z',
	aircraft: { type_code: null, registration: 'PK-AXD' },
	destinationAlternates: ['WADL'],
	enrouteAlternates: ['YPPD']
};

const WEATHER: AwqFlightWeather = {
	flightId: 125,
	taf: [
		{
			role: 'Departure',
			station: 'WADD',
			raw: 'TAF WADD 211700Z 2118/2300 12010KT 9999 SCT016=',
			issueTime: '2026-09-21T21:31:00.787Z',
			status: 'Current',
			coverage: 'Covered',
			validity: { label: '21 18:00Z–23 00:00Z', validFrom: '2026-09-21T18:00:00.000Z', validTo: '2026-09-23T00:00:00.000Z' }
		},
		{
			role: 'Destination',
			station: 'WIII',
			raw: 'TAF WIII 211700Z 2118/2300 10004KT 8000 FEW020 \n  BECMG 2200/2202 04012KT=',
			issueTime: '2026-09-21T21:31:00.787Z',
			status: 'Current',
			coverage: 'Covered',
			validity: { label: '21 18:00Z–23 00:00Z', validFrom: '2026-09-21T18:00:00.000Z', validTo: '2026-09-23T00:00:00.000Z' }
		},
		{
			role: 'Destination alternate',
			station: 'WIPP',
			raw: 'TAF WIPP 211700Z 2118/2218 12008KT 5000 FU SCT015 \n  TEMPO 2121/2201 2000=',
			issueTime: '2026-09-21T21:31:00.787Z',
			status: 'Current',
			coverage: 'Covered',
			validity: { label: '21 18:00Z–22 18:00Z', validFrom: '2026-09-21T18:00:00.000Z', validTo: '2026-09-22T18:00:00.000Z' }
		},
		{ role: 'Enroute alternate 1', station: 'WILL', raw: 'TAF WILL NIL=', issueTime: '2026-09-21T21:31:00.787Z', status: 'Unknown', coverage: 'Not evaluated', validity: null }
	],
	weatherMonitoring: {
		warnings: [
			{ source: 'JTWC', kind: 'TC', title: 'TYPHOON 24W (DUJUAN) WARNING NR 026', impact: { nm: 2991, hit: false, severity: null } },
			{ source: 'ISIGMET', kind: 'VA', title: 'VA SIGMET DUKONO (WAAF)', impact: { nm: 983, hit: false, severity: null } },
			{ source: 'ISIGMET', kind: 'VA', title: 'VA SIGMET SEMERU (WAAF)', impact: { nm: 29, hit: true, severity: 'Warning' } },
			{ source: 'VAAC', kind: 'VA', title: 'VA SEMERU 263300', impact: { nm: 28, hit: true, severity: 'Warning' } }
		],
		warningCount: 11,
		affectingCount: 2,
		freshness: 'Fresh'
	}
};

describe('resolving the schedule', () => {
	it('dates a bare HH:MM schedule from the board reference instant', () => {
		const schedule = resolveSchedule(BARE_CLOCK_FLIGHT, BOARD_FETCHED_AT);
		// 23:00 is the first occurrence at or after the 22:00Z fetch.
		expect(schedule.stdZ?.toISOString()).toBe('2026-09-21T23:00:00.000Z');
		// 00:50 has already passed on the 21st, so it resolves to the 22nd.
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T00:50:00.000Z');
		expect(schedule.dof?.toISOString()).toBe('2026-09-21T00:00:00.000Z');
	});

	it('records the date inference instead of making it silently', () => {
		const notes = resolveSchedule(BARE_CLOCK_FLIGHT, BOARD_FETCHED_AT).notes;
		expect(notes.join(' ')).toMatch(/carries no date/i);
	});

	it('asks for confirmation when a date had to be inferred', () => {
		const schedule = resolveSchedule(BARE_CLOCK_FLIGHT, BOARD_FETCHED_AT);
		expect(schedule.needsConfirmation).toBe(true);
		expect(schedule.adjustments.map(adjustment => adjustment.reason)).toContain('date-absent');
	});

	it('does not trust the date published in an ISO schedule value', () => {
		// AWQ Cloud's own time module documents that the date embedded in `etd`/`eta`
		// can be stale by weeks, so the clock is anchored to the board reference
		// instead. The fixture's embedded dates are ten days before the board fetch.
		const schedule = resolveSchedule(OVERNIGHT_ISO_FLIGHT, BOARD_FETCHED_AT);
		expect(schedule.stdZ?.toISOString()).toBe('2026-09-21T23:05:00.000Z');
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T03:00:00.000Z');
		expect(schedule.adjustments.every(item => item.reason === 'date-not-authoritative')).toBe(true);
		expect(schedule.adjustments[0]!.note).toMatch(/stale by weeks/i);
	});

	it('lands an overnight arrival on the next day without a special case', () => {
		const schedule = resolveSchedule(OVERNIGHT_ISO_FLIGHT, BOARD_FETCHED_AT);
		expect(schedule.staZ!.getTime()).toBeGreaterThan(schedule.stdZ!.getTime());
		expect(schedule.needsConfirmation).toBe(true);
	});

	it('anchors a daytime schedule to the board reference as well', () => {
		const schedule = resolveSchedule(DAYTIME_ISO_FLIGHT, BOARD_FETCHED_AT);
		expect(schedule.stdZ?.toISOString()).toBe('2026-09-22T03:40:00.000Z');
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T07:25:00.000Z');
		expect(schedule.needsConfirmation).toBe(true);
	});

	it('reads a bare HHMM schedule, which carries no colon', () => {
		const schedule = resolveSchedule({ id: 9, std: '2135', sta: '0320' }, BOARD_FETCHED_AT);
		expect(schedule.stdZ?.toISOString()).toBe('2026-09-21T21:35:00.000Z');
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T03:20:00.000Z');
		expect(schedule.needsConfirmation).toBe(true);
	});

	it('takes an operator override instead of inferring, and then needs no confirmation', () => {
		const schedule = resolveSchedule(BARE_CLOCK_FLIGHT, BOARD_FETCHED_AT, { staZ: new Date('2026-09-22T01:10:00.000Z') });
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T01:10:00.000Z');
		expect(schedule.needsConfirmation).toBe(false);
		expect(schedule.adjustments).toEqual([]);
	});

	it('reads exact instants when the board publishes a date of flight', () => {
		const schedule = resolveSchedule({ id: 534, std: '23:05', sta: '03:00', dof: '20260921' }, BOARD_FETCHED_AT);
		expect(schedule.stdZ?.toISOString()).toBe('2026-09-21T23:05:00.000Z');
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T03:00:00.000Z');
		// The date of flight is authoritative, so nothing needs confirming.
		expect(schedule.needsConfirmation).toBe(false);
		expect(schedule.adjustments).toEqual([]);
	});

	it('prefers the published date of flight over a stale embedded date', () => {
		const schedule = resolveSchedule(
			{ id: 534, std: '2026-09-11T23:05:00.000Z', sta: '2026-09-11T03:00:00.000Z', dof: '20260921' },
			BOARD_FETCHED_AT
		);
		expect(schedule.stdZ?.toISOString()).toBe('2026-09-21T23:05:00.000Z');
		expect(schedule.staZ?.toISOString()).toBe('2026-09-22T03:00:00.000Z');
		expect(schedule.needsConfirmation).toBe(false);
	});

	it('falls back to confirming when the date of flight is unreadable', () => {
		const schedule = resolveSchedule({ id: 534, std: '23:05', sta: '03:00', dof: 'not-a-date' }, BOARD_FETCHED_AT);
		expect(schedule.needsConfirmation).toBe(true);
	});

	it('clears the confirmation requirement when the board publishes a date of flight', () => {
		const { input, schedule } = buildDispatchInput({
			flight: { ...BARE_CLOCK_FLIGHT, dof: '20260921' },
			weather: WEATHER,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: null,
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: []
		});
		expect(schedule.needsConfirmation).toBe(false);
		expect(input.scheduleNeedsConfirmation).toBe(false);
		// The overnight arrival still lands on the following day.
		expect(input.staZ?.toISOString()).toBe('2026-09-22T00:50:00.000Z');
	});

	it('reports unusable times rather than inventing one', () => {
		const schedule = resolveSchedule({ id: 1, std: null, sta: 'not-a-time' }, BOARD_FETCHED_AT);
		expect(schedule.stdZ).toBeNull();
		expect(schedule.staZ).toBeNull();
		expect(schedule.dof).toBeNull();
		expect(schedule.notes.length).toBeGreaterThan(0);
	});
});

describe('selecting TAFs by role', () => {
	const entries = toTafEntries(WEATHER);

	it('matches the destination without capturing the destination alternate', () => {
		expect(selectTaf(entries, 'Destination')?.station).toBe('WIII');
		expect(selectTaf(entries, 'Destination alternate')?.station).toBe('WIPP');
		expect(selectTaf(entries, 'Departure')?.station).toBe('WADD');
	});

	it('finds a TAF by station, whichever role filed it', () => {
		// The alternate is chosen from the minima registry, not from the feed's role
		// label, so the lookup has to be by station.
		expect(selectTafForStation(entries, 'WIPP')?.role).toBe('Destination alternate');
		expect(selectTafForStation(entries, 'wipp')?.role).toBe('Destination alternate');
		expect(selectTafForStation(entries, 'WADD')?.role).toBe('Departure');
		expect(selectTafForStation(entries, null)).toBeNull();
		expect(selectTafForStation(entries, 'YPKG')).toBeNull();
	});

	it('returns null for a role the payload does not carry', () => {
		expect(selectTaf(entries, 'Enroute alternate 4')).toBeNull();
		expect(selectTaf([], 'Destination')).toBeNull();
	});

	it('treats a NIL report as unusable rather than as an empty forecast', () => {
		expect(hasUsableTaf(selectTaf(entries, 'Enroute alternate 1'))).toBe(false);
		expect(hasUsableTaf(selectTaf(entries, 'Destination'))).toBe(true);
		expect(hasUsableTaf(null)).toBe(false);
	});
});

describe('selecting route-impacting advisories', () => {
	it('keeps only the advisories the feed evaluated as touching the route', () => {
		const warnings = selectRouteWarnings(WEATHER);
		expect(warnings).toHaveLength(2);
		expect(warnings.map(warning => warning.title)).toEqual(['VA SIGMET SEMERU (WAAF)', 'VA SEMERU 263300']);
		expect(warnings[0]!.nm).toBe(29);
		expect(warnings[0]!.severity).toBe('Warning');
	});

	it('tolerates a payload with no monitoring block', () => {
		expect(selectRouteWarnings({})).toEqual([]);
	});
});

describe('building the engine input', () => {
	function build(flight: AwqFlight = BARE_CLOCK_FLIGHT) {
		return buildDispatchInput({
			flight,
			weather: WEATHER,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: null,
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: []
		});
	}

	it('maps the flight and weather onto the engine contract', () => {
		const { input } = build();
		expect(input.dof?.toISOString()).toBe('2026-09-21T00:00:00.000Z');
		expect(input.staZ?.toISOString()).toBe('2026-09-22T00:50:00.000Z');
		expect(input.destinationTaf).toContain('WIII');
		expect(input.alternateTaf).toBeNull();
		expect(input.alternateIcao).toBeNull();
		expect(input.routeImpactWarnings).toHaveLength(2);
	});

	it('matches the alternate weather by the selected alternate station, not the feed role', () => {
		const { input } = buildDispatchInput({
			flight: { ...BARE_CLOCK_FLIGHT, destinationAlternates: ['WIPP'] },
			weather: WEATHER,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: 'WIPP',
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: []
		});
		expect(input.alternateIcao).toBe('WIPP');
		expect(input.alternateTaf).toContain('WIPP');
	});

	it('states that a selected alternate has no forecast when the payload carries none for it', () => {
		const { input, notes } = buildDispatchInput({
			flight: BARE_CLOCK_FLIGHT,
			weather: WEATHER,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: 'YPKG',
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: []
		});
		expect(input.alternateTaf).toBeNull();
		expect(notes.join(' ')).toMatch(/no TAF for the selected alternate YPKG/i);
	});

	it('reports the payload fields it does not receive', () => {
		const notes = build().notes.join('\n');
		expect(notes).toMatch(/Diversion time is not present/i);
		expect(notes).toMatch(/No approved destination minima record/i);
		expect(notes).toMatch(/Fuel figures are not present/i);
		expect(notes).toMatch(/NOTAM REVIEW PENDING/i);
	});

	it('states the 2-hour default diversion time and the resulting window', () => {
		const notes = build().notes.join('\n');
		expect(notes).toMatch(/2-hour default/i);
		expect(notes).toMatch(/STA \+1 hr to \+3 hr/i);
	});

	it('omits an unusable destination alternate TAF instead of passing NIL through', () => {
		const weather: AwqFlightWeather = {
			...WEATHER,
			taf: [
				{ role: 'Destination', station: 'WIII', raw: 'TAF WIII 211700Z 2118/2300 10004KT 8000 FEW020=' },
				{ role: 'Destination alternate', station: 'WILL', raw: 'TAF WILL NIL=' }
			]
		};
		const { input, notes } = buildDispatchInput({
			flight: BARE_CLOCK_FLIGHT,
			weather,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: 'WILL',
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: []
		});
		expect(input.alternateTaf).toBeNull();
		expect(notes.join(' ')).toMatch(/No usable TAF is present for the selected alternate WILL/i);
	});

	it('supplies the feed currency and freshness signals to the engine', () => {
		const { input } = build();
		expect(input.destinationTafCurrency).toBe('current');
		expect(input.weatherFreshness).toBe('fresh');
	});

	it('passes an operator override through to the engine and clears the confirmation', () => {
		const { input, schedule } = buildDispatchInput({
			flight: OVERNIGHT_ISO_FLIGHT,
			weather: WEATHER,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: null,
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: [],
			scheduleOverride: { staZ: new Date('2026-09-12T03:30:00.000Z') }
		});
		expect(input.staZ?.toISOString()).toBe('2026-09-12T03:30:00.000Z');
		expect(schedule.needsConfirmation).toBe(false);
	});

	it('reads an absent status as unknown rather than assuming current', () => {
		const weather: AwqFlightWeather = {
			taf: [{ role: 'Destination', station: 'WIII', raw: 'TAF WIII 211700Z 2118/2300 10004KT 8000 FEW020=' }],
			weatherMonitoring: { warnings: [] }
		};
		const { input } = buildDispatchInput({
			flight: BARE_CLOCK_FLIGHT,
			weather,
			reference: BOARD_FETCHED_AT,
			destinationMinima: null,
			alternateIcao: null,
			alternateLandingMinima: null,
			alternatePlanningMinima: null,
			selectedNotams: []
		});
		expect(input.destinationTafCurrency).toBe('unknown');
		expect(input.weatherFreshness).toBe('unknown');
	});

	it('carries the weather payload into an assessment without claiming compliance', () => {
		// End to end on the captured payload: no approved minima and no NOTAM were
		// supplied, so the engine must not be able to reach a clean outcome.
		const assessment = assessDispatch(build().input);
		const codes = assessment.findings.map(finding => finding.code);
		expect(codes).toContain('WX_ROUTE_IMPACT');
		expect(codes).toContain('NOTAM_REVIEW_PENDING');
		expect(codes).toContain('MINIMA_NOT_AVAILABLE');
		expect(assessment.outcome).toBe('REVIEW REQUIRED');
	});
});

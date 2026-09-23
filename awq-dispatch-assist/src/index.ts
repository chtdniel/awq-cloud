/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { highestSeverity, type Finding } from './findings';
import { ingestDocument, type IngestDocument } from './ingest';
import { indexChunkSlice, indexStatus, refreshDocumentEmbeddingCounts } from './indexer';
import { retrieve } from './retrieval';
import { planningMode, planQuery } from './query-plan';
import { buildDispatchInput, type AwqFlightWeather, type ScheduleAdjustment, type ScheduleResolution } from './awq';
import {
	assessDispatch,
	type ApproachMinima,
	type ConditionalClassification,
	type DispatchFinding,
	type DispatchOutcome,
	type EtaWindows,
	type FuelRequirement,
	type SelectedNotam
} from './dispatch';
import {
	alternatePlanningMinima,
	approveRecord,
	getMinima,
	listActiveMinima,
	listMinima,
	listMinimaAirports,
	rejectRecord,
	toApproachMinima,
	updateDraft,
	type DraftCorrection
} from './minima-registry';
import { MAX_CHARTS_PER_REQUEST, MAX_CHART_BYTES } from './minima-extraction';
import {
	DEFAULT_EXTRACTION_MODEL,
	EXTRACTION_MODELS,
	createExtractionJob,
	getExtractionJob,
	isExtractionModel,
	listExtractionJobs,
	runExtractionJob,
	type ExtractionJobMessage
} from './minima-jobs';
import { listNotamCandidates, resolveSelectedNotams } from './notams';
import { citableReferenceDocuments, isExcludedFromCorpus } from './reference-corpus';
import { approvalBlockedReason, canApprove } from './minima-rules';
import type { MinimaRecord } from './minima';
import { explainDispatch, type ExplainerInput, type ExplainerResult } from './explainer';

type FlightBoardUnavailableResponse = {
	ok: false;
	code: 'SSO_REQUIRED';
	message: string;
	data: null;
};

const ASSIST_COOKIE = 'awq_assist_session';
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const DOCUMENT_CATEGORIES = new Set(['flight-plan', 'weather', 'notam', 'loadsheet', 'operational']);
const REFERENCE_CATEGORIES = new Set(['operations-manual', 'regulation', 'dispatch-manual', 'other']);

/**
 * Newest ingestion generation. Clause-aware re-ingestion writes version 2 and
 * readers select this version, so a failed re-ingestion leaves the previous
 * generation readable and rollback is a matter of lowering this constant.
 */
const CHUNK_INGEST_VERSION = 2;

/**
 * Record an audit event.
 *
 * Callers on a request path pass `ctx` so the write is attached to the request
 * lifetime via `waitUntil`. A bare floating promise here would be cancelled when
 * the response is returned, which would make the audit trail lossy exactly where
 * it matters most. The previous code used `void audit(...)`, which had that bug.
 */
export function audit(
	env: Env,
	userId: number | null,
	action: string,
	resourceType: string,
	resourceId: number | null,
	detail = '',
	ctx?: ExecutionContext
): Promise<void> {
	const write = (async (): Promise<void> => {
		try {
			await env.DB.prepare(
				'INSERT INTO dispatch_audit_events (user_id, action, resource_type, resource_id, detail) VALUES (?, ?, ?, ?, ?)'
			).bind(userId, action, resourceType, resourceId == null ? null : String(resourceId), detail).run();
		} catch (error) {
			console.warn('[DISPATCH] audit write failed', error);
		}
	})();
	if (ctx) ctx.waitUntil(write);
	return write;
}

function cookieValue(request: Request): string {
	const cookie = request.headers.get('Cookie') || '';
	const match = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${ASSIST_COOKIE}=`));
	return match ? match.slice(ASSIST_COOKIE.length + 1) : '';
}

function cookieHeader(value: string, maxAge: number): string {
	return `${ASSIST_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			'Cache-Control': 'no-store',
		},
	});
}

function redirectNoStore(location: string, cookie?: string): Response {
	const headers = new Headers({
		Location: location,
		'Cache-Control': 'no-store, private',
		Pragma: 'no-cache'
	});
	if (cookie) headers.set('Set-Cookie', cookie);
	return new Response(null, { status: 302, headers });
}

function flightBoardUnavailable(): Response {
	const body: FlightBoardUnavailableResponse = {
		ok: false,
		code: 'SSO_REQUIRED',
		message: 'AWQ Cloud SSO is required before active flight data can be requested.',
		data: null,
	};
	return jsonResponse(body, 503);
}

function documentResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function parseIds(value: unknown): number[] {
	try {
		const parsed = JSON.parse(String(value || '[]'));
		return Array.isArray(parsed) ? parsed.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 500) : [];
	} catch {
		return [];
	}
}

async function hashToken(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	let binary = '';
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function authorizeFlight(request: Request, env: Env, flightId: number): Promise<number | null> {
	const token = cookieValue(request);
	if (!token) return null;
	const user = await env.DB.prepare(
		`SELECT t.user_id
		   FROM assist_tokens t
		   JOIN auth_users u ON u.id = t.user_id
		  WHERE t.token_hash = ? AND t.revoked_at IS NULL
		    AND t.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1 AND LOWER(u.role) = 'admin'
		  LIMIT 1`
	).bind(await hashToken(token)).first<{ user_id: number }>();
	if (!user) return null;
	const board = await env.DB.prepare('SELECT row_ids FROM user_board_state WHERE user_id = ?').bind(user.user_id).first<{ row_ids: string }>();
	return parseIds(board?.row_ids).includes(flightId) ? Number(user.user_id) : null;
}

async function authorizeUser(request: Request, env: Env): Promise<number | null> {
	const token = cookieValue(request);
	if (!token) return null;
	const user = await env.DB.prepare(
		`SELECT t.user_id
		   FROM assist_tokens t
		   JOIN auth_users u ON u.id = t.user_id
		  WHERE t.token_hash = ? AND t.revoked_at IS NULL
		    AND t.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1 AND LOWER(u.role) = 'admin'
		  LIMIT 1`
	).bind(await hashToken(token)).first<{ user_id: number }>();
	return user ? Number(user.user_id) : null;
}

function safeFileName(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return normalized.slice(0, 120) || 'document.pdf';
}

/**
 * Verify a PDF by its magic bytes rather than by the client-declared MIME type.
 *
 * `file.type` is attacker-controlled and the previous check accepted any content
 * whose filename ended in `.pdf`. The header cannot be set through upload
 * metadata. The search window covers the leading bytes rather than offset zero,
 * since some producers emit a short prefix before `%PDF-`; the file is already
 * buffered by `formData()`, so this adds no extra buffering cost.
 */
async function isPdf(file: File): Promise<boolean> {
	const window = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
	const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
	for (let offset = 0; offset + signature.length <= window.length; offset += 1) {
		if (signature.every((byte, index) => window[offset + index] === byte)) return true;
	}
	return false;
}

type AssessmentFlight = {
	id: number;
	callsign?: string | number;
	flightNumber?: string | number;
	operator?: string | null;
	origin?: string | null;
	destination?: string | null;
	/** Schedule as published by the feed. Two shapes exist; see src/awq.ts. */
	std?: string | null;
	sta?: string | null;
	aircraft?: { registration?: string | null; type_code?: string | null };
	destinationAlternates?: string[];
	enrouteAlternates?: string[];
};

type AssessmentWeather = {
	taf?: Array<Record<string, unknown>>;
	weatherMonitoring?: {
		warnings?: Array<Record<string, unknown>>;
		warningCount?: number;
		fetchedAt?: string;
		freshness?: string;
	};
};

/**
 * Legacy flat shape, retained for assessments created before structured findings
 * existed. New assessments carry `structuredFindings`; readers must tolerate both.
 */
type AssessmentSnapshot = {
	contractVersion: string;
	createdAt: string;
	flight: AssessmentFlight;
	weather: AssessmentWeather;
	findings: string[];
	structuredFindings?: Finding[];
	/** Contract version 2 adds severity-graded findings. */
	referenceDocuments: Array<{ id: number; file_name: string; category: string; chunk_count: number }>;
};

/** Why an explanation was or was not produced. Recorded so a gap is visible. */
type ExplanationRecord =
	| { ok: true; model: string; promptHash: string; narrative: string }
	| { ok: false; model: string; reason: string };

type DispatchSnapshotWindows = {
	destination: { from: string; to: string };
	primaryAlternate: { from: string; to: string };
	/** True when the 2-hour default produced the alternate window, not a published time. */
	alternateUsesDefaultDiversionTime: boolean;
} | null;

/**
 * A minima value as it entered an assessment, with the record identity it came
 * from. Storing the identity and the content hash is what makes a stored outcome
 * traceable to the exact approved revision it was computed from, even after the
 * record is later corrected.
 */
type SnapshotMinima = {
	recordId: number;
	contentHash: string;
	sourceObjectKey: string;
	pdfHash: string;
	chartIdentifier: string;
	chartPage: string | null;
	approach: string;
	approachType: string | null;
	runway: string | null;
	aircraftCategory: string | null;
	kind: string;
	ceilingFt: number | null;
	visibilityM: number | null;
	aipCycle: string | null;
	effectiveFrom: string | null;
	effectiveTo: string | null;
	approvedBy: number | null;
	approvedAt: string | null;
	/** The value the engine applied, including any OM Part A Table 8.1-5 derivation. */
	applied: ApproachMinima;
};

function toSnapshotMinima(record: MinimaRecord, applied: ApproachMinima): SnapshotMinima {
	return {
		recordId: record.id,
		contentHash: record.contentHash,
		sourceObjectKey: record.sourceObjectKey,
		pdfHash: record.pdfHash,
		chartIdentifier: record.chartIdentifier,
		chartPage: record.chartPage,
		approach: record.approach,
		approachType: record.approachType,
		runway: record.runway,
		aircraftCategory: record.aircraftCategory,
		kind: record.kind,
		ceilingFt: record.ceilingFt,
		visibilityM: record.visibilityM,
		aipCycle: record.aipCycle,
		effectiveFrom: record.effectiveFrom,
		effectiveTo: record.effectiveTo,
		approvedBy: record.approvedBy,
		approvedAt: record.approvedAt,
		applied
	};
}

/**
 * Contract version 4: the deterministic assessment, its minima provenance, its
 * NOTAM review state and its explanation.
 *
 * The upstream payloads are stored verbatim alongside the derived assessment so
 * an outcome can always be re-checked against the data it was drawn from, and
 * `dataQualityNotes` records what the adapter had to infer or correct.
 */
type DispatchSnapshot = {
	contractVersion: '4';
	createdAt: string;
	flight: AssessmentFlight;
	weather: AssessmentWeather;
	dispatch: {
		outcome: DispatchOutcome;
		windows: DispatchSnapshotWindows;
		fuel: FuelRequirement;
		findings: DispatchFinding[];
		/** False means the NOTAM review is still pending, which is not "NOTAM clear". */
		notamReviewed: boolean;
		destinationStation: string | null;
		alternateStation: string | null;
		dataQualityNotes: string[];
		/** How each TEMPO/PROB group was classified for the destination window. */
		destinationConditional: ConditionalClassification[];
	};
	schedule: {
		stdZ: string | null;
		staZ: string | null;
		dof: string | null;
		/** True when a human still has to confirm a date the feed left ambiguous. */
		needsConfirmation: boolean;
		adjustments: ScheduleAdjustment[];
	};
	minima: {
		destination: SnapshotMinima | null;
		alternateLanding: SnapshotMinima | null;
		alternatePlanning: SnapshotMinima | null;
		/** How the alternate planning minima was obtained, so the derivation is visible. */
		alternatePlanningBasis: 'chart-published-alternate-minima' | 'company-table-8.1-5' | 'higher-of-both' | 'unavailable';
	};
	notams: {
		reviewed: boolean;
		selected: SelectedNotam[];
		missingIds: string[];
	};
	explanation: ExplanationRecord | null;
	referenceDocuments: Array<{ id: number; file_name: string; category: string; chunk_count: number }>;
};

/** How long the explanation may take before it is abandoned. */
const EXPLAIN_TIMEOUT_MS = 20_000;

/**
 * How long query planning may take before retrieval proceeds without it.
 *
 * Tighter than the explanation timeout on purpose: the operator is waiting on a
 * search box, and a plan that arrives late is worth less than a result that arrives
 * promptly. A timeout degrades to the pre-planner behaviour rather than failing.
 */
const ASSISTANT_PLAN_TIMEOUT_MS = 8_000;

/**
 * The DeepSeek credential is a Wrangler secret, so it is not part of the
 * generated `Env` unless the secret happened to be present when types were
 * generated  --  which is not the case on a fresh checkout. It is read through a
 * narrow shape so the Worker still compiles and still runs without it, degrading
 * to an assessment with no narrative rather than failing.
 */
function deepSeekKey(env: Env): string {
	return String((env as unknown as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY ?? '').trim();
}

function finiteNumberOrNull(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Windows are stored as ISO instants so a snapshot stays readable without a revive step. */
function serialiseWindows(windows: EtaWindows | null): DispatchSnapshotWindows {
	if (!windows) return null;
	return {
		destination: { from: windows.destination.from.toISOString(), to: windows.destination.to.toISOString() },
		primaryAlternate: { from: windows.primaryAlternate.from.toISOString(), to: windows.primaryAlternate.to.toISOString() },
		alternateUsesDefaultDiversionTime: windows.alternateUsesDefaultDiversionTime
	};
}

function toExplanationRecord(result: ExplainerResult): ExplanationRecord {
	return result.ok
		? { ok: true, model: result.model, promptHash: result.promptHash, narrative: result.narrative }
		: { ok: false, model: result.model, reason: result.reason };
}

/**
 * Coarse readiness for the `status` column.
 *
 * `dispatch_assessments.status` is constrained to the original engine's vocabulary
 * (`READY`, `REVIEW_REQUIRED`, `NO_DATA`) by a CHECK constraint, so the finer
 * outcome cannot be stored there without rebuilding the table. The outcome is kept
 * in full inside the snapshot  --  which is the record of authority  --  and mapped here:
 *
 *   GO                 -> READY
 *   everything else    -> REVIEW_REQUIRED
 *
 * The mapping is deliberately conservative in one direction only: the column never
 * reports READY unless the outcome was GO, so a collapsed value can understate
 * readiness but cannot overstate it. `json_extract` recovers the true outcome for
 * the history list.
 */
export function legacyStatusFor(outcome: DispatchOutcome): 'READY' | 'REVIEW_REQUIRED' {
	return outcome === 'GO' ? 'READY' : 'REVIEW_REQUIRED';
}

/**
 * Read an operator-supplied instant.
 *
 * Anything unparseable is ignored rather than rejected, so a malformed override
 * falls back to the published schedule and to the confirmation prompt, which is
 * the safe direction: the assessment still gets made, and it still asks.
 */
function parseInstantInput(value: unknown): Date | null {
	const raw = String(value ?? '').trim();
	if (!raw) return null;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? null : date;
}

function serialiseSchedule(schedule: ScheduleResolution): DispatchSnapshot['schedule'] {
	return {
		stdZ: schedule.stdZ ? schedule.stdZ.toISOString() : null,
		staZ: schedule.staZ ? schedule.staZ.toISOString() : null,
		dof: schedule.dof ? schedule.dof.toISOString() : null,
		needsConfirmation: schedule.needsConfirmation,
		adjustments: schedule.adjustments
	};
}

async function awqCloudJson(request: Request, env: Env, target: URL): Promise<{ response: Response; payload: unknown }> {
	const token = cookieValue(request);
	const response = await fetch(target, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
	let payload: unknown = null;
	try { payload = await response.json(); } catch { return { response, payload }; }
	return { response, payload };
}

/** A minima record id supplied by the client, or null when none was chosen. */
function parseRecordId(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Load the approved minima a request asks for.
 *
 * Only `approved` records are returned: this is the boundary that keeps an
 * unapproved AI draft out of an assessment (PRD Sec.5, acceptance Sec.29). A record
 * that is asked for but is not approved comes back as null so the engine records
 * `REVIEW REQUIRED` instead of silently using nothing.
 */
async function loadApprovedMinima(
	env: Env,
	id: number | null
): Promise<{ record: MinimaRecord | null; reason: 'not-selected' | 'not-found' | 'not-approved' }> {
	if (id === null) return { record: null, reason: 'not-selected' };
	const row = await env.DB.prepare(
		`SELECT id, status FROM airport_minima WHERE id = ? LIMIT 1`
	).bind(id).first<{ id: number; status: string }>();
	if (!row) return { record: null, reason: 'not-found' };
	if (row.status !== 'approved') return { record: null, reason: 'not-approved' };
	const record = await getMinima(env, id);
	return { record: record ? record.record : null, reason: 'not-selected' };
}

/**
 * Create an immutable dispatch assessment for one flight.
 *
 * The outcome is produced by the deterministic engine and the explanation
 * afterwards. The order matters: an AI outage degrades the write-up, never the
 * decision, so the assessment is complete and storable before any model is
 * called.
 *
 * Minima are referenced by registry record id rather than typed into the request.
 * The engine therefore only ever compares against values an ADMIN dispatcher has
 * approved against the AIP chart, and the snapshot keeps the record identity so
 * the value can be traced afterwards.
 */
async function createAssessment(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: {
		flightId?: number;
		primaryAlternate?: unknown;
		minima?: unknown;
		notamIds?: unknown;
		explain?: unknown;
		schedule?: unknown;
	};
	try { body = await request.json() as typeof body; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }
	const flightId = Number(body.flightId || 0);
	if (!Number.isInteger(flightId) || flightId <= 0) return documentResponse({ error: 'A valid flightId is required.' }, 400);
	const userId = await authorizeFlight(request, env, flightId);
	if (!userId) return documentResponse({ error: 'SSO is required for this flight.' }, 401);

	// An operator-stated arrival date takes precedence over anything the adapter
	// would infer, and removes the confirmation requirement for that field.
	const scheduleBody = (body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule) ? body.schedule : {}) as Record<string, unknown>;
	const overrideSta = parseInstantInput(scheduleBody.staZ);

	// The alternate and both minima come from the registry. Nothing numeric is
	// accepted from the client, so a request cannot introduce a minima value that
	// no ADMIN has verified.
	const alternateIcao = String(body.primaryAlternate ?? '').trim().toUpperCase().slice(0, 4) || null;
	if (alternateIcao !== null && !/^[A-Z0-9]{4}$/.test(alternateIcao)) {
		return documentResponse({ error: 'primaryAlternate must be a four-character ICAO location indicator.' }, 400);
	}
	const minimaBody = (body.minima && typeof body.minima === 'object' && !Array.isArray(body.minima) ? body.minima : {}) as Record<string, unknown>;
	const destinationId = parseRecordId(minimaBody.destination);
	const alternateLandingId = parseRecordId(minimaBody.alternateLanding);
	const alternatePlanningId = parseRecordId(minimaBody.alternatePlanning);
	const notamIds = Array.isArray(body.notamIds)
		? body.notamIds.map(value => String(value).trim()).filter(Boolean).slice(0, 50)
		: [];
	const wantExplanation = body.explain !== false;

	const boardTarget = new URL(`${env.AWQ_CLOUD_API_ORIGIN}/api/assist`);
	boardTarget.searchParams.set('mode', 'flight-board');
	const weatherTarget = new URL(`${env.AWQ_CLOUD_API_ORIGIN}/api/assist`);
	weatherTarget.searchParams.set('mode', 'flight-weather');
	weatherTarget.searchParams.set('flight_id', String(flightId));
	const [board, weather] = await Promise.all([awqCloudJson(request, env, boardTarget), awqCloudJson(request, env, weatherTarget)]);
	if (!board.response.ok || !weather.response.ok) return documentResponse({ error: 'AWQ Cloud flight context is unavailable.' }, 502);
	const boardData = (board.payload as { data?: { flights?: AssessmentFlight[]; fetchedAt?: string } } | null)?.data;
	const flight = boardData?.flights?.find(item => Number(item.id) === flightId);
	if (!flight) return documentResponse({ error: 'The selected flight is no longer active.' }, 409);
	const weatherData = ((weather.payload as { data?: AssessmentWeather } | null)?.data || {}) as AssessmentWeather;

	// The board's own fetch instant dates a schedule that arrives without one, so
	// it is preferred over the Worker clock; that fallback only applies when the
	// field is missing or unparseable.
	const reference = new Date(String(boardData?.fetchedAt ?? ''));
	const boardReference = Number.isNaN(reference.getTime()) ? new Date() : reference;

	// Resolve the minima records and the selected NOTAM before the engine runs, so
	// a missing or unapproved record becomes a recorded gap rather than a silently
	// absent comparison.
	const [destinationLookup, alternateLandingLookup, alternatePlanningLookup] = await Promise.all([
		loadApprovedMinima(env, destinationId),
		loadApprovedMinima(env, alternateLandingId),
		loadApprovedMinima(env, alternatePlanningId)
	]);
	const destinationRecord = destinationLookup.record;
	const alternateLandingRecord = alternateLandingLookup.record;
	const alternatePlanningRecord = alternatePlanningLookup.record;

	const stationLocations = [
		String(flight.destination ?? '').trim().toUpperCase(),
		String(flight.origin ?? '').trim().toUpperCase(),
		alternateIcao ?? ''
	].filter(value => /^[A-Z0-9]{4}$/.test(value));
	const notamResolution = await resolveSelectedNotams(env, notamIds, stationLocations);

	// The alternate planning minima is the chart's published `Alternate Minima`
	// when the registry holds one for this approach, otherwise the company minima
	// of OM Part A Table 8.1-5 derived from the landing value  --  and the higher of
	// the two when both exist, as the note under that table requires.
	let alternatePlanningBasis: DispatchSnapshot['minima']['alternatePlanningBasis'] = 'unavailable';
	let alternatePlanningApplied: ApproachMinima | null = null;
	let alternatePlanningSource: MinimaRecord | null = null;
	if (alternatePlanningRecord && alternateLandingRecord) {
		alternatePlanningApplied = alternatePlanningMinima(alternateLandingRecord, alternatePlanningRecord);
		alternatePlanningBasis = 'higher-of-both';
		alternatePlanningSource = alternateLandingRecord;
	} else if (alternatePlanningRecord) {
		alternatePlanningApplied = alternatePlanningMinima(null, alternatePlanningRecord);
		alternatePlanningBasis = 'chart-published-alternate-minima';
		alternatePlanningSource = alternatePlanningRecord;
	} else if (alternateLandingRecord) {
		alternatePlanningApplied = alternatePlanningMinima(alternateLandingRecord, null);
		alternatePlanningBasis = 'company-table-8.1-5';
		alternatePlanningSource = alternateLandingRecord;
	}

	const adapted = buildDispatchInput({
		flight,
		weather: weatherData as AwqFlightWeather,
		reference: boardReference,
		destinationMinima: destinationRecord ? toApproachMinima(destinationRecord) : null,
		alternateIcao,
		alternateLandingMinima: alternateLandingRecord ? toApproachMinima(alternateLandingRecord) : null,
		alternatePlanningMinima: alternatePlanningApplied,
		selectedNotams: notamResolution.selected,
		scheduleOverride: overrideSta ? { staZ: overrideSta } : {}
	});
	const evaluation = assessDispatch(adapted.input);

	// Report the minima lookups the request asked for but could not use. A record
	// that is only a draft is the case PRD acceptance Sec.29 requires to be visible.
	const minimaNotes: string[] = [];
	if (destinationId !== null && !destinationRecord) {
		minimaNotes.push(`Destination minima record ${destinationId} is ${destinationLookup.reason === 'not-approved' ? 'not approved' : 'not available'}, so no destination minima was applied.`);
	}
	if (alternateLandingId !== null && !alternateLandingRecord) {
		minimaNotes.push(`Alternate landing minima record ${alternateLandingId} is ${alternateLandingLookup.reason === 'not-approved' ? 'not approved' : 'not available'}, so the TEMPO concession cannot be evaluated.`);
	}
	if (alternatePlanningId !== null && !alternatePlanningRecord) {
		minimaNotes.push(`Alternate published minima record ${alternatePlanningId} is ${alternatePlanningLookup.reason === 'not-approved' ? 'not approved' : 'not available'}, so company planning minima was derived instead where possible.`);
	}
	if (notamResolution.missing.length) {
		minimaNotes.push(`${notamResolution.missing.length} selected NOTAM could not be attached: ${notamResolution.missing.join(', ')}. The review is incomplete.`);
	}
	const dataQualityNotes = [...adapted.notes, ...minimaNotes];

	let explanation: ExplanationRecord | null = null;
	if (wantExplanation) {
		const explainerInput: ExplainerInput = {
			flightLabel: String(flight.callsign || flight.flightNumber || flight.id),
			origin: flight.origin ?? null,
			destination: flight.destination ?? null,
			registration: flight.aircraft?.registration ?? null,
			destinationAlternates: alternateIcao ? [alternateIcao] : [],
			outcome: evaluation.outcome,
			windows: evaluation.windows,
			diversionMinutes: adapted.input.diversionMinutes,
			findings: evaluation.findings,
			fuel: evaluation.fuel,
			notamReviewed: evaluation.notamReviewed
		};
		explanation = toExplanationRecord(
			await explainDispatch({ apiKey: deepSeekKey(env), timeoutMs: EXPLAIN_TIMEOUT_MS }, explainerInput)
		);
	}

	const references = await env.DB.prepare(
		`SELECT d.id, d.file_name, d.category, COUNT(c.id) AS chunk_count
		   FROM reference_documents d
		   LEFT JOIN reference_document_chunks c
		     ON c.reference_document_id = d.id AND c.ingest_version = ?
		  GROUP BY d.id, d.file_name, d.category
		  ORDER BY d.created_at ASC, d.id ASC`
	).bind(CHUNK_INGEST_VERSION).all<{ id: number; file_name: string; category: string; chunk_count: number }>();
	// Only the citable corpus is recorded as applied. A document that is indexed but
	// outside the agreed rule sources (CASR) must not appear in an assessment or in
	// the report's list of reference manuals, because appearing there reads as it
	// having been applied to this flight.
	const citableReferences = citableReferenceDocuments(references.results || []);
	const snapshot: DispatchSnapshot = {
		contractVersion: '4',
		createdAt: new Date().toISOString(),
		flight,
		weather: weatherData,
		dispatch: {
			outcome: evaluation.outcome,
			windows: serialiseWindows(evaluation.windows),
			fuel: evaluation.fuel,
			findings: evaluation.findings,
			notamReviewed: evaluation.notamReviewed,
			destinationStation: adapted.destinationStation,
			alternateStation: adapted.alternateStation,
			dataQualityNotes,
			destinationConditional: evaluation.destinationConditional
		},
		minima: {
			destination: destinationRecord
				? toSnapshotMinima(destinationRecord, toApproachMinima(destinationRecord))
				: null,
			alternateLanding: alternateLandingRecord
				? toSnapshotMinima(alternateLandingRecord, toApproachMinima(alternateLandingRecord))
				: null,
			alternatePlanning:
				alternatePlanningApplied && alternatePlanningSource
					? toSnapshotMinima(alternatePlanningSource, alternatePlanningApplied)
					: null,
			alternatePlanningBasis
		},
		notams: {
			reviewed: evaluation.notamReviewed,
			selected: notamResolution.selected,
			missingIds: notamResolution.missing
		},
		explanation,
		schedule: serialiseSchedule(adapted.schedule),
		referenceDocuments: citableReferences,
	};
	const contextHash = await hashToken(JSON.stringify(snapshot));
	const result = await env.DB.prepare(
		`INSERT INTO dispatch_assessments (flight_id, user_id, status, decision, contract_version, snapshot_json, context_hash)
		 VALUES (?, ?, ?, 'OPEN', '4', ?, ?)`
	).bind(flightId, userId, legacyStatusFor(evaluation.outcome), JSON.stringify(snapshot), contextHash).run();
	const assessmentId = Number(result.meta.last_row_id);
	await audit(
		env,
		userId,
		'assessment_create',
		'dispatch_assessment',
		assessmentId,
		`${evaluation.outcome} findings=${evaluation.findings.length} holding=${evaluation.fuel.mandatoryHoldingMinutes}min padding=${evaluation.fuel.advisoryPaddingMinutes}min notam=${evaluation.notamReviewed ? 'reviewed' : 'pending'} minima=dest:${destinationRecord?.id ?? 'none'}/alt:${alternateLandingRecord?.id ?? 'none'}`,
		ctx
	);
	return documentResponse({
		ok: true,
		data: {
			id: assessmentId,
			flightId,
			outcome: evaluation.outcome,
			decision: 'OPEN',
			contextHash,
			findings: evaluation.findings,
			fuel: evaluation.fuel,
			explanation,
			schedule: serialiseSchedule(adapted.schedule),
			snapshot
		}
	}, 201);
}

async function listAssessments(request: Request, env: Env, url: URL): Promise<Response> {
	const flightId = Number(url.searchParams.get('flight_id') || 0);
	if (!Number.isInteger(flightId) || flightId <= 0) return documentResponse({ error: 'A valid flight_id is required.' }, 400);
	if (!await authorizeFlight(request, env, flightId)) return documentResponse({ error: 'SSO is required for this flight.' }, 401);
	const { results } = await env.DB.prepare(
		// `outcome` is lifted out of the snapshot in SQL rather than parsed in JS: the
		// column only holds the coarse readiness value, and parsing up to twenty full
		// snapshots (each carrying the raw upstream payload) to read one field would be
		// wasteful. It is null for contract-2 and contract-3 rows, where the caller
		// falls back to `status`.
		`SELECT id, flight_id, status, decision, contract_version, context_hash, created_at, reviewed_at, review_note,
		        json_extract(snapshot_json, '$.dispatch.outcome') AS outcome,
		        json_extract(snapshot_json, '$.dispatch.verdict') AS legacy_verdict
		   FROM dispatch_assessments WHERE flight_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`
	).bind(flightId).all();
	return documentResponse({ ok: true, data: { assessments: results || [] } });
}

async function getAssessment(request: Request, env: Env, assessmentId: number): Promise<{ response?: Response; userId?: number; assessment?: { id: number; flight_id: number; status: string; decision: string; contract_version: string; snapshot_json: string; context_hash: string; created_at: string; reviewed_at: string | null; review_note: string | null } }> {
	const assessment = await env.DB.prepare(
		`SELECT id, flight_id, status, decision, contract_version, snapshot_json, context_hash, created_at, reviewed_at, review_note
		   FROM dispatch_assessments WHERE id = ? LIMIT 1`
	).bind(assessmentId).first<{ id: number; flight_id: number; status: string; decision: string; contract_version: string; snapshot_json: string; context_hash: string; created_at: string; reviewed_at: string | null; review_note: string | null }>();
	if (!assessment) return { response: documentResponse({ error: 'Assessment not found.' }, 404) };
	const userId = await authorizeFlight(request, env, Number(assessment.flight_id));
	if (!userId) return { response: documentResponse({ error: 'SSO is required for this flight.' }, 401) };
	return { userId, assessment };
}

async function reviewAssessment(request: Request, env: Env, assessmentId: number): Promise<Response> {
	const loaded = await getAssessment(request, env, assessmentId);
	if (loaded.response) return loaded.response;
	let body: { decision?: string; note?: string };
	try { body = await request.json() as { decision?: string; note?: string }; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }
	const decision = String(body.decision || '').toUpperCase();
	if (decision !== 'ACCEPTED' && decision !== 'REJECTED') return documentResponse({ error: 'Decision must be ACCEPTED or REJECTED.' }, 400);
	const note = String(body.note || '').trim().slice(0, 1000) || null;
	await env.DB.prepare('UPDATE dispatch_assessments SET decision = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, review_note = ? WHERE id = ?').bind(decision, loaded.userId, note, assessmentId).run();
	await audit(env, loaded.userId || null, 'assessment_review', 'dispatch_assessment', assessmentId, decision);
	return documentResponse({ ok: true, data: { id: assessmentId, decision, reviewNote: note } });
}

function escapeHtml(value: unknown): string {
	return String(value ?? '').replace(/[&<>\"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[character] || character));
}

/**
 * Printable report styling.
 *
 * The report is a formal operational document, not a screenshot of the dashboard:
 * light ground, rule-separated sections, tabular data, and no dark chrome, because
 * it has to print legibly in black and white and be read on paper. Values are
 * monospaced where they are codes, times or measurements.
 */
const REPORT_STYLE = [
	':root{--ink:#141c26;--muted:#57646f;--rule:#c3ccd4;--panel:#f5f7f8;--amber:#a9701a;--good:#1c6b41;--warn:#8a5a00;--bad:#8c2b20}',
	'*{box-sizing:border-box}',
	'body{font-family:"Segoe UI",Arial,Helvetica,sans-serif;color:var(--ink);max-width:1000px;margin:0 auto;padding:32px 28px 56px;line-height:1.5;font-size:13px;background:#fff}',
	'header.doc{border-bottom:3px solid var(--amber);padding-bottom:12px;margin-bottom:20px}',
	'.brandline{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}',
	'.brand{font-weight:800;letter-spacing:.14em;font-size:12px;color:var(--amber);text-transform:uppercase}',
	'h1{font-size:21px;margin:6px 0 2px;letter-spacing:-.01em}',
	'h2{font-size:13px;margin:26px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--rule);text-transform:uppercase;letter-spacing:.08em}',
	'h3{font-size:12px;margin:14px 0 4px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}',
	'.meta{color:var(--muted);font-size:11px}',
	'.stamp{margin:14px 0 4px;padding:10px 14px;border:1px solid var(--rule);border-left:3px solid var(--amber);background:var(--panel)}',
	'.stamp strong{display:block;font-size:12px;letter-spacing:.06em;text-transform:uppercase}',
	'.stamp p{margin:4px 0 0;font-size:11px;color:var(--muted)}',
	'.badge{display:inline-block;padding:4px 10px;border:1px solid var(--rule);border-radius:2px;font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-right:6px}',
	'.badge--go{background:#e3f4ea;border-color:#9ccfae;color:var(--good)}',
	'.badge--marginal{background:#fff4dd;border-color:#e0c274;color:var(--warn)}',
	'.badge--nogo{background:#fbe3e0;border-color:#e0a49c;color:var(--bad)}',
	'.badge--reviewrequired{background:#eef3f8;border-color:#a9bccd;color:#28516f}',
	'.badge--notamreviewpending{background:#fff1dc;border-color:#e0b877;color:var(--warn)}',
	'.finding{padding:10px 12px;border:1px solid var(--rule);border-left-width:3px;margin-bottom:7px;background:#fff}',
	'.finding--critical{border-left-color:#a5342a;background:#fdf4f3}',
	'.finding--caution{border-left-color:#c08a1e;background:#fdfaf1}',
	'.finding--info{border-left-color:#4d6d87;background:#f6f8fa}',
	'.finding .head{display:flex;gap:8px;align-items:baseline}',
	'.severity{font-weight:700;font-size:10px;letter-spacing:.08em;text-transform:uppercase;min-width:70px}',
	'.code{font-family:Consolas,"SFMono-Regular",monospace;font-size:10px;color:var(--muted)}',
	'.evidence{color:var(--muted);font-size:11px;margin-top:4px}',
	'table{border-collapse:collapse;width:100%;margin-top:10px;font-size:12px}',
	'th,td{border:1px solid var(--rule);padding:6px 8px;text-align:left;vertical-align:top}',
	'th{background:var(--panel);font-size:10px;text-transform:uppercase;letter-spacing:.06em}',
	'td.num,th.num{text-align:right;font-family:Consolas,"SFMono-Regular",monospace}',
	'.mono{font-family:Consolas,"SFMono-Regular",monospace}',
	'ol.citations{margin:8px 0 0;padding-left:22px}',
	'ol.citations li{margin-bottom:4px}',
	'.refnum{font-family:Consolas,"SFMono-Regular",monospace;font-weight:700;color:var(--amber)}',
	'.disclaimer{margin-top:26px;padding:10px 14px;border:1px solid var(--rule);background:var(--panel);font-size:11px;color:#3d4a57}',
	'.narrative{white-space:pre-wrap;background:var(--panel);border:1px solid var(--rule);padding:12px 14px;font-size:12px}',
	'.note{color:var(--muted);font-size:11px}',
	'ul.tight{margin:6px 0 0;padding-left:20px}',
	'ul.tight li{margin-bottom:3px}',
	'.toolbar{position:sticky;top:0;background:#fff;padding:0 0 12px}',
	'.toolbar button{padding:8px 14px;border:1px solid var(--rule);background:var(--panel);font:inherit;font-weight:600;cursor:pointer}',
	'@media print{.toolbar{display:none}body{padding:0}h2{page-break-after:avoid}.finding,table{page-break-inside:avoid}}',
].join('');

/** Reference numbers for the citation list, keyed by the reference text. */
function citationIndex(findings: readonly { references: readonly string[] }[], fuelReferences: readonly string[]): Map<string, number> {
	const order = new Map<string, number>();
	const add = (reference: string): void => {
		if (!order.has(reference)) order.set(reference, order.size + 1);
	};
	for (const finding of findings) for (const reference of finding.references) add(reference);
	for (const reference of fuelReferences) add(reference);
	return order;
}

/** Render `1, 3` beside a finding, so its sources are findable in the list below. */
function citationNumbers(references: readonly string[], index: Map<string, number>): string {
	const numbers = references.map(reference => index.get(reference)).filter((value): value is number => value !== undefined);
	return numbers.length ? `[${numbers.join(', ')}]` : '';
}

/** A minima block with its provenance, or an explicit statement that it is absent. */
function minimaTable(title: string, value: SnapshotMinima | null, basisNote: string): string {
	if (!value) {
		return `<h3>${escapeHtml(title)}</h3><p class="note">Not available. No approved minima record was applied, so this comparison could not be made.</p>`;
	}
	return `<h3>${escapeHtml(title)}</h3>
<table><tbody>
<tr><th>Approach</th><td>${escapeHtml(value.approach)}${value.approachType ? ` (${escapeHtml(value.approachType)})` : ''}</td></tr>
<tr><th>Runway</th><td class="mono">${escapeHtml(value.runway ?? 'not stated')}</td></tr>
<tr><th>Aircraft category</th><td class="mono">${escapeHtml(value.aircraftCategory ?? 'not stated')}</td></tr>
<tr><th>Ceiling / visibility applied</th><td class="mono">${escapeHtml(value.applied.ceilingFt ?? 'not stated')} ft / ${escapeHtml(value.applied.visibilityM ?? 'not stated')} m</td></tr>
<tr><th>Published on chart</th><td class="mono">${escapeHtml(value.ceilingFt ?? 'not stated')} ft / ${escapeHtml(value.visibilityM ?? 'not stated')} m</td></tr>
<tr><th>Source</th><td>${escapeHtml(value.sourceObjectKey)}<br><span class="note">Page ${escapeHtml(value.chartPage ?? 'not stated')} * AIP cycle ${escapeHtml(value.aipCycle ?? 'not stated')} * effective ${escapeHtml(value.effectiveFrom ?? 'not stated')}${value.effectiveTo ? ` to ${escapeHtml(value.effectiveTo)}` : ''}</span></td></tr>
<tr><th>PDF hash</th><td class="mono">${escapeHtml(value.pdfHash.slice(0, 32))}...</td></tr>
<tr><th>Approved</th><td>Record ${escapeHtml(value.recordId)} by user ${escapeHtml(value.approvedBy ?? 'unknown')} at ${escapeHtml(value.approvedAt ?? 'unknown')} UTC</td></tr>
<tr><th>Basis</th><td>${escapeHtml(basisNote)}</td></tr>
</tbody></table>`;
}

/**
 * Render a contract-4 assessment.
 *
 * Everything printed comes from the stored snapshot, never from live data: that is
 * what makes the report match the assessment that was reviewed (PRD Sec.15). The
 * review-state banner is printed even when the outcome is clean, so a report taken
 * before the review finished cannot be mistaken for a finished one (PRD acceptance
 * Sec.22).
 */
function renderDispatchReport(assessment: StoredAssessment, snapshot: DispatchSnapshot): Response {
	const { dispatch } = snapshot;
	const windows = dispatch.windows;
	const destinationWindow = windows ? `${zuluLabel(windows.destination.from)} - ${zuluLabel(windows.destination.to)}` : 'not available';
	const alternateWindow = windows ? `${zuluLabel(windows.primaryAlternate.from)} - ${zuluLabel(windows.primaryAlternate.to)}` : 'not available';
	const diversionNote = windows
		? windows.alternateUsesDefaultDiversionTime
			? 'Default diversion time: 2 hours. Source diversion time unavailable.'
			: 'Diversion time as published by the flight plan.'
		: 'No diversion window could be computed.';

	const citationOrder = citationIndex(dispatch.findings, dispatch.fuel.references);
	const citationList = [...citationOrder.entries()]
		.sort((left, right) => left[1] - right[1])
		.map(([reference, number]) => `<li><span class="refnum">[${number}]</span> ${escapeHtml(reference)}</li>`)
		.join('');

	const findingBlocks = dispatch.findings.length
		? dispatch.findings
				.map(
					item =>
						`<div class="finding finding--${escapeHtml(item.severity.toLowerCase())}"><div class="head"><span class="severity">${escapeHtml(item.severity)}</span><span class="code">${escapeHtml(item.code)}</span><span class="refnum">${escapeHtml(citationNumbers(item.references, citationOrder))}</span></div><div>${escapeHtml(item.message)}</div><div class="evidence">Evidence: ${escapeHtml(item.evidence)}</div><div class="evidence">References: ${escapeHtml(item.references.join(' * ') || 'none cited')}</div></div>`
				)
				.join('')
		: '<p>No findings recorded.</p>';

	const dataQuality = dispatch.dataQualityNotes.length
		? `<ul class="tight">${dispatch.dataQualityNotes.map(note => `<li class="note">${escapeHtml(note)}</li>`).join('')}</ul>`
		: '<p class="note">No data-quality corrections were required.</p>';

	const conditionalRows = dispatch.destinationConditional.length
		? dispatch.destinationConditional
				.map(
					entry =>
						`<tr><td class="mono">${escapeHtml(entry.groupType)}</td><td>${escapeHtml(entry.nature)}</td><td>${escapeHtml(entry.applies ? 'Applicable to destination planning minima' : 'Not applicable  --  disregarded for planning minima')}</td><td class="mono">${escapeHtml(entry.phenomena.join(' ') || 'none stated')}</td></tr>`
				)
				.join('')
		: '<tr><td colspan="4">No conditional group affects the destination window.</td></tr>';

	const taf = Array.isArray(snapshot.weather?.taf) ? snapshot.weather.taf : [];
	const tafRows = taf
		.map(
			item =>
				`<tr><td class="mono">${escapeHtml(item.role)}</td><td class="mono">${escapeHtml(item.station)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.coverage)}</td><td class="mono">${escapeHtml(item.raw)}</td></tr>`
		)
		.join('');

	const notamRows = snapshot.notams.selected.length
		? snapshot.notams.selected
				.map(
					notam =>
						`<tr><td class="mono">${escapeHtml(notam.id)}</td><td class="mono">${escapeHtml(notam.location)}</td><td class="mono">${escapeHtml(notam.validFrom ?? 'not stated')}<br>${escapeHtml(notam.validTo ?? 'not stated')}</td><td class="mono">${escapeHtml(notam.message.slice(0, 900))}</td></tr>`
				)
				.join('')
		: '';

	const fuelCriteria = dispatch.fuel.paddingCriteria.length
		? `<ul class="tight">${dispatch.fuel.paddingCriteria.map(criterion => `<li>${escapeHtml(criterion.statement)}<br><span class="note">${escapeHtml(criterion.evidence)} * ${escapeHtml(criterion.minutes)} min * ${escapeHtml(criterion.references.join(' * '))}</span></li>`).join('')}</ul>`
		: '<p class="note">No standard fuel padding criterion was matched by this forecast.</p>';

	const references = Array.isArray(snapshot.referenceDocuments) ? snapshot.referenceDocuments : [];
	const documentRows = references
		.map(item => `<li>${escapeHtml(item.file_name)} * ${escapeHtml(item.category)} * ${escapeHtml(item.chunk_count)} indexed excerpts</li>`)
		.join('');

	const minimaBasis: Record<DispatchSnapshot['minima']['alternatePlanningBasis'], string> = {
		'chart-published-alternate-minima': 'Alternate minima published on the AIP chart (OM Part A 8.1.2.2.4 note).',
		'company-table-8.1-5': 'Company planning minima derived from the landing minima per OM Part A Table 8.1-5.',
		'higher-of-both': 'Higher of the chart-published alternate minima and the company minima per OM Part A Table 8.1-5 note.',
		unavailable: 'Not available.'
	};
	/**
	 * State the approval gate explicitly.
	 *
	 * A reader of the report cannot see the registry or the review screen, so they
	 * cannot know whether the minima this assessment applied had been checked against
	 * its chart. Printing the gate on the report is what makes the claim checkable
	 * from the document alone.
	 */
	const minimaApproval = [snapshot.minima.destination, snapshot.minima.alternateLanding, snapshot.minima.alternatePlanning].every(
		entry => entry !== null && entry.approvedBy !== null && entry.approvedAt !== null
	)
		? '<p class="note">Every minima value applied above is an approved registry record: an ADMIN dispatcher compared it against the AIP chart and the approval is recorded with its identity and time. Unapproved values are never applied, and a missing value is reported as REVIEW REQUIRED rather than assumed.</p>'
		: '<p class="note">At least one minima value above is missing or was not applied, because no approved registry record existed for it. An unapproved or absent value is never used as if it were valid.</p>';

	const explanation = snapshot.explanation;
	const narrative =
		explanation && explanation.ok
			? `<div class="narrative">${escapeHtml(explanation.narrative)}</div><p class="note">Model ${escapeHtml(explanation.model)} * prompt hash ${escapeHtml(explanation.promptHash)}</p>`
			: `<p class="note">No model narrative was produced (${escapeHtml(explanation ? explanation.reason : 'not requested')}). The deterministic assessment above stands on its own.</p>`;

	const draftLabel =
		dispatch.outcome === 'NOTAM REVIEW PENDING'
			? 'DRAFT / NOTAM REVIEW PENDING'
			: dispatch.outcome === 'REVIEW REQUIRED' || dispatch.outcome === 'MARGINAL'
				? 'DRAFT / REVIEW REQUIRED'
				: null;

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dispatch Assessment ${escapeHtml(assessment.id)}</title><style>${REPORT_STYLE}</style></head><body>
<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
<header class="doc">
	<div class="brandline">
		<div>
			<div class="brand">AWQ Cloud * Dispatch Assist</div>
			<h1>Operational Dispatch Assessment</h1>
			<p class="meta">Assessment #${escapeHtml(assessment.id)} * Flight ${escapeHtml(snapshot.flight.callsign || snapshot.flight.flightNumber || snapshot.flight.id)} * Created ${escapeHtml(assessment.created_at)} UTC</p>
		</div>
		<div>
			<span class="badge badge--${escapeHtml(verdictSlug(dispatch.outcome))}">Assessment outcome: ${escapeHtml(dispatch.outcome)}</span>
			<span class="badge">Decision: ${escapeHtml(assessment.decision)}</span>
		</div>
	</div>
</header>
${draftLabel ? `<div class="stamp"><strong>${escapeHtml(draftLabel)}</strong><p>This report was produced before the assessment review finished. It is not a completed assessment and must not be read as one.</p></div>` : ''}
<div class="stamp"><strong>Assessment outcome, not a dispatch release</strong><p>This document supports a dispatcher decision. It is not a dispatch release, not a compliance certification, and not an airworthiness determination. Every value below is taken from the stored assessment snapshot and the citation list at the end of this document.</p></div>

<h2>Flight context</h2>
<table><tbody>
<tr><th>Route</th><td class="mono">${escapeHtml(snapshot.flight.origin)} -> ${escapeHtml(snapshot.flight.destination)}</td></tr>
<tr><th>Registration</th><td class="mono">${escapeHtml(snapshot.flight.aircraft?.registration ?? 'not stated')}</td></tr>
<tr><th>Date of flight</th><td class="mono">${escapeHtml((snapshot.schedule.dof ?? '').slice(0, 10) || 'not established')}</td></tr>
<tr><th>Scheduled arrival (STA)</th><td class="mono">${zuluLabel(snapshot.schedule.staZ ?? undefined)}</td></tr>
<tr><th>Primary alternate</th><td class="mono">${escapeHtml(dispatch.alternateStation ?? 'not selected')}</td></tr>
</tbody></table>

<h2>1. ETA windows</h2>
<table><thead><tr><th>Point</th><th>Aerodrome</th><th>Window (Zulu)</th></tr></thead><tbody>
<tr><td>Destination (STA +/- 1 hr)</td><td class="mono">${escapeHtml(dispatch.destinationStation || 'unknown')}</td><td class="mono">${escapeHtml(destinationWindow)}</td></tr>
<tr><td>Primary alternate</td><td class="mono">${escapeHtml(dispatch.alternateStation || 'not selected')}</td><td class="mono">${escapeHtml(alternateWindow)}</td></tr>
</tbody></table>
<p class="note">${escapeHtml(diversionNote)}</p>
${snapshot.schedule.needsConfirmation ? `<div class="stamp"><strong>Schedule confirmation required</strong><p>The ETA windows above are provisional.<br>${snapshot.schedule.adjustments.map(adjustment => escapeHtml(adjustment.note)).join('<br>')}</p></div>` : ''}

<h2>2. Minima</h2>
${minimaApproval}
${minimaTable('Destination landing minima', snapshot.minima.destination, 'Approved AIP chart value, applied to the destination at ETA +/- 1 hour (OM Part A 8.1.2.2.3).')}
${minimaTable('Primary alternate landing minima', snapshot.minima.alternateLanding, 'Approved AIP chart value. Required by the destination-alternate TEMPO concession (OM Part A 8.1.6 b.iii), and used to check the alternate is above its landing minima.')}
${minimaTable('Primary alternate planning minima', snapshot.minima.alternatePlanning, minimaBasis[snapshot.minima.alternatePlanningBasis])}

<h2>3. Weather and change groups</h2>
<table><thead><tr><th>Role</th><th>Station</th><th>Status</th><th>Coverage</th><th>Raw TAF</th></tr></thead><tbody>${tafRows || '<tr><td colspan="5">No TAF data</td></tr>'}</tbody></table>
<p class="note">Monitoring freshness: ${escapeHtml(snapshot.weather?.weatherMonitoring?.freshness ?? 'not stated')} * Warnings: ${escapeHtml(snapshot.weather?.weatherMonitoring?.warningCount ?? 'n/a')} * Affecting route: ${escapeHtml(dispatch.findings.some(item => item.code === 'WX_ROUTE_IMPACT') ? 'yes' : 'no')}</p>
<h3>Destination conditional groups (OM Part A Table 8.1-20, continued, page 8.1-47)</h3>
<table><thead><tr><th>Group</th><th>Nature</th><th>Application</th><th>Phenomena</th></tr></thead><tbody>${conditionalRows}</tbody></table>

<h2>4. Fuel</h2>
<table><tbody>
<tr><th>Additional holding required</th><td class="mono">${escapeHtml(dispatch.fuel.mandatoryHoldingMinutes)} min (${escapeHtml(dispatch.fuel.basis)})</td></tr>
<tr><th>Rationale</th><td>${escapeHtml(dispatch.fuel.rationale)}</td></tr>
<tr><th>References</th><td>${escapeHtml(dispatch.fuel.references.join(' * ') || 'none cited')}</td></tr>
<tr><th>Standard fuel padding</th><td class="mono">${escapeHtml(dispatch.fuel.advisoryPaddingMinutes)} min</td></tr>
<tr><th>Padding rationale</th><td>${escapeHtml(dispatch.fuel.advisoryRationale ?? 'No standard padding criterion was matched.')}</td></tr>
</tbody></table>
<h3>Fuel padding criteria matched</h3>
${fuelCriteria}

<h2>5. NOTAM</h2>
${snapshot.notams.reviewed
		? `<table><thead><tr><th>NOTAM</th><th>Aerodrome</th><th>Validity (UTC)</th><th>Text</th></tr></thead><tbody>${notamRows}</tbody></table>
<p class="note">Selected manually by the dispatcher from the AWQ Cloud NOTAM feed. Selected NOTAM are not a statement that the aerodrome is free of NOTAM beyond those listed.</p>`
		: '<div class="stamp"><strong>NOTAM REVIEW PENDING</strong><p>No NOTAM was reviewed for this assessment. This is not a statement that NOTAM is clear.</p></div>'}
${snapshot.notams.missingIds.length ? `<p class="note">NOTAM that could not be attached: ${escapeHtml(snapshot.notams.missingIds.join(', '))}</p>` : ''}

<h2>6. Findings</h2>
${findingBlocks}

<h2>7. Written assessment</h2>
${narrative}

<h2>8. Citations</h2>
<ol class="citations">${citationList || '<li>No clause reference was required.</li>'}</ol>

<h2>9. Data quality notes</h2>
${dataQuality}

<h2>10. Reference manuals indexed</h2>
<ul class="tight">${documentRows || '<li>No reference manuals indexed.</li>'}</ul>

<p class="disclaimer"><strong>Advisory only.</strong> The assessment outcome, the ETA windows and the fuel figures were produced by a deterministic evaluation of the AWQ Cloud payload against the cited clauses of Operations Manual Part A (Doc. No. IAA/FOP/M/001) and the Flight Dispatch Manual (Doc. No. IAA/FOP/M/008) and the AIP chart minima in the minima registry. The written assessment merely explains them and cannot change them. <strong>This is an assessment outcome and not a dispatch release</strong>, not a compliance certification, and not an airworthiness determination. The flight operations officer retains release authority and must verify every finding against the source documents before dispatch.</p>
<h2>Integrity</h2>
<p class="meta">Snapshot contract v${escapeHtml(snapshot.contractVersion)} * context hash <span class="mono">${escapeHtml(assessment.context_hash)}</span>${assessment.review_note ? `<br>Review note: ${escapeHtml(assessment.review_note)}` : ''}${assessment.reviewed_at ? `<br>Reviewed: ${escapeHtml(assessment.reviewed_at)} UTC` : ''}</p>
</body></html>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}

/**
 * Render a contract-3 assessment, which predates the minima registry.
 *
 * Retained because a stored assessment is an immutable record: a contract-3 row
 * created before this release must stay readable rather than becoming an
 * unrenderable artifact.
 */
function renderContract3Report(assessment: StoredAssessment, snapshot: Record<string, unknown>): Response {
	const dispatch = (snapshot.dispatch ?? {}) as {
		verdict?: string;
		windows?: DispatchSnapshotWindows;
		fuel?: FuelRequirement;
		findings?: DispatchFinding[];
		notamEvaluated?: boolean;
		destinationStation?: string | null;
		alternateStation?: string | null;
		dataQualityNotes?: string[];
	};
	const minima = (snapshot.minima ?? {}) as { destination?: ApproachMinima | null; alternate?: ApproachMinima | null };
	const flight = (snapshot.flight ?? {}) as AssessmentFlight;
	const schedule = (snapshot.schedule ?? {}) as { needsConfirmation?: boolean; adjustments?: ScheduleAdjustment[] };
	const outcome = dispatch.verdict ?? 'MARGINAL';
	const minimaLine = (value: ApproachMinima | null | undefined): string =>
		value
			? `${escapeHtml(value.approach)}  --  ceiling ${escapeHtml(value.ceilingFt ?? 'n/a')} ft, visibility ${escapeHtml(value.visibilityM ?? 'n/a')} m`
			: 'not supplied';
	const findings = Array.isArray(dispatch.findings) ? dispatch.findings : [];
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dispatch Assessment ${escapeHtml(assessment.id)}</title><style>${REPORT_STYLE}</style></head><body>
<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
<header class="doc"><div class="brandline"><div><div class="brand">AWQ Cloud * Dispatch Assist</div><h1>Operational Dispatch Assessment</h1><p class="meta">Assessment #${escapeHtml(assessment.id)} * Flight ${escapeHtml(flight.callsign || flight.flightNumber || flight.id)} * Created ${escapeHtml(assessment.created_at)} UTC * Contract v3 (superseded schema)</p></div><div><span class="badge badge--${escapeHtml(verdictSlug(outcome))}">Assessment outcome: ${escapeHtml(outcome)}</span><span class="badge">Decision: ${escapeHtml(assessment.decision)}</span></div></div></header>
<div class="stamp"><strong>Superseded contract version</strong><p>This assessment was created before the minima registry existed, so its minima values were entered manually and are not traceable to an approved AIP record. Read it for history only.</p></div>
<h2>Flight context</h2>
<p><strong>Route:</strong> <span class="mono">${escapeHtml(flight.origin)} -> ${escapeHtml(flight.destination)}</span><br><strong>Registration:</strong> <span class="mono">${escapeHtml(flight.aircraft?.registration ?? 'not stated')}</span></p>
<h2>1. ETA windows</h2>
<p>Destination ${escapeHtml(dispatch.destinationStation || 'unknown')}: <span class="mono">${escapeHtml(dispatch.windows ? `${zuluLabel(dispatch.windows.destination.from)} - ${zuluLabel(dispatch.windows.destination.to)}` : 'not available')}</span><br>Primary alternate ${escapeHtml(dispatch.alternateStation || 'not selected')}: <span class="mono">${escapeHtml(dispatch.windows ? `${zuluLabel(dispatch.windows.primaryAlternate.from)} - ${zuluLabel(dispatch.windows.primaryAlternate.to)}` : 'not available')}</span></p>
${schedule.needsConfirmation ? `<p class="note"><strong>Schedule confirmation was required.</strong> ${(schedule.adjustments ?? []).map(adjustment => escapeHtml(adjustment.note)).join('<br>')}</p>` : ''}
<h2>2. Minima</h2>
<p>Destination landing minima: ${minimaLine(minima.destination)}<br>Alternate planning minima: ${minimaLine(minima.alternate)}</p>
<h2>3. Fuel</h2>
<p>Additional holding: <span class="mono">${escapeHtml(dispatch.fuel?.mandatoryHoldingMinutes ?? 0)} min</span> (${escapeHtml(dispatch.fuel?.basis ?? 'unstated')})<br><span class="note">${escapeHtml(dispatch.fuel?.rationale ?? '')}</span></p>
<h2>4. NOTAM</h2>
<p>${escapeHtml(dispatch.notamEvaluated ? 'Remarks were supplied.' : 'NOTAM REVIEW PENDING  --  no NOTAM was reviewed for this assessment.')}</p>
<h2>5. Findings</h2>
${findings.length ? findings.map(item => `<div class="finding finding--${escapeHtml(item.severity.toLowerCase())}"><div class="head"><span class="severity">${escapeHtml(item.severity)}</span><span class="code">${escapeHtml(item.code)}</span></div><div>${escapeHtml(item.message)}</div><div class="evidence">Evidence: ${escapeHtml(item.evidence)}</div><div class="evidence">References: ${escapeHtml(item.references.join(' * ') || 'none cited')}</div></div>`).join('') : '<p>No findings recorded.</p>'}
<h2>6. Data quality notes</h2>
${(dispatch.dataQualityNotes ?? []).length ? `<ul class="tight">${(dispatch.dataQualityNotes ?? []).map(note => `<li class="note">${escapeHtml(note)}</li>`).join('')}</ul>` : '<p class="note">None recorded.</p>'}
<p class="disclaimer"><strong>Advisory only.</strong> This is a historical assessment record under a superseded schema. It is not a dispatch release and does not authorise flight.</p>
<h2>Integrity</h2>
<p class="meta">Context hash <span class="mono">${escapeHtml(assessment.context_hash)}</span></p>
</body></html>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}

/**
 * The stored assessment row, as every report renderer receives it.
 *
 * Declared before the renderers so the shared helpers below can be used by each
 * of them.
 */
type StoredAssessment = {
	id: number;
	flight_id: number;
	status: string;
	decision: string;
	contract_version: string;
	snapshot_json: string;
	context_hash: string;
	created_at: string;
	reviewed_at: string | null;
	review_note: string | null;
};

/**
 * Render the findings section from structured findings, falling back to the flat
 * message list for assessments created before structured findings existed (an
 * older row has no `structuredFindings`, and reading it as if it did is what made
 * this route fail).
 */
function renderFindings(snapshot: AssessmentSnapshot): string {
	const structured = Array.isArray(snapshot.structuredFindings) ? snapshot.structuredFindings : [];
	if (structured.length) {
		return structured
			.map(
				finding =>
					`<div class="finding finding--${escapeHtml(finding.severity.toLowerCase())}"><span class="severity">${escapeHtml(finding.severity)}</span>${escapeHtml(finding.message)}<div class="evidence">Evidence: ${escapeHtml(finding.evidence)}</div></div>`
			)
			.join('');
	}
	const legacy = Array.isArray(snapshot.findings) ? snapshot.findings : [];
	if (!legacy.length) return '<p>No readiness findings recorded.</p>';
	return `<ul>${legacy.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
}

/** `NO-GO` becomes `nogo`, so an outcome maps onto a CSS class safely. */
function verdictSlug(verdict: string): string {
	return verdict.toLowerCase().replace(/[^a-z]/g, '');
}

/** `DDHHMMZ`. The day is included because a diversion window crosses midnight. */
function zuluLabel(iso: string | undefined): string {
	if (!iso) return 'not available';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z`;
}


async function assessmentReport(request: Request, env: Env, assessmentId: number): Promise<Response> {
	const loaded = await getAssessment(request, env, assessmentId);
	if (loaded.response) return loaded.response;
	const assessment = loaded.assessment!;
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(assessment.snapshot_json);
	} catch {
		return new Response('This assessment snapshot is unreadable and cannot be rendered.', { status: 422 });
	}
	if (!snapshot || typeof snapshot !== 'object' || !(snapshot as { flight?: unknown }).flight) {
		return new Response('This assessment snapshot is incomplete and cannot be rendered.', { status: 422 });
	}

	// An assessment is an immutable record, so an earlier contract version must stay
	// renderable rather than being rewritten by a later one. Contract 4 is the
	// current shape; contract 3 is rendered by its own historical renderer.
	const candidate = snapshot as { contractVersion?: string; dispatch?: unknown };
	if (candidate.contractVersion === '4' && candidate.dispatch) {
		return renderDispatchReport(assessment, snapshot as DispatchSnapshot);
	}
	if (candidate.contractVersion === '3' && candidate.dispatch) {
		return renderContract3Report(assessment, snapshot as Record<string, unknown>);
	}
	return renderLegacyReport(assessment, snapshot as AssessmentSnapshot);
}

/** Render a contract-2 assessment, which carries weather findings only. */
function renderLegacyReport(assessment: StoredAssessment, snapshot: AssessmentSnapshot): Response {

	const taf = Array.isArray(snapshot.weather?.taf) ? snapshot.weather.taf : [];
	const tafRows = taf
		.map(
			item =>
				`<tr><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.station)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.coverage)}</td><td>${escapeHtml(item.raw)}</td></tr>`
		)
		.join('');
	const references = Array.isArray(snapshot.referenceDocuments) ? snapshot.referenceDocuments : [];
	const documentRows = references
		.map(
			item =>
				`<li>${escapeHtml(item.file_name)} * ${escapeHtml(item.category)} * ${escapeHtml(item.chunk_count)} indexed excerpts</li>`
		)
		.join('');
	const structured = Array.isArray(snapshot.structuredFindings) ? snapshot.structuredFindings : [];
	const worst = structured.length ? highestSeverity(structured) : null;
	const classification = worst ? `${assessment.status} * worst finding ${worst}` : assessment.status;

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dispatch Assessment ${escapeHtml(assessment.id)}</title><style>${REPORT_STYLE}</style></head><body>
<button onclick="window.print()">Print / Save as PDF</button>
<h1>Operational Dispatch Assessment</h1>
<p class="meta">Assessment #${escapeHtml(assessment.id)} * Flight ${escapeHtml(snapshot.flight.callsign || snapshot.flight.flightNumber || snapshot.flight.id)} * Created ${escapeHtml(assessment.created_at)} UTC</p>
<p><span class="badge">${escapeHtml(classification)}</span><span class="badge">Decision: ${escapeHtml(assessment.decision)}</span><span class="badge">Contract v${escapeHtml(assessment.contract_version)}</span></p>
<h2>Flight context</h2>
<p><strong>Route:</strong> ${escapeHtml(snapshot.flight.origin)} to ${escapeHtml(snapshot.flight.destination)}<br><strong>Registration:</strong> ${escapeHtml(snapshot.flight.aircraft?.registration)}<br><strong>Destination alternates:</strong> ${escapeHtml((snapshot.flight.destinationAlternates || []).join(', ') || 'None')}<br><strong>Enroute alternates:</strong> ${escapeHtml((snapshot.flight.enrouteAlternates || []).join(', ') || 'None')}</p>
<h2>Readiness findings</h2>
${renderFindings(snapshot)}
<h2>TAF and Weather Monitoring</h2>
<p><strong>Freshness:</strong> ${escapeHtml(snapshot.weather?.weatherMonitoring?.freshness)} * <strong>Warnings:</strong> ${escapeHtml(snapshot.weather?.weatherMonitoring?.warningCount)}</p>
<table><thead><tr><th>Role</th><th>Station</th><th>Status</th><th>Coverage</th><th>Raw TAF</th></tr></thead><tbody>${tafRows || '<tr><td colspan="5">No TAF data</td></tr>'}</tbody></table>
<h2>Reference manuals applied</h2>
<ul>${documentRows || '<li>No reference manuals indexed.</li>'}</ul>
<p class="disclaimer"><strong>Advisory only.</strong> This assessment was produced by a deterministic evaluation of AWQ Cloud weather data and the indexed reference corpus. It is not an airworthiness determination and does not authorise flight. The flight operations officer retains release authority and must verify every finding against the source documents before dispatch.</p>
<h2>Integrity</h2>
<p class="meta">Context hash: ${escapeHtml(assessment.context_hash)}${assessment.review_note ? `<br>Review note: ${escapeHtml(assessment.review_note)}` : ''}${assessment.reviewed_at ? `<br>Reviewed: ${escapeHtml(assessment.reviewed_at)} UTC` : ''}</p>
</body></html>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}

async function listDocuments(request: Request, env: Env, url: URL): Promise<Response> {
	const flightId = Number(url.searchParams.get('flight_id'));
	if (!Number.isInteger(flightId) || flightId <= 0) return documentResponse({ error: 'A valid flight_id is required.' }, 400);
	if (!await authorizeFlight(request, env, flightId)) return documentResponse({ error: 'SSO is required for this flight.' }, 401);
	const { results } = await env.DB.prepare(
		`SELECT id, flight_id, category, file_name, size_bytes, content_type, created_at
		   FROM dispatch_documents WHERE flight_id = ? ORDER BY created_at DESC, id DESC`
	).bind(flightId).all();
	return documentResponse({ ok: true, data: { documents: results || [] } });
}

async function uploadDocument(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const form = await request.formData();
	const flightId = Number(form.get('flight_id'));
	const category = String(form.get('category') || '');
	const file = form.get('file');
	if (!Number.isInteger(flightId) || flightId <= 0) return documentResponse({ error: 'A valid flight_id is required.' }, 400);
	if (!DOCUMENT_CATEGORIES.has(category)) return documentResponse({ error: 'Invalid document category.' }, 400);
	if (!(file instanceof File)) return documentResponse({ error: 'A PDF file is required.' }, 400);
	if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return documentResponse({ error: 'PDF files must be smaller than 50 MB.' }, 413);
	if (!(await isPdf(file))) return documentResponse({ error: 'Only PDF files are supported.' }, 415);
	const userId = await authorizeFlight(request, env, flightId);
	if (!userId) return documentResponse({ error: 'SSO is required for this flight.' }, 401);

	// Pass the File itself rather than file.stream(): R2 requires a known length
	// for stream bodies and rejects an unknown-length stream, which is what
	// `file.stream()` produces.
	const objectKey = `flights/${flightId}/${crypto.randomUUID()}.pdf`;
	await env.DOCUMENTS.put(objectKey, file, {
		httpMetadata: { contentType: 'application/pdf' },
		customMetadata: { originalFileName: safeFileName(file.name), category, flightId: String(flightId) }
	});
	try {
		const result = await env.DB.prepare(
			`INSERT INTO dispatch_documents (flight_id, user_id, category, file_name, object_key, size_bytes, content_type)
			 VALUES (?, ?, ?, ?, ?, ?, 'application/pdf')`
		).bind(flightId, userId, category, safeFileName(file.name), objectKey, file.size).run();
		await audit(env, userId, 'document_upload', 'dispatch_document', Number(result.meta.last_row_id), category, ctx);
		return documentResponse({ ok: true, data: { id: result.meta.last_row_id } }, 201);
	} catch (error) {
		await env.DOCUMENTS.delete(objectKey);
		throw error;
	}
}

async function downloadDocument(request: Request, env: Env, documentId: number, ctx: ExecutionContext): Promise<Response> {
	const document = await env.DB.prepare(
		`SELECT id, flight_id, file_name, object_key, content_type
		   FROM dispatch_documents WHERE id = ? LIMIT 1`
	).bind(documentId).first<{ id: number; flight_id: number; file_name: string; object_key: string; content_type: string }>();
	if (!document) return new Response('Document not found.', { status: 404 });
	// Authorise once and reuse the identity; the previous code ran the full
	// two-query authorisation twice per download.
	const userId = await authorizeFlight(request, env, Number(document.flight_id));
	if (!userId) return new Response('SSO is required for this flight.', { status: 401 });
	const object = await env.DOCUMENTS.get(document.object_key);
	if (!object) return new Response('Document not found.', { status: 404 });
	await audit(env, userId, 'document_download', 'dispatch_document', Number(document.id), '', ctx);
	const headers = new Headers({
		'Content-Type': document.content_type,
		'Content-Length': String(object.size),
		'Content-Disposition': `inline; filename="${safeFileName(document.file_name)}"`,
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	return new Response(object.body, { headers });
}

async function listReferenceDocuments(request: Request, env: Env): Promise<Response> {
	if (!await authorizeUser(request, env)) return documentResponse({ error: 'SSO is required.' }, 401);
	const { results } = await env.DB.prepare(
		`SELECT id, category, file_name, size_bytes, content_type, created_at,
		        ingest_status, ingest_note, chunk_count, ingested_at
		   FROM reference_documents ORDER BY created_at DESC, id DESC`
	).all<{ id: number; category: string; file_name: string }>();
	// A document that is indexed but outside the agreed rule sources is not part of
	// the reference library the product may cite (PRD §5, acceptance §15). It stays in
	// the table so the ingestion history is intact, but it is not offered as a manual.
	const documents = (results || []).filter(document => !isExcludedFromCorpus(document.file_name));
	return documentResponse({ ok: true, data: { documents } });
}

async function uploadReferenceDocument(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);
	const form = await request.formData();
	const category = String(form.get('category') || '');
	const file = form.get('file');
	if (!REFERENCE_CATEGORIES.has(category)) return documentResponse({ error: 'Invalid reference document category.' }, 400);
	if (!(file instanceof File)) return documentResponse({ error: 'A PDF file is required.' }, 400);
	if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return documentResponse({ error: 'PDF files must be smaller than 50 MB.' }, 413);
	if (!(await isPdf(file))) return documentResponse({ error: 'Only PDF files are supported.' }, 415);

	// A newly uploaded manual is not searchable until it has been ingested, so the
	// document is recorded as pending rather than implying it is already indexed.
	const objectKey = `reference/${crypto.randomUUID()}.pdf`;
	await env.DOCUMENTS.put(objectKey, file, {
		httpMetadata: { contentType: 'application/pdf' },
		customMetadata: { originalFileName: safeFileName(file.name), category }
	});
	try {
		const result = await env.DB.prepare(
			`INSERT INTO reference_documents (user_id, category, file_name, object_key, size_bytes, content_type, ingest_status)
			 VALUES (?, ?, ?, ?, ?, 'application/pdf', 'pending')`
		).bind(userId, category, safeFileName(file.name), objectKey, file.size).run();
		await audit(env, userId, 'document_upload', 'reference_document', Number(result.meta.last_row_id), category, ctx);
		return documentResponse({ ok: true, data: { id: result.meta.last_row_id, ingestStatus: 'pending' } }, 201);
	} catch (error) {
		await env.DOCUMENTS.delete(objectKey);
		throw error;
	}
}

async function downloadReferenceDocument(request: Request, env: Env, documentId: number, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return new Response('SSO is required.', { status: 401 });
	const document = await env.DB.prepare(
		`SELECT file_name, object_key, content_type
		   FROM reference_documents WHERE id = ? LIMIT 1`
	).bind(documentId).first<{ file_name: string; object_key: string; content_type: string }>();
	if (!document) return new Response('Document not found.', { status: 404 });
	const object = await env.DOCUMENTS.get(document.object_key);
	if (!object) return new Response('Document not found.', { status: 404 });
	await audit(env, userId, 'document_download', 'reference_document', documentId, '', ctx);
	const headers = new Headers({
		'Content-Type': document.content_type,
		'Content-Length': String(object.size),
		'Content-Disposition': `inline; filename="${safeFileName(document.file_name)}"`,
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	return new Response(object.body, { headers });
}

async function deleteDocument(request: Request, env: Env, documentId: number, ctx: ExecutionContext): Promise<Response> {
	const document = await env.DB.prepare('SELECT id, flight_id, object_key FROM dispatch_documents WHERE id = ? LIMIT 1').bind(documentId).first<{ id: number; flight_id: number; object_key: string }>();
	if (!document) return documentResponse({ error: 'Document not found.' }, 404);
	const userId = await authorizeFlight(request, env, Number(document.flight_id));
	if (!userId) return documentResponse({ error: 'SSO is required for this flight.' }, 401);
	await env.DOCUMENTS.delete(document.object_key);
	await env.DB.prepare('DELETE FROM dispatch_documents WHERE id = ?').bind(documentId).run();
	await audit(env, userId, 'document_delete', 'dispatch_document', documentId, '', ctx);
	return documentResponse({ ok: true });
}

async function deleteReferenceDocument(request: Request, env: Env, documentId: number, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);
	const document = await env.DB.prepare('SELECT id, object_key FROM reference_documents WHERE id = ? LIMIT 1').bind(documentId).first<{ id: number; object_key: string }>();
	if (!document) return documentResponse({ error: 'Document not found.' }, 404);
	await env.DOCUMENTS.delete(document.object_key);
	// Chunks cascade with the document row (ON DELETE CASCADE), so the citation
	// index cannot outlive the manual it points at.
	await env.DB.prepare('DELETE FROM reference_documents WHERE id = ?').bind(documentId).run();
	await audit(env, userId, 'document_delete', 'reference_document', documentId, '', ctx);
	return documentResponse({ ok: true });
}

async function proxyAssistant(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const token = cookieValue(request);
	if (!token) return flightBoardUnavailable();
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ ok: false, code: 'SSO_REQUIRED', error: 'A valid Dispatch Assist session is required.' }, 401);
	let payload: { question?: string; flightId?: number };
	try { payload = await request.json() as { question?: string; flightId?: number }; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }
	const question = String(payload.question || '').trim().slice(0, 500);
	if (question.length < 3) return documentResponse({ error: 'Enter an operational question.' }, 400);

	/**
	 * Plan the query before searching it.
	 *
	 * The planner sees the operator's question and nothing else, so no corpus text
	 * reaches a model provider. It is skipped when the question is an exact clause
	 * lookup, where the deterministic `clause_id` match is already the strongest
	 * signal, and it can be switched off entirely with the `QUERY_PLAN_DISABLED`
	 * variable. Any failure  --  no key, timeout, malformed body  --  is a no-op that
	 * leaves retrieval behaving exactly as it did before the planner existed.
	 */
	const mode = planningMode(question, (env as unknown as { QUERY_PLAN_DISABLED?: string }).QUERY_PLAN_DISABLED);
	const planned = mode === 'plan' ? await planQuery({ apiKey: deepSeekKey(env), timeoutMs: ASSISTANT_PLAN_TIMEOUT_MS }, question) : null;
	const planTerms = planned?.ok ? planned.terms : [];

const retrieval = await retrieve(env, CHUNK_INGEST_VERSION, question, 8, planTerms);
	const rows = retrieval.results;
	const flightId = Number(payload.flightId || 0);
	const answer = rows.length
		? `Retrieved ${rows.length} relevant corpus excerpt${rows.length === 1 ? '' : 's'}. Review the cited clauses before making an operational decision.`
		: 'No indexed manual excerpt matched the question. Verify the source manual directly before making an operational decision.';	// The method is recorded so a lexical-only answer, which happens when the query
	// embedding fails, is distinguishable from a full hybrid answer in the audit log.
	// The planning mode and the terms actually searched are recorded alongside it, so
	// a result set can be explained after the fact without replaying the model call,
	// and so a planned run can be compared against an unplanned one.
	const planNote = planned ? (planned.ok ? `plan=model(${planned.terms.length})` : `plan=${planned.reason}`) : `plan=${mode}`;
	await audit(
		env,
		userId,
		'assistant_query',
		'flight',
		flightId || null,
		`${retrieval.method}; lexical=${retrieval.candidates.lexical} vector=${retrieval.candidates.vector}; ${planNote}; terms=${retrieval.terms.join(',')}`.slice(0, 1000),
		ctx
	);
	return documentResponse({
		ok: true,
		data: {
			answer,
			source: 'hybrid-index',
			method: retrieval.method,
			flightId: flightId || null,
			candidates: retrieval.candidates,
			// Reported so an operator can see why a search widened: a degraded plan is
			// the difference between "the manual does not say" and "the search missed".
			plan: {
				source: planned ? (planned.ok ? 'model' : 'degraded') : 'skipped',
				terms: retrieval.terms
			},
			citations: rows.map(row => ({
				// Stable identifier of the exact excerpt, so a citation can be traced
				// back to a single stored chunk rather than to a whole manual.
				chunkId: row.chunkId,
				document: row.fileName,
				category: row.category,
				// The clause identity is what makes a citation checkable against the
				// source manual, so it is returned rather than just free text.
				clause: row.clauseId,
				clauseScheme: row.clauseScheme,
				sectionTitle: row.sectionTitle,
				excerpt: row.excerpt,
				// Provenance lets a reader see whether a clause was found by exact
				// tokens, by meaning, or by both.
				foundBy: row.foundBy,
				vectorScore: row.vectorScore
			}))
		}
	});
}

/**
 * Embed corpus chunks and store their vectors, in resumable slices.
 *
 * Admin-only. Progress lives in D1 (`embedding_status`), so the endpoint can be
 * called repeatedly until `remaining` reaches zero without redoing work.
 */
async function indexReferenceCorpus(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);

	const requested = Number(url.searchParams.get('limit') || 200);
	const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.trunc(requested))) : 200;

	const before = await indexStatus(env, CHUNK_INGEST_VERSION);
	if (before.total === 0) {
		return documentResponse({ ok: false, error: 'No corpus chunks exist at the active ingest version. Run the corpus ingestion first.' }, 409);
	}

	const slice = await indexChunkSlice(env, CHUNK_INGEST_VERSION, limit);
	// Per-document counts are refreshed only when the job finishes, to avoid an
	// aggregate write on every slice.
	if (slice.remaining === 0) await refreshDocumentEmbeddingCounts(env, CHUNK_INGEST_VERSION);
	const after = await indexStatus(env, CHUNK_INGEST_VERSION);

	await audit(
		env,
		userId,
		'reference_index',
		'reference_corpus',
		null,
		`embedded=${slice.embedded} upserted=${slice.upserted} remaining=${after.pending}`,
		ctx
	);

	return documentResponse({
		ok: true,
		data: {
			model: after.model,
			version: after.version,
			embeddedThisSlice: slice.embedded,
			upsertedThisSlice: slice.upserted,
			progress: after,
			complete: after.complete
		}
	});
}

/**
 * Re-segment the reference corpus into clause-aligned, citable chunks.
 *
 * Admin-only. The previous generation is preserved, so this is safe to re-run and
 * the active generation is switched by changing `CHUNK_INGEST_VERSION` rather than
 * by this call.
 */
async function ingestReferenceCorpus(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);

	const { results } = await env.DB.prepare(
		`SELECT id, category, file_name, ingest_status
		   FROM reference_documents ORDER BY id ASC`
	).all<IngestDocument>();
	const documents = results || [];
	if (!documents.length) return documentResponse({ ok: true, data: { documents: [], note: 'No reference documents are registered.' } });

	const outcomes: Array<Record<string, unknown>> = [];
	for (const document of documents) {
		try {
			const result = await ingestDocument(env, document, CHUNK_INGEST_VERSION - 1, CHUNK_INGEST_VERSION);
			outcomes.push({ ...result, ok: true });
			await audit(env, userId, 'reference_ingest', 'reference_document', document.id, `version ${CHUNK_INGEST_VERSION}`, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Ingestion failed.';
			outcomes.push({ documentId: document.id, fileName: document.file_name, ok: false, error: message });
			await audit(env, userId, 'reference_ingest_failed', 'reference_document', document.id, message.slice(0, 200), ctx);
		}
	}

	const warnings: string[] = [];
	for (const outcome of outcomes) {
		const dropped = Number(outcome.clausesDropped ?? 0);
		if (outcome.ok && dropped > 0) {
			warnings.push(
				`Document ${outcome.documentId} has ${dropped} fewer citable clauses at version ${CHUNK_INGEST_VERSION} than at version ${CHUNK_INGEST_VERSION - 1}. Review before switching the active version.`
			);
		}
	}

	return documentResponse({
		ok: outcomes.every(outcome => outcome.ok === true),
		data: {
			activeVersion: CHUNK_INGEST_VERSION - 1,
			writtenVersion: CHUNK_INGEST_VERSION,
			documents: outcomes,
			warnings
		}
	});
}

/**
 * Build a proxy response from a selected set of upstream headers.
 *
 * Forwarding the upstream header set wholesale would copy `Set-Cookie`,
 * `Content-Encoding`, and `Content-Length` onto this origin: a cookie set by the
 * AWQ Cloud deployment would land on the Dispatch Assist origin, and a
 * `Content-Length` describing an encoded body does not describe the body the
 * runtime hands to the client. Only the content type is propagated.
 */
function proxyResponse(response: Response, contentType: string | null): Response {
	const headers = new Headers({
		'Content-Type': contentType || 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	if (response.status === 401) headers.append('Set-Cookie', cookieHeader('', 0));
	return new Response(response.body, { status: response.status, headers });
}

async function proxyFlightBoard(request: Request, env: Env): Promise<Response> {
	const token = cookieValue(request);
	if (!token) return flightBoardUnavailable();
	const response = await fetch(`${env.AWQ_CLOUD_API_ORIGIN}/api/assist?mode=flight-board`, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
	});
	return proxyResponse(response, response.headers.get('Content-Type'));
}

async function proxyFlightWeather(request: Request, env: Env, url: URL): Promise<Response> {
	const token = cookieValue(request);
	if (!token) return flightBoardUnavailable();
	const flightId = url.searchParams.get('flight_id') || '';
	const target = new URL(`${env.AWQ_CLOUD_API_ORIGIN}/api/assist`);
	target.searchParams.set('mode', 'flight-weather');
	target.searchParams.set('flight_id', flightId);
	const response = await fetch(target, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
	});
	return proxyResponse(response, response.headers.get('Content-Type'));
}

/**
 * List minima records for an aerodrome.
 *
 * Admin-only, like every other minima route: the registry is the authoritative
 * record of the numbers an assessment applies, so reading it is part of the same
 * privilege as approving it (PRD acceptance §28).
 */
async function listMinimaRecords(request: Request, env: Env, url: URL): Promise<Response> {
	if (!await authorizeUser(request, env)) return documentResponse({ error: 'SSO is required.' }, 401);
	const icao = String(url.searchParams.get('icao') ?? '').trim().toUpperCase();
	if (!icao) {
		const airports = await listMinimaAirports(env);
		return documentResponse({ ok: true, data: { airports } });
	}
	if (!/^[A-Z0-9]{4}$/.test(icao)) return documentResponse({ error: 'icao must be a four-character location indicator.' }, 400);
	const [all, active] = await Promise.all([listMinima(env, icao), listActiveMinima(env, icao)]);
	return documentResponse({
		ok: true,
		data: {
			icao,
			records: all,
			/** The subset an assessment may actually use. */
			activeIds: active.map(record => record.id)
		}
	});
}

/** One minima record with its full audit history. */
async function getMinimaRecord(request: Request, env: Env, id: number): Promise<Response> {
	if (!await authorizeUser(request, env)) return documentResponse({ error: 'SSO is required.' }, 401);
	const loaded = await getMinima(env, id);
	if (!loaded) return documentResponse({ error: 'Minima record not found.' }, 404);
	return documentResponse({ ok: true, data: loaded });
}

/**
 * Extract draft minima from AIP chart PDFs held in R2.
 *
 * The source files are never written to or moved: they are read, hashed, and
 * converted. Every row this produces is a `draft`, so the extraction can run
 * without any value reaching an assessment (PRD acceptance §29).
 */
async function extractMinimaDrafts(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);
	let body: { objectKeys?: unknown; icao?: unknown; model?: unknown };
	try { body = await request.json() as typeof body; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }

	const requestedKeys = Array.isArray(body.objectKeys) ? body.objectKeys.map(value => String(value).trim()).filter(Boolean) : [];
	// One chart per job. Each chart is a conversion plus a model call, so one message
	// per chart keeps a slow chart from holding up a batch and makes a retry mean
	// exactly one chart.
	const objectKeys = requestedKeys.slice(0, MAX_CHARTS_PER_REQUEST);
	if (!objectKeys.length) return documentResponse({ error: 'At least one R2 object key is required.' }, 400);
	if (requestedKeys.length > MAX_CHARTS_PER_REQUEST) {
		return documentResponse(
			{
				error: `Extraction accepts ${MAX_CHARTS_PER_REQUEST} chart per request so one slow conversion cannot fail the others. Request the remaining ${requestedKeys.length - MAX_CHARTS_PER_REQUEST} chart(s) separately.`
			},
			400
		);
	}
	for (const key of objectKeys) {
		// Only the airport chart prefix is readable here. A caller cannot point the
		// extractor at the reference manuals or at a flight document.
		if (!key.startsWith('airport/')) {
			return documentResponse({ error: 'Only objects under the airport/ prefix can be extracted as minima sources.' }, 400);
		}
	}

	// The default is a `vars` entry so the model can be changed without a code edit,
	// but it is validated like any other value: a variable is configuration, and a
	// misconfigured variable must not become an arbitrary outbound request.
	const configuredDefault = String((env as unknown as { EXTRACTION_MODEL?: string }).EXTRACTION_MODEL ?? '').trim();
	const fallbackModel = isExtractionModel(configuredDefault) ? configuredDefault : DEFAULT_EXTRACTION_MODEL;
	const requestedModel = body.model === undefined ? fallbackModel : body.model;
	if (!isExtractionModel(requestedModel)) {
		return documentResponse({ error: `Unsupported extraction model. Use one of: ${EXTRACTION_MODELS.join(', ')}.` }, 400);
	}
	const model = requestedModel;

	// Every chart becomes a job. The Queue consumer has a 15-minute wall-clock limit
	// where the request path had to fit inside a response budget, which is what lost
	// four charts out of seven to a timeout.
	const jobs: Array<Record<string, unknown>> = [];
	for (const objectKey of objectKeys) {
		const head = await env.DOCUMENTS.head(objectKey);
		if (!head) {
			jobs.push({ objectKey, ok: false, reason: 'object-not-found' });
			continue;
		}
		if (head.size > MAX_CHART_BYTES) {
			jobs.push({ objectKey, ok: false, reason: `chart-larger-than-${MAX_CHART_BYTES}-bytes` });
			continue;
		}
		const objectIcao = objectKey.split('/')[1]?.toUpperCase() ?? '';
		const icao = /^[A-Z0-9]{4}$/.test(objectIcao) ? objectIcao : '';
		const job = await createExtractionJob(env, { objectKey, icao, model, requestedBy: userId });
		const message: ExtractionJobMessage = { jobId: job.id, objectKey, icao, model };

		try {
			await env.MINIMA_EXTRACTION_QUEUE.send(message);
			jobs.push({ objectKey, ok: true, jobId: job.id, status: 'pending', model, sizeBytes: head.size });
			await audit(env, userId, 'minima_extract_enqueued', 'airport_minima', null, `${objectKey} job=${job.id} model=${model}`, ctx);
		} catch (error) {
			// A failed enqueue has to be visible rather than leaving a pending job that
			// nothing will ever run.
			const detail = error instanceof Error ? error.message : 'enqueue failed';
			await env.DB.prepare(`UPDATE airport_minima_extraction_jobs SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`)
				.bind(`enqueue-failed: ${detail}`.slice(0, 500), job.id)
				.run();
			jobs.push({ objectKey, ok: false, jobId: job.id, reason: `enqueue-failed: ${detail}` });
			await audit(env, userId, 'minima_extract_enqueue_failed', 'airport_minima', null, `${objectKey}: ${detail}`.slice(0, 500), ctx);
		}
	}

	return documentResponse(
		{
			ok: jobs.every((job: Record<string, unknown>) => job.ok === true),
			data: {
				model,
				objects: jobs,
				poll: '/api/minima/extraction-jobs',
				note: 'Each chart is extracted in the background and becomes a draft. Poll the job for its outcome. A draft becomes usable only after an ADMIN dispatcher compares it against the source PDF and approves it.'
			}
		},
		202
	);
}

/**
 * Extraction job status, for the registry view's poll.
 *
 * The job row is the only record of what happened, so this is a plain read: a
 * consumer that failed, timed out or is still running is reported as itself.
 */
async function listExtractionJobsApi(request: Request, env: Env, url: URL): Promise<Response> {
	if (!await authorizeUser(request, env)) return documentResponse({ error: 'SSO is required.' }, 401);
	const id = String(url.searchParams.get('id') ?? '').trim();
	if (id) {
		const job = await getExtractionJob(env, id);
		if (!job) return documentResponse({ error: 'Extraction job not found.' }, 404);
		return documentResponse({ ok: true, data: { job } });
	}
	const icao = String(url.searchParams.get('icao') ?? '').trim().toUpperCase();
	const jobs = await listExtractionJobs(env, /^[A-Z0-9]{4}$/.test(icao) ? icao : null, Number(url.searchParams.get('limit') ?? 30));
	return documentResponse({ ok: true, data: { jobs } });
}

/**
 * Approve or reject several minima records in one action.
 *
 * Why this exists
 *   A registry of 138 drafts is not reviewable one click at a time, and forcing that
 *   does not produce more care — it produces a reviewer who clicks without reading.
 *   So the selection is batched, and the controls that make the batch mean something
 *   are kept rather than dropped.
 *
 * What it deliberately does not do
 *   - It does not apply the approve-all convenience to silent records. A record with
 *     neither a ceiling nor a visibility is **skipped**, not approved, because
 *     approving it would create a record that reads as usable minima while checking
 *     nothing. That is the same rule the single-record path enforces, applied
 *     per record rather than relaxed for the batch.
 *   - It does not approve across aerodromes or charts implicitly. The caller names
 *     the ids.
 *   - It does not hide the count. The response reports approved, skipped and already
 *     approved separately, and `skipped` carries the reason per record so a batch that
 *     silently did less than the reviewer expected cannot happen.
 *
 * The audit trail is per record: each approval writes its own `airport_minima_audit`
 * entry and its own approver identity and timestamp, so a batch approval is
 * indistinguishable in the record from a single one. Bulk is a change to the review
 * *pace*, not to what is recorded.
 */
async function decideMinimaRecordsBulk(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);
	let body: { ids?: unknown; decision?: unknown; note?: unknown };
	try { body = await request.json() as typeof body; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }

	const ids = Array.isArray(body.ids)
		? [...new Set(body.ids.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0))]
		: [];
	if (!ids.length) return documentResponse({ error: 'At least one record id is required.' }, 400);
	// Bounded so one request cannot hold a Worker open across hundreds of writes; the
	// UI chunks its selection to match.
	if (ids.length > 200) return documentResponse({ error: 'A bulk decision is limited to 200 records at a time.' }, 400);

	const decision = String(body.decision ?? '').trim().toUpperCase();
	if (decision !== 'APPROVED' && decision !== 'REJECTED') {
		return documentResponse({ error: 'Decision must be APPROVED or REJECTED.' }, 400);
	}
	const note = String(body.note ?? '').trim().slice(0, 1000) || null;

	const approved: number[] = [];
	const rejected: number[] = [];
	const skipped: Array<{ id: number; reason: string }> = [];

	for (const id of ids) {
		if (decision === 'REJECTED') {
			const result = await rejectRecord(env, userId, id, note);
			if (result.ok) {
				rejected.push(id);
				await audit(env, userId, 'minima_reject', 'airport_minima', id, note ?? '', ctx);
			} else {
				skipped.push({ id, reason: result.error });
			}
			continue;
		}

		const result = await approveRecord(env, userId, id, note);
		if (result.ok) {
			approved.push(id);
			// Each record gets its own audit entry, so a batch approval is recorded exactly
			// as a single approval would be: approver identity, time, and the note.
			await audit(
				env,
				userId,
				'minima_approve',
				'airport_minima',
				id,
				`${result.record.icao} ${result.record.chartIdentifier} ${result.record.approach} ${result.record.kind} (bulk of ${ids.length})`,
				ctx
			);
		} else {
			const current = await getMinima(env, id);
			skipped.push({ id, reason: approvalBlockedReason(current ? current.record : null) ?? result.error });
		}
	}

	return documentResponse({
		ok: true,
		data: {
			requested: ids.length,
			approved,
			rejected,
			skipped,
			note:
				decision === 'APPROVED'
					? 'A skipped record is reported with its reason rather than approved. A record with no value cannot be approved, because there would be nothing for an assessment to compare against.'
					: 'Rejected records remain readable for audit and are not part of the active set.'
		}
	});
}

/**
 * Which records a bulk approval would actually accept.
 *
 * Exposed so the registry view can show the real count before the click and offer
 * "select every record that can be approved" without the client re-implementing the
 * rule. The predicate is the same `canApprove` the write path enforces, so the count
 * the reviewer sees is the count they get.
 */
async function listApprovableMinima(request: Request, env: Env, url: URL): Promise<Response> {
	if (!await authorizeUser(request, env)) return documentResponse({ error: 'SSO is required.' }, 401);
	const icao = String(url.searchParams.get('icao') ?? '').trim().toUpperCase();
	if (!/^[A-Z0-9]{4}$/.test(icao)) return documentResponse({ error: 'A four-character ICAO location indicator is required.' }, 400);

	const records = await listMinima(env, icao);
	const candidates = records.filter(record => record.status === 'draft' || record.status === 'rejected');
	const approvable = candidates.filter(record => canApprove(record).ok);
	return documentResponse({
		ok: true,
		data: {
			icao,
			draftCount: candidates.length,
			approvableIds: approvable.map(record => record.id),
			blockedCount: candidates.length - approvable.length,
			note: 'A record with neither a ceiling nor a visibility is not approvable and is excluded from this list.'
		}
	});
}

/** Apply an ADMIN correction to a minima draft or approved record. */
async function correctMinimaDraft(request: Request, env: Env, ctx: ExecutionContext, id: number): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);
	let body: Record<string, unknown>;
	try { body = await request.json() as Record<string, unknown>; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }

	const correction: DraftCorrection = { id };
	const assignNumber = (key: keyof DraftCorrection, value: unknown): void => {
		if (value === undefined) return;
		(correction as Record<string, unknown>)[key] = value === null ? null : finiteNumberOrNull(value);
	};
	const assignText = (key: keyof DraftCorrection, value: unknown): void => {
		if (value === undefined) return;
		// 500 characters is generous for a chart fragment or an AIP cycle label, and
		// bounded so a correction cannot store an essay in a field that is rendered
		// inline.
		const raw = value === null ? null : String(value).trim().slice(0, 500);
		(correction as Record<string, unknown>)[key] = raw ? raw : null;
	};
	assignNumber('ceilingFt', body.ceilingFt);
	assignNumber('visibilityM', body.visibilityM);
	assignText('approach', body.approach);
	assignText('approachType', body.approachType);
	assignText('runway', body.runway);
	assignText('aircraftCategory', body.aircraftCategory);
	assignText('chartPage', body.chartPage);
	assignText('aipCycle', body.aipCycle);
	assignText('effectiveFrom', body.effectiveFrom);
	assignText('effectiveTo', body.effectiveTo);
	assignText('valueType', body.valueType);
	assignText('sourceText', body.sourceText);
	assignText('notes', body.notes);

	const result = await updateDraft(env, userId, correction);
	if (!result.ok) return documentResponse({ error: result.error }, 400);
	await audit(env, userId, 'minima_correct', 'airport_minima', id, `status=${result.status}`, ctx);
	const loaded = await getMinima(env, id);
	return documentResponse({ ok: true, data: loaded });
}

/** Approve or reject a minima record. Approval is what makes a value usable. */
async function decideMinimaRecord(request: Request, env: Env, ctx: ExecutionContext, id: number): Promise<Response> {
	const userId = await authorizeUser(request, env);
	if (!userId) return documentResponse({ error: 'SSO is required.' }, 401);
	let body: { decision?: unknown; note?: unknown };
	try { body = await request.json() as typeof body; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }
	const decision = String(body.decision ?? '').trim().toUpperCase();
	const note = String(body.note ?? '').trim().slice(0, 1000) || null;
	if (decision !== 'APPROVED' && decision !== 'REJECTED') {
		return documentResponse({ error: 'Decision must be APPROVED or REJECTED.' }, 400);
	}

	if (decision === 'REJECTED') {
		const rejected = await rejectRecord(env, userId, id, note);
		if (!rejected.ok) return documentResponse({ error: rejected.error }, 400);
		await audit(env, userId, 'minima_reject', 'airport_minima', id, note ?? '', ctx);
	} else {
		const approved = await approveRecord(env, userId, id, note);
		if (!approved.ok) {
			// The reason is written for the reviewer, and the registry view computes the
			// same sentence before the click so the control can be disabled with it. An
			// error here means the record changed between render and click.
			const loaded = await getMinima(env, id);
			return documentResponse({ error: approvalBlockedReason(loaded ? loaded.record : null) ?? approved.error }, 400);
		}
		// The approval is recorded with the approver identity and the time, as PRD
		// acceptance §28 requires.
		await audit(
			env,
			userId,
			'minima_approve',
			'airport_minima',
			id,
			`${approved.record.icao} ${approved.record.chartIdentifier} ${approved.record.approach} ${approved.record.kind}`,
			ctx
		);
	}

	const loaded = await getMinima(env, id);
	return documentResponse({ ok: true, data: loaded });
}

/**
 * NOTAM candidates for the aerodromes of a flight.
 *
 * The window is derived from the flight's own ETA windows where the caller can
 * supply them, so what is offered is what could apply; the dispatcher still makes
 * the selection (PRD §9).
 */
async function listNotamsForFlight(request: Request, env: Env, url: URL): Promise<Response> {
	if (!await authorizeUser(request, env)) return documentResponse({ error: 'SSO is required.' }, 401);
	const icao = String(url.searchParams.get('icao') ?? '').trim().toUpperCase();
	const locations = icao
		.split(',')
		.map(value => value.trim().toUpperCase())
		.filter(value => /^[A-Z0-9]{4}$/.test(value))
		.slice(0, 6);
	if (!locations.length) return documentResponse({ error: 'At least one four-character ICAO location is required.' }, 400);

	const from = parseInstantInput(url.searchParams.get('from'));
	const to = parseInstantInput(url.searchParams.get('to'));
	const windowFrom = from ?? new Date(Date.now() - 86_400_000);
	const windowTo = to ?? new Date(Date.now() + 3 * 86_400_000);
	if (windowTo.getTime() < windowFrom.getTime()) {
		return documentResponse({ error: 'The validity window end must not precede its start.' }, 400);
	}

	const notams = await listNotamCandidates(env, locations, windowFrom, windowTo);
	return documentResponse({
		ok: true,
		data: {
			locations,
			window: { from: windowFrom.toISOString(), to: windowTo.toISOString() },
			fetchedAt: new Date().toISOString(),
			notams
		}
	});
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			// Without this, an uncaught exception leaves the browser with a non-JSON 500
			// and no reason  --  which is exactly how the status-constraint failure presented
			// itself: the UI could only say "Assessment creation failed." The detail goes
			// to the log (visible in `wrangler tail`); the client gets a stable JSON shape.
			console.error('[DISPATCH] unhandled request failure', error);
			return jsonResponse({ ok: false, code: 'INTERNAL', error: 'The request could not be completed.' }, 500);
		}
	},

	/**
	 * Minima extraction, off the request path.
	 *
	 * A chart costs a PDF conversion plus a model call and was measured at 81 to 130
	 * seconds. Here the wall-clock limit is 15 minutes rather than a response budget,
	 * which is the whole reason this exists: four of seven charts were previously lost
	 * to a timeout.
	 *
	 * `runExtractionJob` records every terminal outcome on the job row, so a failure
	 * is readable by the client rather than only visible in a log. A throw is reserved
	 * for the case where the job row itself could not be updated, because retrying is
	 * then the only way to get a truthful status.
	 */
	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			const payload = message.body as Partial<ExtractionJobMessage> | null;
			if (!payload || typeof payload.jobId !== 'string' || typeof payload.objectKey !== 'string') {
				// A message with no usable body cannot be recorded against a job, and
				// retrying it would fail identically, so it is acknowledged with a log.
				console.error('[DISPATCH] discarding malformed extraction message', JSON.stringify(message.body));
				message.ack();
				continue;
			}
			try {
				const outcome = await runExtractionJob(env, {
					jobId: payload.jobId,
					objectKey: payload.objectKey,
					icao: typeof payload.icao === 'string' ? payload.icao : '',
					model: typeof payload.model === 'string' ? payload.model : DEFAULT_EXTRACTION_MODEL
				});
				// A recorded failure is still a completed attempt: the job row says what
				// happened, so acknowledging avoids three identical retries of a chart
				// whose PDF or conversion is the problem.
				console.log(
					`[DISPATCH] extraction job ${payload.jobId} ${outcome.ok ? 'succeeded' : `failed: ${outcome.reason}`} drafts=${outcome.draftsStored}`
				);
				message.ack();
			} catch (error) {
				// The job row could not be updated, so its status is unknown. Retrying is
				// what makes it truthful; the attempt counter on the row records how many
				// times this happened.
				console.error(`[DISPATCH] extraction job ${payload.jobId} could not record its outcome`, error);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	{
		const url = new URL(request.url);
		if (url.pathname === '/auth/start') {
			const redirect = new URL('/api/assist', env.AWQ_CLOUD_BROWSER_ORIGIN);
			redirect.searchParams.set('mode', 'start');
			redirect.searchParams.set('return', new URL(request.url).origin);
			return redirectNoStore(redirect.toString());
		}
		if (url.pathname === '/auth/callback') {
			const code = url.searchParams.get('code') || '';
			if (!code) return new Response('Missing authorization code.', { status: 400 });
			const response = await fetch(`${env.AWQ_CLOUD_API_ORIGIN}/api/assist?mode=exchange&code=${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
			if (!response.ok) return new Response('Authorization code is invalid or expired.', { status: 401 });
			const payload = await response.json() as { token?: string };
			if (!payload.token) return new Response('Authorization response was invalid.', { status: 502 });
			return redirectNoStore('/', cookieHeader(payload.token, 8 * 60 * 60));
		}
		if (url.pathname === '/api/flight-board') {
			if (request.method !== 'GET') {
				return jsonResponse({ error: 'Method not allowed.' }, 405);
			}
			return proxyFlightBoard(request, env);
		}
		if (url.pathname === '/api/flight-weather') {
			if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed.' }, 405);
			return proxyFlightWeather(request, env, url);
		}
		if (url.pathname === '/api/assistant' && request.method === 'POST') return proxyAssistant(request, env, ctx);
		if (url.pathname === '/api/minima' && request.method === 'GET') return listMinimaRecords(request, env, url);
		if (url.pathname === '/api/minima/extract' && request.method === 'POST') return extractMinimaDrafts(request, env, ctx);
		if (url.pathname === '/api/minima/extraction-jobs' && request.method === 'GET') return listExtractionJobsApi(request, env, url);
		if (url.pathname === '/api/minima/approvable' && request.method === 'GET') return listApprovableMinima(request, env, url);
		if (url.pathname === '/api/minima/bulk-decision' && request.method === 'POST') return decideMinimaRecordsBulk(request, env, ctx);
		const minimaMatch = url.pathname.match(/^\/api\/minima\/(\d+)$/);
		if (minimaMatch && request.method === 'GET') return getMinimaRecord(request, env, Number(minimaMatch[1]));
		if (minimaMatch && request.method === 'PATCH') return correctMinimaDraft(request, env, ctx, Number(minimaMatch[1]));
		const minimaDecisionMatch = url.pathname.match(/^\/api\/minima\/(\d+)\/decision$/);
		if (minimaDecisionMatch && request.method === 'POST') return decideMinimaRecord(request, env, ctx, Number(minimaDecisionMatch[1]));
		if (url.pathname === '/api/notams' && request.method === 'GET') return listNotamsForFlight(request, env, url);
		if (url.pathname === '/api/assessments' && request.method === 'POST') return createAssessment(request, env, ctx);
		if (url.pathname === '/api/assessments' && request.method === 'GET') return listAssessments(request, env, url);
		const assessmentMatch = url.pathname.match(/^\/api\/assessments\/(\d+)$/);
		if (assessmentMatch && request.method === 'GET') {
			const loaded = await getAssessment(request, env, Number(assessmentMatch[1]));
			if (loaded.response) return loaded.response;
			const assessment = loaded.assessment!;
			let snapshot: unknown = null;
			try { snapshot = JSON.parse(assessment.snapshot_json); } catch { snapshot = null; }
			return documentResponse({ ok: true, data: { ...assessment, snapshot_json: undefined, snapshot } });
		}
		const assessmentReviewMatch = url.pathname.match(/^\/api\/assessments\/(\d+)\/review$/);
		if (assessmentReviewMatch && request.method === 'POST') return reviewAssessment(request, env, Number(assessmentReviewMatch[1]));
		const assessmentReportMatch = url.pathname.match(/^\/api\/assessments\/(\d+)\/report$/);
		if (assessmentReportMatch && request.method === 'GET') return assessmentReport(request, env, Number(assessmentReportMatch[1]));
		if (url.pathname === '/api/documents' && request.method === 'GET') return listDocuments(request, env, url);
		if (url.pathname === '/api/documents' && request.method === 'POST') return uploadDocument(request, env, ctx);
		const documentMatch = url.pathname.match(/^\/api\/documents\/(\d+)$/);
		if (documentMatch && request.method === 'DELETE') return deleteDocument(request, env, Number(documentMatch[1]), ctx);
		if (documentMatch && request.method === 'GET') return downloadDocument(request, env, Number(documentMatch[1]), ctx);
		if (url.pathname === '/api/reference-documents' && request.method === 'GET') return listReferenceDocuments(request, env);
		if (url.pathname === '/api/reference-documents' && request.method === 'POST') return uploadReferenceDocument(request, env, ctx);
		if (url.pathname === '/api/reference-ingest' && request.method === 'POST') return ingestReferenceCorpus(request, env, ctx);
		if (url.pathname === '/api/reference-index' && request.method === 'POST') return indexReferenceCorpus(request, env, url, ctx);
		const referenceDocumentMatch = url.pathname.match(/^\/api\/reference-documents\/(\d+)$/);
		if (referenceDocumentMatch && request.method === 'DELETE') return deleteReferenceDocument(request, env, Number(referenceDocumentMatch[1]), ctx);
		if (referenceDocumentMatch && request.method === 'GET') return downloadReferenceDocument(request, env, Number(referenceDocumentMatch[1]), ctx);
		if (url.pathname === '/api/health') return jsonResponse({ ok: true, service: 'awq-dispatch-assist', version: 'phase-9' });

		return env.ASSETS.fetch(request);
	}
}

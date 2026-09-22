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
import { buildDispatchInput, type AwqFlightWeather, type ScheduleAdjustment, type ScheduleResolution } from './awq';
import {
	CLAUSE_REFERENCES,
	assessDispatch,
	type ApproachMinima,
	type DispatchFinding,
	type DispatchVerdict,
	type EtaWindows,
	type FuelRequirement
} from './dispatch';
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
} | null;

/**
 * Contract version 3: the deterministic dispatch assessment plus its explanation.
 *
 * The upstream payloads are stored verbatim alongside the derived assessment so
 * a verdict can always be re-checked against the data it was drawn from, and
 * `dataQualityNotes` records what the adapter had to infer or correct.
 */
type DispatchSnapshot = {
	contractVersion: '3';
	createdAt: string;
	flight: AssessmentFlight;
	weather: AssessmentWeather;
	dispatch: {
		verdict: DispatchVerdict;
		windows: DispatchSnapshotWindows;
		fuel: FuelRequirement;
		findings: DispatchFinding[];
		notamEvaluated: boolean;
		destinationStation: string | null;
		alternateStation: string | null;
		dataQualityNotes: string[];
	};
	schedule: {
		stdZ: string | null;
		staZ: string | null;
		dof: string | null;
		/** True when a human still has to confirm a date the feed left ambiguous. */
		needsConfirmation: boolean;
		adjustments: ScheduleAdjustment[];
	};
	minima: { destination: ApproachMinima | null; alternate: ApproachMinima | null };
	notamRemarks: string | null;
	explanation: ExplanationRecord | null;
	referenceDocuments: Array<{ id: number; file_name: string; category: string; chunk_count: number }>;
};

/** How long the explanation may take before it is abandoned. */
const EXPLAIN_TIMEOUT_MS = 20_000;

/**
 * The DeepSeek credential is a Wrangler secret, so it is not part of the
 * generated `Env` unless the secret happened to be present when types were
 * generated — which is not the case on a fresh checkout. It is read through a
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

/**
 * Read a minima value supplied by the client.
 *
 * A value with no approach label is not minima, because it cannot be attributed
 * to an approach, so it is discarded rather than defaulted. When the client
 * supplies no clause reference, the planning-minima family is cited: that is the
 * rule basis the value is applied against, and leaving the finding uncited would
 * break the requirement that every recommendation names its source.
 */
function parseMinima(value: unknown): ApproachMinima | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const approach = String(record.approach ?? '').trim().slice(0, 120);
	if (!approach) return null;
	const references = Array.isArray(record.references)
		? record.references.map(entry => String(entry).trim()).filter(Boolean).slice(0, 10)
		: [];
	return {
		approach,
		ceilingFt: finiteNumberOrNull(record.ceilingFt),
		visibilityM: finiteNumberOrNull(record.visibilityM),
		references: references.length ? references : [...CLAUSE_REFERENCES.planningMinima]
	};
}

/** Windows are stored as ISO instants so a snapshot stays readable without a revive step. */
function serialiseWindows(windows: EtaWindows | null): DispatchSnapshotWindows {
	if (!windows) return null;
	return {
		destination: { from: windows.destination.from.toISOString(), to: windows.destination.to.toISOString() },
		primaryAlternate: { from: windows.primaryAlternate.from.toISOString(), to: windows.primaryAlternate.to.toISOString() }
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
 * (`READY`, `REVIEW_REQUIRED`, `NO_DATA`) by a CHECK constraint, so the finer verdict
 * cannot be stored there without rebuilding the table. The verdict is kept in full
 * inside the snapshot — which is the record of authority — and mapped here:
 *
 *   GO                 -> READY
 *   MARGINAL, NO-GO    -> REVIEW_REQUIRED
 *
 * The mapping is deliberately conservative in one direction only: the column never
 * reports READY unless the verdict was GO, so a collapsed value can understate
 * readiness but cannot overstate it. `json_extract` recovers the true verdict for
 * the history list.
 */
export function legacyStatusFor(verdict: DispatchVerdict): 'READY' | 'REVIEW_REQUIRED' {
	return verdict === 'GO' ? 'READY' : 'REVIEW_REQUIRED';
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

/**
 * Create an immutable dispatch assessment for one flight.
 *
 * The verdict is produced by the deterministic engine and the explanation
 * afterwards. The order matters: an AI outage degrades the write-up, never the
 * decision, so the assessment is complete and storable before any model is
 * called.
 */
async function createAssessment(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: { flightId?: number; minima?: unknown; notamRemarks?: unknown; explain?: unknown; schedule?: unknown };
	try { body = await request.json() as typeof body; } catch { return documentResponse({ error: 'A JSON request body is required.' }, 400); }
	const flightId = Number(body.flightId || 0);
	if (!Number.isInteger(flightId) || flightId <= 0) return documentResponse({ error: 'A valid flightId is required.' }, 400);
	const userId = await authorizeFlight(request, env, flightId);
	if (!userId) return documentResponse({ error: 'SSO is required for this flight.' }, 401);

	// An operator-stated arrival date takes precedence over anything the adapter
	// would infer, and removes the confirmation requirement for that field.
	const scheduleBody = (body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule) ? body.schedule : {}) as Record<string, unknown>;
	const overrideSta = parseInstantInput(scheduleBody.staZ);

	// Minima and NOTAM are not published by the feed, so they arrive with the
	// request. Both may be absent, in which case the engine records that the check
	// could not be evaluated rather than assuming compliance.
	const minima = (body.minima && typeof body.minima === 'object' && !Array.isArray(body.minima) ? body.minima : {}) as Record<string, unknown>;
	const destinationMinima = parseMinima(minima.destination);
	const alternateMinima = parseMinima(minima.alternate);
	const notamRemarks = String(body.notamRemarks ?? '').trim().slice(0, 2000) || null;
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
	const adapted = buildDispatchInput({
		flight,
		weather: weatherData as AwqFlightWeather,
		reference: Number.isNaN(reference.getTime()) ? new Date() : reference,
		destinationMinima,
		alternateMinima,
		notamRemarks,
		scheduleOverride: overrideSta ? { staZ: overrideSta } : {}
	});
	const evaluation = assessDispatch(adapted.input);

	let explanation: ExplanationRecord | null = null;
	if (wantExplanation) {
		const explainerInput: ExplainerInput = {
			flightLabel: String(flight.callsign || flight.flightNumber || flight.id),
			origin: flight.origin ?? null,
			destination: flight.destination ?? null,
			registration: flight.aircraft?.registration ?? null,
			destinationAlternates: adapted.input.destinationAlternates,
			verdict: evaluation.verdict,
			windows: evaluation.windows,
			diversionMinutes: adapted.input.diversionMinutes,
			findings: evaluation.findings,
			fuel: evaluation.fuel,
			notamEvaluated: evaluation.notamEvaluated
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
	const snapshot: DispatchSnapshot = {
		contractVersion: '3',
		createdAt: new Date().toISOString(),
		flight,
		weather: weatherData,
		dispatch: {
			verdict: evaluation.verdict,
			windows: serialiseWindows(evaluation.windows),
			fuel: evaluation.fuel,
			findings: evaluation.findings,
			notamEvaluated: evaluation.notamEvaluated,
			destinationStation: adapted.destinationStation,
			alternateStation: adapted.alternateStation,
			dataQualityNotes: adapted.notes
		},
		minima: { destination: destinationMinima, alternate: alternateMinima },
		notamRemarks,
		explanation,
		schedule: serialiseSchedule(adapted.schedule),
		referenceDocuments: references.results || [],
	};
	const contextHash = await hashToken(JSON.stringify(snapshot));
	const result = await env.DB.prepare(
		`INSERT INTO dispatch_assessments (flight_id, user_id, status, decision, contract_version, snapshot_json, context_hash)
		 VALUES (?, ?, ?, 'OPEN', '3', ?, ?)`
	).bind(flightId, userId, legacyStatusFor(evaluation.verdict), JSON.stringify(snapshot), contextHash).run();
	const assessmentId = Number(result.meta.last_row_id);
	await audit(
		env,
		userId,
		'assessment_create',
		'dispatch_assessment',
		assessmentId,
		`${evaluation.verdict} findings=${evaluation.findings.length} fuel=${evaluation.fuel.mandatoryHoldingMinutes}min notam=${evaluation.notamEvaluated ? 'evaluated' : 'unevaluated'}`,
		ctx
	);
	return documentResponse({
		ok: true,
		data: {
			id: assessmentId,
			flightId,
			verdict: evaluation.verdict,
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
		// `verdict` is lifted out of the snapshot in SQL rather than parsed in JS: the
		// column only holds the coarse readiness value, and parsing up to twenty full
		// snapshots (each carrying the raw upstream payload) to read one field would be
		// wasteful. It is null for contract-2 rows, where the caller falls back to
		// `status`.
		`SELECT id, flight_id, status, decision, contract_version, context_hash, created_at, reviewed_at, review_note,
		        json_extract(snapshot_json, '$.dispatch.verdict') AS verdict
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

const REPORT_STYLE = [
	'body{font-family:Arial,sans-serif;color:#17202b;max-width:960px;margin:40px auto;padding:0 24px;line-height:1.5}',
	'h1{margin-bottom:4px}h2{margin-top:28px;border-bottom:1px solid #ccd3da;padding-bottom:4px}',
	'.meta{color:#536273}.badge{display:inline-block;padding:6px 12px;border-radius:999px;background:#eef1f4;font-weight:700;margin-right:6px}',
	'.finding{padding:12px 16px;border-left:4px solid #ccd3da;background:#f7f9fa;margin-bottom:8px}',
	'.finding--critical{border-left-color:#c0392b;background:#fdf0ee}',
	'.finding--caution{border-left-color:#e5a72b;background:#fff8e9}',
	'.finding--info{border-left-color:#5b7c99;background:#f4f7fa}',
	'.severity{display:inline-block;min-width:74px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.04em}',
	'.evidence{color:#536273;font-size:12px;margin-top:4px}',
	'table{border-collapse:collapse;width:100%;margin-top:12px}',
	'th,td{border:1px solid #ccd3da;padding:8px;text-align:left;vertical-align:top}',
	'button{padding:10px 16px;margin-bottom:24px}',
	'.disclaimer{margin-top:32px;padding:12px 16px;border:1px solid #ccd3da;background:#f7f9fa;font-size:12px;color:#3d4a57}',
	'.narrative{white-space:pre-wrap;background:#f7f9fa;border:1px solid #ccd3da;padding:12px 16px;font-size:13px}',
	'.badge--go{background:#e3f4ea;color:#1c6b41}',
	'.badge--marginal{background:#fff4dd;color:#8a5a00}',
	'.badge--nogo{background:#fbe3e0;color:#8c2b20}',
	'.note{color:#536273;font-size:12px}',
	'@media print{button{display:none}}',
].join('');

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

/** `NO-GO` becomes `nogo`, so a verdict maps onto a CSS class safely. */
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

/**
 * Render a contract-3 assessment.
 *
 * Section headings follow the evaluation workflow's output format, so the
 * printed report and the model narrative describe the same things in the same
 * order. The verdict, the windows and every finding come from the deterministic
 * engine; the narrative is presentation only and cannot change them.
 */
function renderDispatchReport(assessment: StoredAssessment, snapshot: DispatchSnapshot): Response {
	const { dispatch } = snapshot;
	const windows = dispatch.windows;
	const destinationWindow = windows ? `${zuluLabel(windows.destination.from)} - ${zuluLabel(windows.destination.to)}` : 'not available';
	const alternateWindow = windows ? `${zuluLabel(windows.primaryAlternate.from)} - ${zuluLabel(windows.primaryAlternate.to)}` : 'not available';

	const findingBlocks = dispatch.findings.length
		? dispatch.findings
				.map(
					item =>
						`<div class="finding finding--${escapeHtml(item.severity.toLowerCase())}"><span class="severity">${escapeHtml(item.severity)}</span>${escapeHtml(item.message)}<div class="evidence">Evidence: ${escapeHtml(item.evidence)}</div><div class="evidence">References: ${escapeHtml(item.references.join(', ') || 'none cited')}</div></div>`
				)
				.join('')
		: '<p>No findings recorded.</p>';

	const dataQuality = dispatch.dataQualityNotes.length
		? `<ul>${dispatch.dataQualityNotes.map(note => `<li class="note">${escapeHtml(note)}</li>`).join('')}</ul>`
		: '<p class="note">No data-quality corrections were required.</p>';

	const taf = Array.isArray(snapshot.weather?.taf) ? snapshot.weather.taf : [];
	const tafRows = taf
		.map(
			item =>
				`<tr><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.station)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.coverage)}</td><td>${escapeHtml(item.raw)}</td></tr>`
		)
		.join('');

	const references = Array.isArray(snapshot.referenceDocuments) ? snapshot.referenceDocuments : [];
	const documentRows = references
		.map(item => `<li>${escapeHtml(item.file_name)} · ${escapeHtml(item.category)} · ${escapeHtml(item.chunk_count)} indexed excerpts</li>`)
		.join('');

	const minimaLine = (value: ApproachMinima | null): string =>
		value
			? `${escapeHtml(value.approach)} — ceiling ${escapeHtml(value.ceilingFt ?? 'n/a')} ft, visibility ${escapeHtml(value.visibilityM ?? 'n/a')} m`
			: 'not supplied';

	const explanation = snapshot.explanation;
	const narrative =
		explanation && explanation.ok
			? `<div class="narrative">${escapeHtml(explanation.narrative)}</div><p class="note">Model ${escapeHtml(explanation.model)} · prompt hash ${escapeHtml(explanation.promptHash)}</p>`
			: `<p class="note">No model narrative was produced (${escapeHtml(explanation ? explanation.reason : 'not requested')}). The deterministic assessment above stands on its own.</p>`;

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dispatch Assessment ${escapeHtml(assessment.id)}</title><style>${REPORT_STYLE}</style></head><body>
<button onclick="window.print()">Print / Save as PDF</button>
<h1>Operational Dispatch Assessment</h1>
<p class="meta">Assessment #${escapeHtml(assessment.id)} · Flight ${escapeHtml(snapshot.flight.callsign || snapshot.flight.flightNumber || snapshot.flight.id)} · Created ${escapeHtml(assessment.created_at)} UTC</p>
<p><span class="badge badge--${escapeHtml(verdictSlug(dispatch.verdict))}">Verdict: ${escapeHtml(dispatch.verdict)}</span><span class="badge">Decision: ${escapeHtml(assessment.decision)}</span><span class="badge">Contract v3</span></p>
<h2>Flight context</h2>
<p><strong>Route:</strong> ${escapeHtml(snapshot.flight.origin)} to ${escapeHtml(snapshot.flight.destination)}<br><strong>Registration:</strong> ${escapeHtml(snapshot.flight.aircraft?.registration)}<br><strong>Destination alternates:</strong> ${escapeHtml((snapshot.flight.destinationAlternates || []).join(', ') || 'None')}<br><strong>Enroute alternates:</strong> ${escapeHtml((snapshot.flight.enrouteAlternates || []).join(', ') || 'None')}</p>
<h2>1. ETA Windows &amp; Operational Status</h2>
<p><strong>Destination (${escapeHtml(dispatch.destinationStation || 'unknown')}):</strong> ETA window ${escapeHtml(destinationWindow)}<br><strong>Primary alternate (${escapeHtml(dispatch.alternateStation || 'none nominated')}):</strong> ETA window ${escapeHtml(alternateWindow)}</p>
${snapshot.schedule.needsConfirmation ? `<p class="note"><strong>Schedule confirmation required — the ETA windows above are provisional.</strong><br>${snapshot.schedule.adjustments.map(adjustment => escapeHtml(adjustment.note)).join('<br>')}</p>` : ''}
<h2>2. Weather &amp; Minima Evaluation</h2>
<p><strong>Destination landing minima:</strong> ${minimaLine(snapshot.minima.destination)}<br><strong>Alternate planning minima:</strong> ${minimaLine(snapshot.minima.alternate)}</p>
<p><strong>Monitoring freshness:</strong> ${escapeHtml(snapshot.weather?.weatherMonitoring?.freshness ?? 'not stated')} · <strong>Warnings:</strong> ${escapeHtml(snapshot.weather?.weatherMonitoring?.warningCount ?? 'n/a')} · <strong>Affecting route:</strong> ${escapeHtml((dispatch.findings.some(item => item.code === 'WX_ROUTE_IMPACT') ? 'yes' : 'no'))}</p>
<table><thead><tr><th>Role</th><th>Station</th><th>Status</th><th>Coverage</th><th>Raw TAF</th></tr></thead><tbody>${tafRows || '<tr><td colspan="5">No TAF data</td></tr>'}</tbody></table>
<h2>3. Dispatch Recommendations &amp; Verdict</h2>
<p><strong>Feasibility:</strong> ${escapeHtml(dispatch.verdict)}</p>
<p><strong>Legal fuel requirement:</strong> ${escapeHtml(dispatch.fuel.mandatoryHoldingMinutes)} min additional holding (${escapeHtml(dispatch.fuel.basis)})<br><span class="note">${escapeHtml(dispatch.fuel.rationale)}<br>References: ${escapeHtml(dispatch.fuel.references.join(', ') || 'none cited')}</span></p>
<p><strong>Advisory fuel padding:</strong> ${escapeHtml(dispatch.fuel.advisoryPaddingMinutes)} min<br><span class="note">${escapeHtml(dispatch.fuel.advisoryRationale || 'No advisory padding recommended.')}</span></p>
<p><strong>Alternate recommendation:</strong> ${escapeHtml(dispatch.alternateStation || 'none nominated')}${snapshot.minima.alternate ? '' : ' — no planning minima supplied, so suitability could not be confirmed'}</p>
<p><strong>NOTAM / remarks:</strong> ${escapeHtml(dispatch.notamEvaluated ? (snapshot.notamRemarks || 'supplied') : 'not provided — the check is unevaluated')}</p>
<h2>Findings</h2>
${findingBlocks}
<h2>Written assessment</h2>
${narrative}
<h2>Data quality notes</h2>
${dataQuality}
<h2>Reference manuals indexed</h2>
<ul>${documentRows || '<li>No reference manuals indexed.</li>'}</ul>
<p class="disclaimer"><strong>Advisory only.</strong> The verdict, ETA windows and fuel requirement were produced by a deterministic evaluation of the AWQ Cloud payload; the written assessment merely explains them. This is not an airworthiness determination and does not authorise flight. The flight operations officer retains release authority and must verify every finding against the source documents before dispatch.</p>
<h2>Integrity</h2>
<p class="meta">Context hash: ${escapeHtml(assessment.context_hash)}${assessment.review_note ? `<br>Review note: ${escapeHtml(assessment.review_note)}` : ''}${assessment.reviewed_at ? `<br>Reviewed: ${escapeHtml(assessment.reviewed_at)} UTC` : ''}</p>
</body></html>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
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

	// An assessment is an immutable record, so an earlier contract version must
	// stay renderable rather than being rewritten by a later one.
	const candidate = snapshot as Partial<DispatchSnapshot>;
	if (candidate.contractVersion === '3' && candidate.dispatch) {
		return renderDispatchReport(assessment, candidate as DispatchSnapshot);
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
				`<li>${escapeHtml(item.file_name)} · ${escapeHtml(item.category)} · ${escapeHtml(item.chunk_count)} indexed excerpts</li>`
		)
		.join('');
	const structured = Array.isArray(snapshot.structuredFindings) ? snapshot.structuredFindings : [];
	const worst = structured.length ? highestSeverity(structured) : null;
	const classification = worst ? `${assessment.status} · worst finding ${worst}` : assessment.status;

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dispatch Assessment ${escapeHtml(assessment.id)}</title><style>${REPORT_STYLE}</style></head><body>
<button onclick="window.print()">Print / Save as PDF</button>
<h1>Operational Dispatch Assessment</h1>
<p class="meta">Assessment #${escapeHtml(assessment.id)} · Flight ${escapeHtml(snapshot.flight.callsign || snapshot.flight.flightNumber || snapshot.flight.id)} · Created ${escapeHtml(assessment.created_at)} UTC</p>
<p><span class="badge">${escapeHtml(classification)}</span><span class="badge">Decision: ${escapeHtml(assessment.decision)}</span><span class="badge">Contract v${escapeHtml(assessment.contract_version)}</span></p>
<h2>Flight context</h2>
<p><strong>Route:</strong> ${escapeHtml(snapshot.flight.origin)} to ${escapeHtml(snapshot.flight.destination)}<br><strong>Registration:</strong> ${escapeHtml(snapshot.flight.aircraft?.registration)}<br><strong>Destination alternates:</strong> ${escapeHtml((snapshot.flight.destinationAlternates || []).join(', ') || 'None')}<br><strong>Enroute alternates:</strong> ${escapeHtml((snapshot.flight.enrouteAlternates || []).join(', ') || 'None')}</p>
<h2>Readiness findings</h2>
${renderFindings(snapshot)}
<h2>TAF and Weather Monitoring</h2>
<p><strong>Freshness:</strong> ${escapeHtml(snapshot.weather?.weatherMonitoring?.freshness)} · <strong>Warnings:</strong> ${escapeHtml(snapshot.weather?.weatherMonitoring?.warningCount)}</p>
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
	).all();
	return documentResponse({ ok: true, data: { documents: results || [] } });
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

	const retrieval = await retrieve(env, CHUNK_INGEST_VERSION, question, 8);
	const rows = retrieval.results;
	const flightId = Number(payload.flightId || 0);
	const answer = rows.length
		? `Retrieved ${rows.length} relevant corpus excerpt${rows.length === 1 ? '' : 's'}. Review the cited clauses before making an operational decision.`
		: 'No indexed manual excerpt matched the question. Verify the source manual directly before making an operational decision.';
	// The method is recorded so a lexical-only answer, which happens when the query
	// embedding fails, is distinguishable from a full hybrid answer in the audit log.
	await audit(
		env,
		userId,
		'assistant_query',
		'flight',
		flightId || null,
		`${retrieval.method}; lexical=${retrieval.candidates.lexical} vector=${retrieval.candidates.vector}`,
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

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			// Without this, an uncaught exception leaves the browser with a non-JSON 500
			// and no reason — which is exactly how the status-constraint failure presented
			// itself: the UI could only say "Assessment creation failed." The detail goes
			// to the log (visible in `wrangler tail`); the client gets a stable JSON shape.
			console.error('[DISPATCH] unhandled request failure', error);
			return jsonResponse({ ok: false, code: 'INTERNAL', error: 'The request could not be completed.' }, 500);
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

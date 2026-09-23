/**
 * Minima extraction: the job model and the runner.
 *
 * Why a job and a queue
 *   A chart costs a PDF conversion plus a model call, measured at 81 to 130 seconds
 *   per chart. On the request path that budget collides with the platform's
 *   response limits: four of seven charts were lost to a timeout in one run, and
 *   each loss was reported to the dispatcher as a failed click rather than as work
 *   still in progress. A Queue consumer has a 15-minute wall-clock limit, so the
 *   work is enqueued, the request returns immediately with a job id, and the client
 *   polls the job. Nothing about the safety property changes: the consumer writes
 *   drafts through the same `insertDrafts` path, and no code in this module can
 *   approve anything.
 *
 * One runner, two callers
 *   `runExtractionJob` is used by the queue consumer and by the synchronous
 *   fallback, so the two paths cannot drift in what they extract or how they record
 *   provenance. The only difference is who waits.
 */

import { extractChart, type ChartSource } from './minima-extraction';
import { insertDrafts, sha256Hex } from './minima-registry';

/**
 * The models this product will send chart text to.
 *
 * An allow-list rather than free text, because the value reaches a provider as a
 * model identifier: an arbitrary string is an arbitrary request to an external
 * service, and `deepseek-chat` in particular produced minima values that
 * contradicted the other two models on the same chart (see DESIGN.md section 11),
 * so it is deliberately not offered.
 */
export const EXTRACTION_MODELS = ['deepseek-flash', 'deepseek-reasoner'] as const;
export type ExtractionModel = (typeof EXTRACTION_MODELS)[number];
export const DEFAULT_EXTRACTION_MODEL: ExtractionModel = 'deepseek-flash';

/** True when the requested model is one this product will use. */
export function isExtractionModel(value: unknown): value is ExtractionModel {
	return typeof value === 'string' && (EXTRACTION_MODELS as readonly string[]).includes(value);
}

/** What the queue message carries. Small by design: the chart is read from R2. */
export type ExtractionJobMessage = {
	jobId: string;
	objectKey: string;
	icao: string;
	model: string;
};

/** The row shape of `airport_minima_extraction_jobs`. */
export type ExtractionJob = {
	id: string;
	status: 'pending' | 'running' | 'succeeded' | 'failed';
	objectKey: string;
	icao: string | null;
	model: string;
	requestedBy: number | null;
	attempt: number;
	sourceBytes: number | null;
	markdownChars: number | null;
	draftsExtracted: number | null;
	draftsStored: number | null;
	skippedDuplicates: number | null;
	duplicatesOfApproved: number | null;
	draftIds: string | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
};

type JobRow = {
	id: string;
	status: string;
	object_key: string;
	icao: string | null;
	model: string;
	requested_by: number | null;
	attempt: number;
	source_bytes: number | null;
	markdown_chars: number | null;
	drafts_extracted: number | null;
	drafts_stored: number | null;
	skipped_duplicates: number | null;
	duplicates_of_approved: number | null;
	draft_ids: string | null;
	error: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
};

const JOB_COLUMNS = `
	id, status, object_key, icao, model, requested_by, attempt,
	source_bytes, markdown_chars, drafts_extracted, drafts_stored, skipped_duplicates,
	duplicates_of_approved, draft_ids, error, created_at, started_at, finished_at`;

function toJob(row: JobRow): ExtractionJob {
	return {
		id: row.id,
		status: row.status as ExtractionJob['status'],
		objectKey: row.object_key,
		icao: row.icao,
		model: row.model,
		requestedBy: row.requested_by === null ? null : Number(row.requested_by),
		attempt: Number(row.attempt ?? 0),
		sourceBytes: row.source_bytes === null ? null : Number(row.source_bytes),
		markdownChars: row.markdown_chars === null ? null : Number(row.markdown_chars),
		draftsExtracted: row.drafts_extracted === null ? null : Number(row.drafts_extracted),
		draftsStored: row.drafts_stored === null ? null : Number(row.drafts_stored),
		skippedDuplicates: row.skipped_duplicates === null ? null : Number(row.skipped_duplicates),
		duplicatesOfApproved: row.duplicates_of_approved === null ? null : Number(row.duplicates_of_approved),
		draftIds: row.draft_ids,
		error: row.error,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at
	};
}

/** Create a pending job row and return it. */
export async function createExtractionJob(
	env: Env,
	options: { objectKey: string; icao: string; model: string; requestedBy: number | null }
): Promise<ExtractionJob> {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO airport_minima_extraction_jobs (id, status, object_key, icao, model, requested_by)
		 VALUES (?, 'pending', ?, ?, ?, ?)`
	)
		.bind(id, options.objectKey, options.icao, options.model, options.requestedBy)
		.run();
	return {
		id,
		status: 'pending',
		objectKey: options.objectKey,
		icao: options.icao,
		model: options.model,
		requestedBy: options.requestedBy,
		attempt: 0,
		sourceBytes: null,
		markdownChars: null,
		draftsExtracted: null,
		draftsStored: null,
		skippedDuplicates: null,
		duplicatesOfApproved: null,
		draftIds: null,
		error: null,
		createdAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null
	};
}

/** Read one job, for the client's poll. */
export async function getExtractionJob(env: Env, id: string): Promise<ExtractionJob | null> {
	const row = await env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM airport_minima_extraction_jobs WHERE id = ? LIMIT 1`)
		.bind(id)
		.first<JobRow>();
	return row ? toJob(row) : null;
}

/** Recent jobs, newest first, so the registry view can show what is in flight. */
export async function listExtractionJobs(env: Env, icao: string | null, limit = 30): Promise<ExtractionJob[]> {
	const bounded = Math.max(1, Math.min(100, limit));
	const statement = icao
		? env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM airport_minima_extraction_jobs WHERE icao = ? ORDER BY created_at DESC, id DESC LIMIT ?`).bind(icao, bounded)
		: env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM airport_minima_extraction_jobs ORDER BY created_at DESC, id DESC LIMIT ?`).bind(bounded);
	const { results } = await statement.all<JobRow>();
	return (results || []).map(toJob);
}

export type ExtractionOutcome = {
	ok: boolean;
	reason?: string;
	markdownChars: number;
	sourceBytes: number;
	draftsExtracted: number;
	draftsStored: number;
	skippedDuplicates: number;
	duplicatesOfApproved: number;
	draftIds: number[];
};

/**
 * Run one extraction job and record its outcome.
 *
 * The job row is the record of the attempt, so every terminal path writes it: a
 * missing object, a failed conversion, a model error and a success all leave a row
 * the client can read. A job left in `running` would be a claim nobody can check.
 */
export async function runExtractionJob(
	env: Env,
	message: ExtractionJobMessage,
	options: { markdownTimeoutMs?: number } = {}
): Promise<ExtractionOutcome> {
	const startedAt = new Date().toISOString();
	await env.DB.prepare(`UPDATE airport_minima_extraction_jobs SET status = 'running', started_at = ?, attempt = attempt + 1 WHERE id = ?`)
		.bind(startedAt, message.jobId)
		.run();

	const fail = async (reason: string, extra: Partial<ExtractionOutcome> = {}): Promise<ExtractionOutcome> => {
		const outcome: ExtractionOutcome = {
			ok: false,
			reason,
			markdownChars: 0,
			sourceBytes: 0,
			draftsExtracted: 0,
			draftsStored: 0,
			skippedDuplicates: 0,
			duplicatesOfApproved: 0,
			draftIds: [],
			...extra
		};
		await env.DB.prepare(
			`UPDATE airport_minima_extraction_jobs
			    SET status = 'failed', error = ?, source_bytes = ?, markdown_chars = ?, finished_at = ?
			  WHERE id = ?`
		)
			.bind(reason.slice(0, 500), outcome.sourceBytes, outcome.markdownChars, new Date().toISOString(), message.jobId)
			.run();
		return outcome;
	};

	const object = await env.DOCUMENTS.get(message.objectKey);
	if (!object) return fail('object-not-found');

	const bytes = new Uint8Array(await object.arrayBuffer());
	const pathSegments = message.objectKey.split('/');
	const fileName = pathSegments[pathSegments.length - 1] || message.objectKey;
	const source: ChartSource = {
		objectKey: message.objectKey,
		icao: message.icao,
		fileName,
		bytes,
		pdfHash: await sha256Hex(bytes)
	};

	// The timeout here is the model call's budget, not the job's: the consumer has 15
	// minutes of wall clock, so a slow chart is given room rather than a retry. The
	// markdown conversion is measured in under a second and is not the bottleneck.
	const extraction = await extractChart(source, {
		apiKey: String((env as unknown as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY ?? '').trim(),
		model: message.model,
		timeoutMs: options.markdownTimeoutMs ?? 600_000,
		toMarkdown: async file => {
			const converted = await env.AI.toMarkdown({
				name: file.fileName,
				blob: new Blob([file.bytes], { type: 'application/pdf' })
			});
			const result = Array.isArray(converted) ? converted[0] : converted;
			if (!result || result.format === 'error' || typeof result.data !== 'string') {
				throw new Error(result && 'error' in result ? String(result.error) : 'conversion produced no text');
			}
			return result.data;
		}
	});

	if (!extraction.ok) return fail(extraction.reason, { sourceBytes: bytes.length });

	const stored = await insertDrafts(env, {
		drafts: extraction.drafts,
		sourceObjectKey: message.objectKey,
		pdfHash: source.pdfHash,
		extractionModel: message.model,
		actorId: null
	});

	await env.DB.prepare(
		`UPDATE airport_minima_extraction_jobs
		    SET status = 'succeeded', source_bytes = ?, markdown_chars = ?, drafts_extracted = ?,
		        drafts_stored = ?, skipped_duplicates = ?, duplicates_of_approved = ?, draft_ids = ?, finished_at = ?
		  WHERE id = ?`
	)
		.bind(
			bytes.length,
			extraction.markdownChars,
			extraction.drafts.length,
			stored.inserted.length,
			stored.skippedDuplicates,
			stored.duplicatesOfApproved,
			JSON.stringify(stored.inserted),
			new Date().toISOString(),
			message.jobId
		)
		.run();

	return {
		ok: true,
		markdownChars: extraction.markdownChars,
		sourceBytes: bytes.length,
		draftsExtracted: extraction.drafts.length,
		draftsStored: stored.inserted.length,
		skippedDuplicates: stored.skippedDuplicates,
		duplicatesOfApproved: stored.duplicatesOfApproved,
		draftIds: stored.inserted
	};
}

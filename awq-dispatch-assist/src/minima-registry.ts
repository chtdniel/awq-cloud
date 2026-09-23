/**
 * Minima registry storage.
 *
 * The registry is the only place an assessment may take a numeric minima value
 * from. Its rules, all enforced here rather than by the caller:
 *
 *   Drafts are inert
 *     `insertDrafts` always writes `status = 'draft'`. Nothing in this module can
 *     create an approved record, so AI extraction cannot activate a value on its
 *     own (PRD §5, acceptance §29).
 *
 *   Approval is an explicit, audited act
 *     `updateDraft` and `approveRecord` require an actor id, write the value
 *     before and after the change into `airport_minima_audit`, and stamp the
 *     approver and the approval time on the record (PRD acceptance §28).
 *
 *   A changed value loses its approval
 *     Correcting an approved record through `updateDraft` returns it to `draft`,
 *     so a value can never be edited and stay usable without a fresh approval.
 *
 *   Only approved rows are ever read by an assessment
 *     `listActiveMinima` filters on `status = 'approved'` and `listMinima` reads
 *     every state for review.
 *
 * The content hash covers the fields a dispatcher reviews. It travels into the
 * assessment snapshot, so a stored assessment can be traced to the exact record
 * revision it was computed from even after the record is later edited.
 */

import { planningMinimaForAlternate, higherMinima, type ApproachMinima, type MinimaKind, type MinimaRecord, type MinimaStatus } from './minima';
import { canApprove, canRetireForMissingSource, retireBlockedReason, statusAfterCorrection } from './minima-rules';

/** SHA-256, hexadecimal. Used for the PDF source and for the record content. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
	const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A minima value as extracted from a chart, before it is stored or approved. */
export type MinimaDraftInput = {
	aisAuthority: string;
	country: string;
	icao: string;
	chartIdentifier: string;
	chartPage: string | null;
	runway: string | null;
	approach: string;
	approachType: string | null;
	aircraftCategory: string | null;
	kind: MinimaKind;
	ceilingFt: number | null;
	visibilityM: number | null;
	valueType: string | null;
	aipCycle: string | null;
	effectiveFrom: string | null;
	effectiveTo: string | null;
	/** The chart fragment the extractor says these values came from. */
	sourceText: string | null;
	confidence: 'high' | 'medium' | 'low';
	/** What the extractor could not read, in its own words. */
	notes: string | null;
};

export type MinimaRecordWithHistory = {
	record: MinimaRecord;
	history: Array<{
		id: number;
		action: string;
		actorId: number | null;
		before: unknown;
		after: unknown;
		note: string | null;
		createdAt: string;
	}>;
};

/** The columns an insert writes, in one place so the statement and the hash agree. */
const RECORD_COLUMNS = `
	source_object_key, pdf_hash, ais_authority, country, icao,
	chart_identifier, chart_page, runway, approach, approach_type, aircraft_category,
	kind, ceiling_ft, visibility_m, value_type,
	aip_cycle, effective_from, effective_to,
	extraction_model, extraction_confidence, source_text, review_notes`;

/**
 * The content a dispatcher is asked to verify.
 *
 * `pdfHash` is included: a record approved against one revision of a chart is not
 * the same record after the chart file is replaced. `sourceText` is included too,
 * because it is the extractor's claim about where the values came from; if that
 * claim changes, the approval was given against a different claim.
 */
function contentHashInput(record: {
	pdfHash: string;
	icao: string;
	chartIdentifier: string;
	chartPage: string | null;
	runway: string | null;
	approach: string;
	approachType: string | null;
	aircraftCategory: string | null;
	kind: MinimaKind;
	ceilingFt: number | null;
	visibilityM: number | null;
	valueType: string | null;
	aipCycle: string | null;
	effectiveFrom: string | null;
	effectiveTo: string | null;
	sourceText?: string | null;
}): string {
	return JSON.stringify([
		record.pdfHash,
		record.icao,
		record.chartIdentifier,
		record.chartPage,
		record.runway,
		record.approach,
		record.approachType,
		record.aircraftCategory,
		record.kind,
		record.ceilingFt,
		record.visibilityM,
		record.valueType,
		record.aipCycle,
		record.effectiveFrom,
		record.effectiveTo,
		record.sourceText ?? null
	]);
}

/** A D1 row of `airport_minima`, in the shape the mapper expects. */
type MinimaRow = {
	id: number;
	status: string;
	kind: string;
	source_object_key: string;
	pdf_hash: string;
	ais_authority: string;
	country: string;
	icao: string;
	chart_identifier: string;
	chart_page: string | null;
	runway: string | null;
	approach: string;
	approach_type: string | null;
	aircraft_category: string | null;
	ceiling_ft: number | null;
	visibility_m: number | null;
	value_type: string | null;
	aip_cycle: string | null;
	effective_from: string | null;
	effective_to: string | null;
	extraction_model: string | null;
	extraction_confidence: string | null;
	source_text: string | null;
	review_notes: string | null;
	approved_by: number | null;
	approved_at: string | null;
	superseded_by: number | null;
	content_hash: string;
	created_by: number | null;
	created_at: string;
	updated_at: string;
};

const SELECT_COLUMNS = `
	id, status, kind, source_object_key, pdf_hash, ais_authority, country, icao,
	chart_identifier, chart_page, runway, approach, approach_type, aircraft_category,
	ceiling_ft, visibility_m, value_type, aip_cycle, effective_from, effective_to,
	extraction_model, extraction_confidence, source_text, review_notes,
	approved_by, approved_at, superseded_by, content_hash, created_by, created_at, updated_at`;

function toRecord(row: MinimaRow): MinimaRecord {
	return {
		id: Number(row.id),
		status: row.status as MinimaStatus,
		kind: row.kind as MinimaKind,
		sourceObjectKey: row.source_object_key,
		pdfHash: row.pdf_hash,
		aisAuthority: row.ais_authority,
		country: row.country,
		icao: row.icao,
		chartIdentifier: row.chart_identifier,
		chartPage: row.chart_page,
		runway: row.runway,
		approach: row.approach,
		approachType: row.approach_type,
		aircraftCategory: row.aircraft_category,
		ceilingFt: row.ceiling_ft === null ? null : Number(row.ceiling_ft),
		visibilityM: row.visibility_m === null ? null : Number(row.visibility_m),
		valueType: row.value_type,
		aipCycle: row.aip_cycle,
		effectiveFrom: row.effective_from,
		effectiveTo: row.effective_to,
		extractionModel: row.extraction_model,
		extractionConfidence: (row.extraction_confidence as MinimaRecord['extractionConfidence']) ?? null,
		sourceText: row.source_text,
		reviewNotes: row.review_notes,
		approvedBy: row.approved_by === null ? null : Number(row.approved_by),
		approvedAt: row.approved_at,
		supersededBy: row.superseded_by === null ? null : Number(row.superseded_by),
		contentHash: row.content_hash,
		createdBy: row.created_by === null ? null : Number(row.created_by),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

/** The reference block a minima record carries into a finding. */
export function referencesForRecord(record: MinimaRecord): string[] {
	const page = record.chartPage ? `, page ${record.chartPage}` : '';
	const cycle = record.aipCycle ? `, cycle ${record.aipCycle}` : '';
	return [`${record.aisAuthority} AIP ${record.icao} ${record.chartIdentifier}${page}${cycle}`];
}

/** The registry record as an engine minima value. */
export function toApproachMinima(record: MinimaRecord): ApproachMinima {
	const label = [record.approach, record.runway ? `RWY ${record.runway}` : null, record.aircraftCategory ? `CAT ${record.aircraftCategory}` : null]
		.filter(Boolean)
		.join(' ');
	return {
		approach: label || record.chartIdentifier,
		ceilingFt: record.ceilingFt,
		visibilityM: record.visibilityM,
		references: referencesForRecord(record)
	};
}

/**
 * Planning minima for the alternate.
 *
 * The chart's published `Alternate Minima` wins when the registry holds one for
 * the same approach; otherwise the company minima of OM Part A Table 8.1-5 is
 * derived from the landing value. Table 8.1-5's note asks for the higher of the
 * two, which `higherMinima` applies when both exist.
 */
export function alternatePlanningMinima(
	landing: MinimaRecord | null,
	publishedAlternate: MinimaRecord | null
): ApproachMinima | null {
	if (publishedAlternate) {
		const chart = toApproachMinima(publishedAlternate);
		if (!landing) return chart;
		return higherMinima(chart, planningMinimaForAlternate(toApproachMinima(landing), landing.approachType));
	}
	if (!landing) return null;
	return planningMinimaForAlternate(toApproachMinima(landing), landing.approachType);
}

/** Every minima record for one aerodrome, newest first, for the review screen. */
export async function listMinima(env: Env, icao: string): Promise<MinimaRecord[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE icao = ? ORDER BY chart_identifier ASC, approach ASC, kind ASC, id ASC`
	)
		.bind(icao.trim().toUpperCase())
		.all<MinimaRow>();
	return (results || []).map(toRecord);
}

/** Aerodromes that have at least one record, for the airport search box. */
export async function listMinimaAirports(env: Env): Promise<Array<{ icao: string; country: string; approved: number; draft: number }>> {
	const { results } = await env.DB.prepare(
		`SELECT icao, country,
		        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
		        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
		   FROM airport_minima
		  GROUP BY icao, country
		  ORDER BY icao ASC`
	).all<{ icao: string; country: string; approved: number; draft: number }>();
	return (results || []).map(row => ({
		icao: row.icao,
		country: row.country,
		approved: Number(row.approved ?? 0),
		draft: Number(row.draft ?? 0)
	}));
}

/**
 * Approved records only.
 *
 * This is the function an assessment uses, and it is the reason a draft cannot
 * influence an outcome.
 */
export async function listActiveMinima(env: Env, icao: string): Promise<MinimaRecord[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${SELECT_COLUMNS} FROM airport_minima
		  WHERE icao = ? AND status = 'approved'
		  ORDER BY chart_identifier ASC, approach ASC, kind ASC, id ASC`
	)
		.bind(icao.trim().toUpperCase())
		.all<MinimaRow>();
	return (results || []).map(toRecord);
}

/**
 * The source chart a group of records came from, and how those records stand.
 *
 * At least one chart file per aerodrome is the normal case, so the registry is grouped
 * by source object rather than by record: the question this answers is "is the document
 * these values came from still available", which is a property of the file, not of any
 * single row.
 */
export type SourceObjectState = {
	icao: string;
	sourceObjectKey: string;
	records: number;
	draft: number;
	approved: number;
	rejected: number;
	superseded: number;
	/** Ids that would be retired if this source is missing: drafts and approved records. */
	retirableIds: number[];
};

/**
 * Every source chart the registry holds records from, with per-status counts.
 *
 * The counts matter as much as the existence check: a source with 8 approved records and
 * one with 8 drafts both need retiring, but only the first is changing what an assessment
 * may use, and that difference should be visible before the action rather than after.
 */
export async function listSourceObjects(env: Env, icao: string | null): Promise<SourceObjectState[]> {
	const filter = icao ? 'WHERE icao = ?' : '';
	const bound = icao ? [icao.trim().toUpperCase()] : [];

	const totals = await env.DB.prepare(
		`SELECT icao, COALESCE(source_object_key, '') AS source_object_key,
		        COUNT(*) AS records,
		        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
		        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
		        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
		        SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded
		   FROM airport_minima ${filter}
		  GROUP BY icao, source_object_key
		  ORDER BY icao ASC, source_object_key ASC`
	).bind(...bound).all<{
		icao: string;
		source_object_key: string;
		records: number;
		draft: number;
		approved: number;
		rejected: number;
		superseded: number;
	}>();

	// The retirable ids are read separately rather than glued into the grouped query with
	// GROUP_CONCAT, because this list is handed back to the caller and acted on by id: it
	// has to be a list of ids, not a string that has to be parsed back into one.
	const live = await env.DB.prepare(
		`SELECT id, icao, COALESCE(source_object_key, '') AS source_object_key
		   FROM airport_minima
		  WHERE status IN ('draft', 'approved') ${icao ? 'AND icao = ?' : ''}
		  ORDER BY id ASC`
	).bind(...bound).all<{ id: number; icao: string; source_object_key: string }>();

	const idsBySource = new Map<string, number[]>();
	for (const row of live.results || []) {
		const key = `${row.icao}\u0000${row.source_object_key}`;
		const list = idsBySource.get(key) ?? [];
		list.push(Number(row.id));
		idsBySource.set(key, list);
	}

	return (totals.results || []).map(row => ({
		icao: row.icao,
		sourceObjectKey: row.source_object_key,
		records: Number(row.records ?? 0),
		draft: Number(row.draft ?? 0),
		approved: Number(row.approved ?? 0),
		rejected: Number(row.rejected ?? 0),
		superseded: Number(row.superseded ?? 0),
		retirableIds: idsBySource.get(`${row.icao}\u0000${row.source_object_key}`) ?? []
	}));
}

/**
 * Retire the records whose source chart is no longer in the document store.
 *
 * Why the caller names ids
 *   The ids come from `listSourceObjects`, so the operator acts on a specific set they
 *   were shown. Re-deriving "everything that is orphaned" inside this call would let the
 *   action drift from what was reviewed, which is the failure mode bulk approval avoids
 *   the same way.
 *
 * Why the existence check is repeated here
 *   The check is made immediately before each status change, not trusted from the preview.
 *   If a chart is restored between the preview and the action, the record has not lost its
 *   source and is skipped with that reason instead of being retired on a stale reading.
 *
 * Retiring goes through `rejectRecord`, so it produces exactly the audit trail a manual
 * rejection produces — including the note that says which source went missing — and a
 * retired record can be approved again if its source returns.
 */
export async function retireRecordsFromMissingSource(
	env: Env,
	actorId: number,
	ids: number[],
	note: string | null
): Promise<{
	retired: Array<{ id: number; icao: string; sourceObjectKey: string }>;
	skipped: Array<{ id: number; reason: string }>;
}> {
	const unique = [...new Set(ids)];
	const found: MinimaRecord[] = [];
	// Chunked because D1 caps bound parameters per statement, and a whole aerodrome can
	// exceed that in one request.
	for (let index = 0; index < unique.length; index += 40) {
		const chunk = unique.slice(index, index + 40);
		const placeholders = chunk.map(() => '?').join(', ');
		const { results } = await env.DB.prepare(
			`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE id IN (${placeholders})`
		).bind(...chunk).all<MinimaRow>();
		for (const row of results || []) found.push(toRecord(row));
	}

	// One existence check per distinct source, not per record: a chart with 56 records on
	// it is one document, and 56 heads would be 56 round trips for the same answer.
	const presence = new Map<string, boolean>();
	for (const record of found) {
		const key = record.sourceObjectKey ?? '';
		if (presence.has(key)) continue;
		presence.set(key, key ? await env.DOCUMENTS.head(key) !== null : false);
	}

	const retired: Array<{ id: number; icao: string; sourceObjectKey: string }> = [];
	const skipped: Array<{ id: number; reason: string }> = [];

	for (const id of unique) {
		const record = found.find(row => row.id === id) ?? null;
		if (!record) {
			skipped.push({ id, reason: 'This record no longer exists.' });
			continue;
		}
		const sourceObjectKey = record.sourceObjectKey ?? '';
		const sourcePresent = presence.get(sourceObjectKey) === true;
		const decision = canRetireForMissingSource(record, sourcePresent);
		if (!decision.ok) {
			skipped.push({ id, reason: retireBlockedReason(record, sourcePresent) ?? 'The record was not retired.' });
			continue;
		}
		const reason = [
			note,
			`Source chart ${sourceObjectKey || 'not recorded on the record'} is no longer in the document store, so this value can no longer be checked against it and has been retired. Approve a value read from the replacement chart.`
		].filter(Boolean).join(' ');
		const result = await rejectRecord(env, actorId, id, reason);
		if (result.ok) retired.push({ id, icao: record.icao, sourceObjectKey });
		else skipped.push({ id, reason: result.error });
	}

	return { retired, skipped };
}

/** One record with its audit history, for the review screen. */
export async function getMinima(env: Env, id: number): Promise<MinimaRecordWithHistory | null> {	const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE id = ? LIMIT 1`).bind(id).first<MinimaRow>();
	if (!row) return null;
	const { results } = await env.DB.prepare(
		`SELECT id, action, actor_id, before_json, after_json, note, created_at
		   FROM airport_minima_audit WHERE minima_id = ? ORDER BY created_at ASC, id ASC`
	)
		.bind(id)
		.all<{ id: number; action: string; actor_id: number | null; before_json: string | null; after_json: string | null; note: string | null; created_at: string }>();
	return {
		record: toRecord(row),
		history: (results || []).map(entry => ({
			id: Number(entry.id),
			action: entry.action,
			actorId: entry.actor_id === null ? null : Number(entry.actor_id),
			before: entry.before_json ? safeParse(entry.before_json) : null,
			after: entry.after_json ? safeParse(entry.after_json) : null,
			note: entry.note,
			createdAt: entry.created_at
		}))
	};
}

function safeParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

async function writeAudit(
	env: Env,
	minimaId: number,
	action: string,
	actorId: number | null,
	before: unknown,
	after: unknown,
	note: string | null
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO airport_minima_audit (minima_id, action, actor_id, before_json, after_json, note)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(
			minimaId,
			action,
			actorId,
			before === null || before === undefined ? null : JSON.stringify(before),
			after === null || after === undefined ? null : JSON.stringify(after),
			note
		)
		.run();
}

export type InsertDraftOptions = {
	drafts: readonly MinimaDraftInput[];
	sourceObjectKey: string;
	pdfHash: string;
	extractionModel: string;
	actorId: number | null;
};

/**
 * Store extracted values as drafts.
 *
 * A draft that duplicates an approved record for the same chart, approach and
 * kind is not inserted: re-extracting a chart that has already been reviewed must
 * not create a second, competing value for the engine to choose between.
 */
export async function insertDrafts(env: Env, options: InsertDraftOptions): Promise<{ inserted: number[]; skippedDuplicates: number; duplicatesOfApproved: number }> {
	const inserted: number[] = [];
	let skippedDuplicates = 0;
	let duplicatesOfApproved = 0;

	for (const draft of options.drafts) {
		const existing = await env.DB.prepare(
			`SELECT id, status, content_hash FROM airport_minima
			  WHERE icao = ? AND chart_identifier = ? AND approach = ?
			    AND COALESCE(runway, '') = COALESCE(?, '')
			    AND COALESCE(aircraft_category, '') = COALESCE(?, '')
			    AND kind = ?
			  LIMIT 1`
		)
			.bind(
				draft.icao.trim().toUpperCase(),
				draft.chartIdentifier,
				draft.approach,
				draft.runway,
				draft.aircraftCategory,
				draft.kind
			)
			.first<{ id: number; status: string; content_hash: string }>();

		if (existing) {
			if (existing.status === 'approved') duplicatesOfApproved += 1;
			else skippedDuplicates += 1;
			continue;
		}

		const contentHash = await sha256Hex(
			contentHashInput({
				pdfHash: options.pdfHash,
				icao: draft.icao.trim().toUpperCase(),
				chartIdentifier: draft.chartIdentifier,
				chartPage: draft.chartPage,
				runway: draft.runway,
				approach: draft.approach,
				approachType: draft.approachType,
				aircraftCategory: draft.aircraftCategory,
				kind: draft.kind,
				ceilingFt: draft.ceilingFt,
				visibilityM: draft.visibilityM,
				valueType: draft.valueType,
				aipCycle: draft.aipCycle,
				effectiveFrom: draft.effectiveFrom,
				effectiveTo: draft.effectiveTo,
				sourceText: draft.sourceText
			})
		);

		const result = await env.DB.prepare(
			`INSERT INTO airport_minima (${RECORD_COLUMNS}, status, content_hash, created_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
		)
			.bind(
				options.sourceObjectKey,
				options.pdfHash,
				draft.aisAuthority,
				draft.country,
				draft.icao.trim().toUpperCase(),
				draft.chartIdentifier,
				draft.chartPage,
				draft.runway,
				draft.approach,
				draft.approachType,
				draft.aircraftCategory,
				draft.kind,
				draft.ceilingFt,
				draft.visibilityM,
				draft.valueType,
				draft.aipCycle,
				draft.effectiveFrom,
				draft.effectiveTo,
				options.extractionModel,
				draft.confidence,
				draft.sourceText,
				draft.notes,
				contentHash,
				options.actorId
			)
			.run();
		const id = Number(result.meta.last_row_id);
		inserted.push(id);
		await writeAudit(env, id, 'extracted', options.actorId, null, draft, `extracted from ${options.sourceObjectKey}`);
	}

	return { inserted, skippedDuplicates, duplicatesOfApproved };
}

export type DraftCorrection = {
	id: number;
	ceilingFt?: number | null;
	visibilityM?: number | null;
	approach?: string;
	approachType?: string | null;
	runway?: string | null;
	aircraftCategory?: string | null;
	chartPage?: string | null;
	aipCycle?: string | null;
	effectiveFrom?: string | null;
	effectiveTo?: string | null;
	valueType?: string | null;
	/** The reviewer can correct the extractor's source quotation as well. */
	sourceText?: string | null;
	notes?: string | null;
};

/**
 * Apply an admin correction.
 *
 * An approved record that is corrected goes back to `draft` and loses its
 * approver stamp: the value that was approved is no longer the value on the
 * record, so its approval cannot carry over (PRD §5, acceptance §29). The value
 * before the change is written into the audit history.
 */
export async function updateDraft(env: Env, actorId: number, correction: DraftCorrection): Promise<{ ok: true; status: MinimaStatus } | { ok: false; error: string }> {
	const current = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE id = ? LIMIT 1`)
		.bind(correction.id)
		.first<MinimaRow>();
	if (!current) return { ok: false, error: 'Minima record not found.' };
	const before = toRecord(current);
	const nextStatus = statusAfterCorrection(before);
	if (nextStatus === null) return { ok: false, error: 'A superseded record cannot be edited.' };
	const next = {
		ceilingFt: correction.ceilingFt === undefined ? before.ceilingFt : correction.ceilingFt,
		visibilityM: correction.visibilityM === undefined ? before.visibilityM : correction.visibilityM,
		approach: correction.approach === undefined ? before.approach : correction.approach,
		approachType: correction.approachType === undefined ? before.approachType : correction.approachType,
		runway: correction.runway === undefined ? before.runway : correction.runway,
		aircraftCategory: correction.aircraftCategory === undefined ? before.aircraftCategory : correction.aircraftCategory,
		chartPage: correction.chartPage === undefined ? before.chartPage : correction.chartPage,
		aipCycle: correction.aipCycle === undefined ? before.aipCycle : correction.aipCycle,
		effectiveFrom: correction.effectiveFrom === undefined ? before.effectiveFrom : correction.effectiveFrom,
		effectiveTo: correction.effectiveTo === undefined ? before.effectiveTo : correction.effectiveTo,
		valueType: correction.valueType === undefined ? before.valueType : correction.valueType,
		sourceText: correction.sourceText === undefined ? before.sourceText : correction.sourceText,
		notes: correction.notes === undefined ? before.reviewNotes : correction.notes
	};

	const contentHash = await sha256Hex(
		contentHashInput({
			pdfHash: before.pdfHash,
			icao: before.icao,
			chartIdentifier: before.chartIdentifier,
			chartPage: next.chartPage,
			runway: next.runway,
			approach: next.approach,
			approachType: next.approachType,
			aircraftCategory: next.aircraftCategory,
			kind: before.kind,
			ceilingFt: next.ceilingFt,
			visibilityM: next.visibilityM,
			valueType: next.valueType,
			aipCycle: next.aipCycle,
			effectiveFrom: next.effectiveFrom,
			effectiveTo: next.effectiveTo,
			sourceText: next.sourceText
		})
	);

	const revertsToDraft = nextStatus !== before.status;
	await env.DB.prepare(
		`UPDATE airport_minima
		    SET ceiling_ft = ?, visibility_m = ?, approach = ?, approach_type = ?, runway = ?,
		        aircraft_category = ?, chart_page = ?, aip_cycle = ?, effective_from = ?, effective_to = ?,
		        value_type = ?, source_text = ?, review_notes = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP,
		        status = ?, approved_by = ?, approved_at = ?
		  WHERE id = ?`
	)
		.bind(
			next.ceilingFt,
			next.visibilityM,
			next.approach,
			next.approachType,
			next.runway,
			next.aircraftCategory,
			next.chartPage,
			next.aipCycle,
			next.effectiveFrom,
			next.effectiveTo,
			next.valueType,
			next.sourceText,
			next.notes,
			contentHash,
			nextStatus,
			revertsToDraft ? null : before.approvedBy,
			revertsToDraft ? null : before.approvedAt,
			correction.id
		)
		.run();

	await writeAudit(
		env,
		correction.id,
		'corrected',
		actorId,
		before,
		{ ...before, ...next, contentHash, status: nextStatus },
		revertsToDraft ? 'corrected by an ADMIN; approval cleared because the reviewed value changed' : 'corrected by an ADMIN'
	);

	return { ok: true, status: nextStatus };
}

/**
 * Approve a record.
 *
 * The values are re-read inside this call so the approver is recorded against
 * the content that is actually stored. A record with neither a ceiling nor a
 * visibility value cannot be approved: there would be nothing for the engine to
 * compare, and an approved empty record would read as usable minima.
 */
export async function approveRecord(
	env: Env,
	actorId: number,
	id: number,
	note: string | null
): Promise<{ ok: true; record: MinimaRecord } | { ok: false; error: string }> {
	const current = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE id = ? LIMIT 1`)
		.bind(id)
		.first<MinimaRow>();
	if (!current) return { ok: false, error: 'Minima record not found.' };
	const decision = canApprove(toRecord(current));
	if (!decision.ok) {
		if (decision.reason === 'superseded') return { ok: false, error: 'A superseded record cannot be approved.' };
		if (decision.reason === 'no-values') {
			return {
				ok: false,
				error: 'This record has neither a ceiling nor a visibility value. Read the value from the chart and correct the record before approving it.'
			};
		}
		return { ok: false, error: 'Minima record not found.' };
	}

	await env.DB.prepare(
		`UPDATE airport_minima
		    SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP,
		        review_notes = COALESCE(?, review_notes), updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	)
		.bind(actorId, note, id)
		.run();

	// Any other approved record for the same chart slot is a competing value, so it
	// is superseded rather than left available to the engine.
	const superseded = await env.DB.prepare(
		`SELECT id FROM airport_minima
		  WHERE id <> ? AND icao = ? AND chart_identifier = ? AND approach = ?
		    AND COALESCE(runway, '') = COALESCE(?, '')
		    AND COALESCE(aircraft_category, '') = COALESCE(?, '')
		    AND kind = ? AND status = 'approved'`
	)
		.bind(id, current.icao, current.chart_identifier, current.approach, current.runway, current.aircraft_category, current.kind)
		.all<{ id: number }>();
	for (const row of superseded.results || []) {
		await env.DB.prepare(
			`UPDATE airport_minima SET status = 'superseded', superseded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
		)
			.bind(id, row.id)
			.run();
		await writeAudit(env, Number(row.id), 'superseded', actorId, null, null, `superseded by record ${id}`);
	}

	await writeAudit(env, id, 'approved', actorId, toRecord(current), null, note);
	const approved = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE id = ? LIMIT 1`).bind(id).first<MinimaRow>();
	return { ok: true, record: toRecord(approved!) };
}

/** Reject a draft, which keeps it readable for audit but out of the active set. */
export async function rejectRecord(
	env: Env,
	actorId: number,
	id: number,
	note: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
	const current = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM airport_minima WHERE id = ? LIMIT 1`)
		.bind(id)
		.first<MinimaRow>();
	if (!current) return { ok: false, error: 'Minima record not found.' };
	await env.DB.prepare(
		`UPDATE airport_minima SET status = 'rejected', approved_by = NULL, approved_at = NULL,
		        review_notes = COALESCE(?, review_notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
	)
		.bind(note, id)
		.run();
	await writeAudit(env, id, 'rejected', actorId, toRecord(current), null, note);
	return { ok: true };
}

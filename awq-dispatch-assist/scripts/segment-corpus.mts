/**
 * Validate and apply clause-aware segmentation for the reference corpus.
 *
 * Two modes:
 *   (default)  report segmentation quality for each document
 *   --emit-sql write idempotent SQL for each document into .tmp/
 *
 * The SQL is generated from the same `src/clause.ts` the Worker uses, so the
 * applied result cannot drift from the tested implementation. Run with:
 *   npx tsx scripts/segment-corpus.mts
 *   npx tsx scripts/segment-corpus.mts --emit-sql
 *
 * This is a development tool, not part of the Worker bundle. It is kept in the
 * repository so segmentation quality can be re-checked whenever a manual is added.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { rebuildChunks } from '../src/clause.ts';
import type { CorpusDocumentClass } from '../src/clause.ts';

type Exported = Array<{ results: Array<{ chunk_index: number; content: string; page_number: number | null }> }>;

const TARGET_VERSION = 2;
const SOURCE_VERSION = 1;

/**
 * Rows per INSERT and target bytes per statement.
 *
 * A single 1.5 MB INSERT was rejected by D1 with SQLITE_TOOBIG, so statements are
 * kept to roughly 300 KB. 300 KB is comfortably below the limit observed (a 460 KB
 * statement was accepted) while keeping the statement count reasonable.
 */
const STATEMENTS_PER_INSERT = 25;
const MAX_STATEMENT_BYTES = 300_000;

/**
 * Recorded baselines, used to fail the gate if segmentation regresses.
 *
 * The CASR baseline was lowered from 436 to 355 when false clause numbers were
 * removed. The 81 ids that disappeared were values and examples, not sections —
 * `0.05` from "0.05 foot-candles", `123.45`, `131.775` — and every accepted id now
 * begins with the document's part number (verified: 355 of 355). Before the fix
 * those false boundaries cut real clauses in half, which is why CASR clause
 * coverage rose from 72.5% to 96.8% while the distinct count fell.
 */
const targets: Array<{ id: number; label: string; className: CorpusDocumentClass; expectClauses: number }> = [
	{ id: 2, label: 'Operations Manual Part A', className: 'operations-manual', expectClauses: 1641 },
	{ id: 3, label: 'Flight Dispatch Manual', className: 'dispatch-manual', expectClauses: 581 },
	{ id: 4, label: 'CASR Part 121', className: 'regulation', expectClauses: 355 },
];

const emitSql = process.argv.includes('--emit-sql');

/** Escape a value for a SQLite string literal. */
function sqlText(value: string | null): string {
	if (value === null || value === undefined) return 'NULL';
	return `'${value.replace(/'/g, "''")}'`;
}

function loadChunks(documentId: number) {
	const exported = JSON.parse(readFileSync(`.tmp/doc${documentId}.json`, 'utf8').replace(/^\uFEFF/, '')) as Exported;
	return exported[0]?.results ?? [];
}

/** Fail loudly if a document segments worse than the recorded baseline. */
function checkRegression(label: string, distinctClauses: number, expected: number): boolean {
	if (distinctClauses < expected) {
		console.error(
			`REGRESSION: ${label} segmented to ${distinctClauses} distinct clauses, below the recorded baseline of ${expected}.`
		);
		return false;
	}
	if (distinctClauses > expected) {
		console.log(`note: ${label} now segments to ${distinctClauses} clauses (baseline ${expected}); update the baseline if this is intended.`);
	}
	return true;
}

let healthy = true;

for (const target of targets) {
	const rawRows = loadChunks(target.id);
	const chunks = rebuildChunks(rawRows, target.className);
	const citable = chunks.filter(chunk => chunk.clause_id !== null);
	const distinct = [...new Set(citable.map(chunk => chunk.clause_id))];
	const byScheme = new Map<string, number>();
	for (const chunk of citable) byScheme.set(chunk.clause_scheme, (byScheme.get(chunk.clause_scheme) || 0) + 1);

	const sourceChars = rawRows.reduce((sum, chunk) => sum + chunk.content.length, 0);
	const totalChars = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
	const largest = chunks.reduce((max, chunk) => Math.max(max, chunk.content.length), 0);

	if (!emitSql) {
		console.log(`\n=== ${target.label} (document ${target.id}) ===`);
		console.log(`source chunks        : ${rawRows.length}  (${sourceChars} chars)`);
		console.log(`segmented chunks     : ${chunks.length}  (${totalChars} chars)`);
		console.log(`chunks with clause id: ${citable.length} (${((citable.length / chunks.length) * 100).toFixed(1)}%)`);
		console.log(`distinct clauses     : ${distinct.length}`);
		console.log(`schemes              : ${[...byScheme].map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
		console.log(`text retention       : ${((totalChars / sourceChars) * 100).toFixed(1)}%`);
		console.log(`largest chunk        : ${largest} chars`);
		console.log(`sample clause ids    : ${distinct.slice(0, 10).join(', ')}`);
	}

	if (!checkRegression(target.label, distinct.length, target.expectClauses)) healthy = false;

	if (largest > 4000) {
		console.error(`FAIL: ${target.label} produced a ${largest} character chunk, above the 4000 limit.`);
		healthy = false;
	}
	if (totalChars / sourceChars < 0.99) {
		console.error(`FAIL: ${target.label} retained only ${((totalChars / sourceChars) * 100).toFixed(1)}% of its text.`);
		healthy = false;
	}

	if (emitSql) {
		mkdirSync('.tmp', { recursive: true });
		const lines: string[] = [
			`-- Generated by scripts/segment-corpus.mts for reference_document_id=${target.id} (${target.label}).`,
			`-- Writes ingest_version=${TARGET_VERSION} from ingest_version=${SOURCE_VERSION}; the previous generation is preserved.`,
			'',
			`DELETE FROM reference_document_chunks WHERE reference_document_id = ${target.id} AND ingest_version = ${TARGET_VERSION};`,
			''
		];
		for (let offset = 0; offset < chunks.length;) {
			// Accumulate rows until either the row count or the byte budget is reached,
			// so no single statement grows past what D1 accepts.
			const slice: typeof chunks = [];
			let bytes = 0;
			while (offset < chunks.length && slice.length < STATEMENTS_PER_INSERT) {
				const chunk = chunks[offset];
				const rowBytes = chunk.content.length + (chunk.clause_id?.length || 0) + (chunk.section_title?.length || 0) + 120;
				if (slice.length > 0 && bytes + rowBytes > MAX_STATEMENT_BYTES) break;
				slice.push(chunk);
				bytes += rowBytes;
				offset += 1;
			}
			const values = slice
				.map(
					chunk =>
						`(${target.id}, ${chunk.chunk_index}, NULL, ${sqlText(chunk.content)}, ${sqlText(chunk.clause_id)}, ${sqlText(
							chunk.clause_scheme
						)}, ${sqlText(chunk.section_title)}, ${TARGET_VERSION})`
				)
				.join(',\n  ');
			lines.push(
				'INSERT INTO reference_document_chunks (reference_document_id, chunk_index, page_number, content, clause_id, clause_scheme, section_title, ingest_version) VALUES\n  ' +
					values +
					';'
			);
		}
		lines.push('');
		lines.push(
			`UPDATE reference_documents SET ingest_status = 'ready', chunk_count = ${chunks.length}, ` +
				`ingested_at = CURRENT_TIMESTAMP, ingest_note = ${sqlText(
					`${chunks.length} chunks at version ${TARGET_VERSION}; ${distinct.length} distinct clauses.`
				)} WHERE id = ${target.id};`
		);
		lines.push('');
		const path = `.tmp/ingest-doc${target.id}.sql`;
		writeFileSync(path, lines.join('\n'), 'utf8');
		console.log(`wrote ${path} (${chunks.length} chunks, ${distinct.length} distinct clauses)`);
	}
}

if (!healthy) {
	console.error('\nSegmentation checks failed; no SQL should be applied.');
	process.exit(1);
}
console.log(emitSql ? '\nSQL emitted for all documents.' : '\nAll segmentation checks passed.');

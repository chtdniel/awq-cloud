/**
 * Clause-aware segmentation for the reference corpus.
 *
 * Why this exists
 *   Text extraction split the corpus into fixed 1800-character blocks. Those
 *   blocks cut across clause boundaries, so a retrieved excerpt can contain the
 *   tail of one clause and the head of the next, and no excerpt can be cited by
 *   clause number. A dispatch recommendation that cannot name its clause is not
 *   auditable, so retrieval has to be built on clause boundaries instead.
 *
 * What it does
 *   Segments text on the clause numbering used across the three document
 *   families in this corpus:
 *
 *     CASR Part 121   `121.135 Contents`, `121.635 [Reserved]`
 *     OM Part A       `7.8.1 Duty Time Limitations`   (IAA/FOP/M/001)
 *     FDM             `4.8.11.1 ...`                  (IAA/FOP/M/008)
 *
 *   All three are dotted hierarchical numbers, so one pattern covers them.
 *
 * Precision rules
 *   A dotted number also appears in cross-references ("required by Section
 *   121.133"), in page footers ("4.8-28"), and in table-of-contents dot leaders.
 *   Treating those as boundaries would shatter clauses into fragments, so a
 *   candidate is only accepted when it starts a line, is NOT preceded by a
 *   reference word, and is followed by a title, an enumeration marker, or enough
 *   body prose to be a clause rather than a citation.
 */

export type ClauseScheme = 'casr' | 'om' | 'fdm' | 'generic';

export type CorpusDocumentClass = 'operations-manual' | 'dispatch-manual' | 'regulation' | 'other';

export type RawChunk = {
	chunk_index: number;
	content: string;
	page_number?: number | null;
};

export type ClauseChunk = {
	chunk_index: number;
	content: string;
	clause_id: string | null;
	clause_scheme: ClauseScheme;
	section_title: string | null;
	page_number: number | null;
};

/**
 * Dotted hierarchical clause number: `121.1`, `121.635`, `7.8.1`, `4.8.11.1`,
 * `0.1.5`. Excludes hyphenated page footers such as `4.8-28`, which are layout
 * artefacts rather than clause identities.
 */
const CLAUSE_NUMBER = String.raw`\d{1,4}(?:\.\d{1,4}){1,5}`;

/**
 * A clause marker: a dotted number followed by a space, not preceded by a
 * reference word. Used to find candidates; acceptance is decided by the shape of
 * what follows (see `isBoundary`).
 *
 * The reference-word lookbehind rejects `required by Section 121.133` and
 * `paragraph 4.8.11.1`. It can never reject a heading, because a heading is never
 * introduced by a reference word.
 *
 * This deliberately does not require the marker to start a line: PDF extraction
 * joins lines within a paragraph, so a real heading can appear mid-line. In the
 * live corpus that is exactly how CASR `121.135` appears, preceded by the
 * sentence end of the previous clause.
 */
const CLAUSE_MARKER = new RegExp(
	String.raw`(?<!\b(?:section|sections|paragraph|paragraphs|part|parts|chapter|chapters|subpart|subparts|appendix|attachment|item|items|no|number|casr|pm|amdt|amendment|revision|rev|issue|dated|see|refer|per|under|of|in|and|or|to|from|with|the)\s)(${CLAUSE_NUMBER})\s`,
	'gi'
);

/**
 * What may follow a clause number for it to be a heading rather than a
 * cross-reference: a capitalised title, an enumeration such as `(a)`, or a
 * bracketed `[Reserved]`. A cross-reference is followed by prose, which starts
 * lowercase ("121.133 must:", "4.8.11.1 describes:").
 */
const HEADING_FOLLOWS = /^(?:[A-Z]|\(|\[)/;

/** `[Reserved]` sections carry no title of their own. */
const RESERVED = /^\[?\s*reserved\s*\]?/i;

/** An enumeration opening a clause body: `(a)`, `(1)`, `(xiv)`. */
const ENUMERATION = /^\((?:\d{1,3}|[a-z]{1,4})\)/i;

/**
 * Finds where an enumeration begins anywhere in the line, so a heading that opens
 * its body inline can be separated from it: `Contents (a) Each manual…` yields the
 * title `Contents`. A separate pattern is needed because `ENUMERATION` is anchored
 * for the "does this line open a body" test.
 */
const ENUMERATION_ANYWHERE = /\((?:[a-z]{1,4}|\d{1,3})\)/i;

/** Structure markers that provide parent context for the clauses beneath them. */
const STRUCTURE_MARKER = /^(SUBPART|PART|APPENDIX|ATTACHMENT|CHAPTER|LAMPIRAN)\b[^\n]{0,120}$/i;

/** A table-of-contents line, which lists clause numbers without containing clauses. */
const TOC_LEADER = /\.{5,}/;

const SCHEME_BY_CLASS: Record<CorpusDocumentClass, ClauseScheme> = {
	'operations-manual': 'om',
	'dispatch-manual': 'fdm',
	regulation: 'casr',
	other: 'generic',
};

/** Terminators: a blank line, which usually ends the clause body in this corpus. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * Infer the numbering convention from the leading component of a clause id.
 * CASR Part 121 numbers every section under the part number (`121.x`), whereas
 * the IAA manuals restart numbering per chapter (`7.8.1`), so the leading
 * component is the discriminator.
 */
export function inferScheme(clauseId: string): ClauseScheme {
	const leading = Number(clauseId.split('.')[0]);
	return leading >= 100 && leading <= 199 ? 'casr' : 'generic';
}

/** Normalise whitespace so stored content stays comparable across ingestion runs. */
function normalise(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text after the clause number, up to the end of the line. */
function inlineTail(text: string, matchEnd: number): string {
	const newline = text.indexOf('\n', matchEnd);
	return text.slice(matchEnd, newline === -1 ? text.length : newline);
}

/**
 * Prose following a clause number, sampled from a bounded window.
 *
 * The window is deliberately capped. An earlier implementation scanned the whole
 * remainder of the document with a regex on every candidate, which is quadratic
 * on a 1.4 MB manual and effectively hung the ingestion. A clause body always
 * begins immediately after the heading and is separated from the next clause by a
 * blank line, so a few hundred characters decide the question.
 */
const BODY_SAMPLE_CHARS = 600;

function bodyAfter(text: string, matchEnd: number): string {
	const newline = text.indexOf('\n', matchEnd);
	if (newline === -1) return '';
	const windowEnd = Math.min(text.length, newline + 1 + BODY_SAMPLE_CHARS);
	const rest = text.slice(newline + 1, windowEnd);
	const blank = BLANK_LINE.exec(rest);
	if (blank) return rest.slice(0, blank.index);
	return rest;
}

/**
 * Decide whether a candidate reads as a heading.
 *
 * The corpus joins line breaks inside paragraphs, so the text after a clause
 * number can be an entire clause body rather than a title. A section title is
 * short, has no sentence-ending punctuation, and contains no internal clause
 * marker (which would mean the next clause was swallowed). Anything else is
 * treated as a body with no title, rather than being stored as a misleading
 * 400-character "title".
 */
function looksLikeHeading(candidate: string): boolean {
	const title = candidate.trim();
	if (!title || title.length > 120) return false;
	if (/[.;:,]$/.test(title)) return false;
	if (/\d{1,4}\.\d{1,4}\s\S/.test(title)) return false;
	return true;
}

/**
 * Parse the text after a clause number into a title and body information.
 *
 * The corpus has two shapes, both present in CASR Part 121:
 *   `121.137 Distribution and Availability`           (heading, body follows later)
 *   `121.135 Contents (a) Each manual required by…`    (heading and body on one line)
 */
function parseHeading(inline: string): { title: string | null; opensBody: boolean; enumerator: boolean } {
	const trimmed = inline.trim();
	if (!trimmed) return { title: null, opensBody: true, enumerator: false };

	if (RESERVED.test(trimmed)) {
		const after = trimmed.replace(RESERVED, '').trim();
		return { title: '[Reserved]', opensBody: true, enumerator: ENUMERATION.test(after) };
	}

	const enumerationIndex = trimmed.search(ENUMERATION_ANYWHERE);
	if (enumerationIndex >= 0) {
		const candidate = trimmed.slice(0, enumerationIndex).trim();
		return { title: looksLikeHeading(candidate) ? candidate.replace(/\s+/g, ' ') : null, opensBody: true, enumerator: true };
	}

	if (looksLikeHeading(trimmed)) {
		return { title: trimmed.replace(/\s+/g, ' '), opensBody: false, enumerator: false };
	}
	return { title: null, opensBody: true, enumerator: false };
}

/**
 * A candidate is a real clause boundary when a heading follows it, or when
 * enough prose follows to be a clause body rather than a passing citation.
 */
function isBoundary(text: string, matchEnd: number): boolean {
	const inline = inlineTail(text, matchEnd);
	const trimmed = inline.trimStart();
	if (HEADING_FOLLOWS.test(trimmed)) return true;
	if (parseHeading(inline).opensBody) return true;
	return bodyAfter(text, matchEnd).trim().length >= 80;
}

/**
 * Numeric clause candidates whose leading component matches the document's
 * dominant part number.
 *
 * Why this filter exists
 *   A dotted number is not always a clause. Measured against the live corpus before
 *   this filter, `0.05` (from "0.05 foot-candles"), `123.45` (an illustrative
 *   example) and `131.775` were all accepted as clause numbers. Because a false
 *   boundary is treated as a clause end, those values *cut real clauses in half*:
 *   CASR 121.309 was truncated mid-word at "carried in a comp" and its remainder was
 *   stored with no clause identity at all. That is worse than a missing clause,
 *   because the second half becomes uncitable while looking like unnumbered front
 *   matter.
 *
 * The rule
 *   A regulation numbers every section under its part, so the part number is the
 *   dominant leading component. A candidate whose leading component differs cannot
 *   be a section of this part, so it is rejected. Cross-part references such as
 *   `121.601` cited inside Part 21 are the known cost of this rule; they are rare
 *   and they appear as inline citations rather than as headings.
 */
function dominantClausePrefix(text: string): string | null {
	CLAUSE_MARKER.lastIndex = 0;
	const counts = new Map<string, number>();
	let match: RegExpExecArray | null;
	while ((match = CLAUSE_MARKER.exec(text)) !== null) {
		const leading = match[1].split('.')[0];
		// A leading component of "0" is a measurement such as 0.05, never a part number.
		if (leading === '0') continue;
		counts.set(leading, (counts.get(leading) || 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [prefix, count] of counts) {
		if (count > bestCount) {
			best = prefix;
			bestCount = count;
		}
	}
	// Require a clear majority before constraining: a document with no dominant
	// numbering is left unfiltered rather than forced into an arbitrary prefix.
	const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
	return best && bestCount / total >= 0.5 ? best : null;
}

/** Locate clause boundaries and the clause content they open. */
function collectClauses(text: string): Array<{ clauseId: string; start: number; end: number; title: string | null }> {
	CLAUSE_MARKER.lastIndex = 0;
	const candidates: Array<{ clauseId: string; matchEnd: number; start: number }> = [];
	let match: RegExpExecArray | null;
	while ((match = CLAUSE_MARKER.exec(text)) !== null) {
		const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
		const lineEnd = text.indexOf('\n', match.index);
		const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
		// Reject table-of-contents dot leaders, which list clauses without holding them.
		if (TOC_LEADER.test(line)) continue;
		const numberEnd = match.index + match[1].length;
		if (isBoundary(text, numberEnd)) {
			// The clause starts at the marker itself, not at the line start: PDF
			// extraction can place a heading mid-line after the previous sentence.
			candidates.push({ clauseId: match[1], matchEnd: numberEnd, start: match.index });
		}
	}

	const prefix = dominantClausePrefix(text);
	const accepted = prefix
		? candidates.filter(candidate => candidate.clauseId.split('.')[0] === prefix)
		: candidates;

	const clauses: Array<{ clauseId: string; start: number; end: number; title: string | null }> = [];
	for (let index = 0; index < accepted.length; index += 1) {
		const candidate = accepted[index];
		const next = accepted[index + 1];
		// A clause runs to the next clause. An earlier revision also ended it where the
		// inline body "ended", measured with the bounded `bodyAfter` sample used for
		// boundary detection. That truncated every long clause: CASR 121.309, roughly
		// 4,500 characters, was cut at 773 (its heading plus the 600-character sample),
		// and the remaining 3,715 characters were stored with no clause identity.
		// The next clause's start is the only correct terminator.
		const end = next ? next.start : text.length;
		const shape = parseHeading(inlineTail(text, candidate.matchEnd));
		clauses.push({ clauseId: candidate.clauseId, start: candidate.start, end, title: shape.title });
	}
	return clauses;
}

/**
 * Segment one document's extracted text into clause-aligned chunks.
 *
 * The text preceding the first clause (cover page, revision history, preamble) is
 * emitted as a single chunk with no clause identity, so it stays searchable
 * without being falsely citable.
 */
export function segmentIntoClauses(
	text: string,
	documentClass: CorpusDocumentClass,
	maxChars = 1800
): ClauseChunk[] {
	const normalised = normalise(text);
	const defaultScheme = SCHEME_BY_CLASS[documentClass];
	const clauses = collectClauses(normalised);
	const chunks: ClauseChunk[] = [];
	let cursor = 0;

	const push = (content: string, clauseId: string | null, title: string | null, scheme: ClauseScheme): void => {
		const trimmed = content.trim();
		if (!trimmed) return;
		chunks.push({
			chunk_index: chunks.length,
			content: trimmed,
			clause_id: clauseId,
			clause_scheme: scheme,
			section_title: title,
			page_number: null,
		});
	};

	/**
	 * Emit unnumbered material, such as the cover page or a table of contents.
	 *
	 * It carries no clause identity, but it still has to respect the hard chunk
	 * limit: a regulation's front matter contains a single 44,000-character table
	 * of contents, which would otherwise be stored as one unusable row.
	 */
	const pushUnnumbered = (content: string, scheme: ClauseScheme): void => {
		for (const piece of splitOversized(content.trim(), HARD_CHUNK_LIMIT)) {
			push(piece, null, null, scheme);
		}
	};

	for (const clause of clauses) {
		if (clause.start > cursor) {
			pushUnnumbered(normalised.slice(cursor, clause.start), defaultScheme);
		}
		const scheme = inferScheme(clause.clauseId) === 'casr' ? 'casr' : defaultScheme;
		const pieces = splitOversized(normalised.slice(clause.start, clause.end).trim(), maxChars);
		pieces.forEach((piece, pieceIndex) => {
			push(
				piece,
				clause.clauseId,
				pieceIndex === 0 ? clause.title : `${clause.title ?? ''} (continued)`.trim(),
				scheme
			);
		});
		cursor = clause.end;
	}
	if (cursor < normalised.length) {
		pushUnnumbered(normalised.slice(cursor), defaultScheme);
	}
	return chunks;
}

/**
 * Absolute ceiling for a stored chunk.
 *
 * A clause longer than this is split so that no single row becomes an unusable
 * embedding input. The clause identity is repeated on every piece, so a citation
 * still resolves even though the clause spans rows, and the pieces are ordered by
 * `chunk_index`.
 */
const HARD_CHUNK_LIMIT = 4000;

/** Split a clause that exceeds the hard limit, preferring sentence boundaries. */
function splitOversized(clause: string, _softTarget: number): string[] {
	// The hard limit governs here. `maxChars` only steers how the caller merges
	// units; letting it raise the split threshold would let a caller request a
	// 40,000-character chunk, which is exactly what this ceiling exists to prevent.
	if (clause.length <= HARD_CHUNK_LIMIT) return [clause];
	const limit = HARD_CHUNK_LIMIT;
	const pieces: string[] = [];
	const lines = clause.split('\n');
	let buffer: string[] = [];
	let length = 0;

	const flush = (): void => {
		if (buffer.length) pieces.push(buffer.join('\n').trim());
		buffer = [];
		length = 0;
	};

	for (const line of lines) {
		// A single line longer than the limit is cut on sentence boundaries, falling
		// back to a hard cut only if one sentence is itself oversized.
		if (line.length > limit) {
			flush();
			const sentences = line.split(/(?<=[.;])\s+/);
			let sentenceBuffer = '';
			for (const sentence of sentences) {
				if (sentenceBuffer && sentenceBuffer.length + sentence.length > limit) {
					pieces.push(sentenceBuffer.trim());
					sentenceBuffer = '';
				}
				sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
				while (sentenceBuffer.length > limit) {
					pieces.push(sentenceBuffer.slice(0, limit).trim());
					sentenceBuffer = sentenceBuffer.slice(limit);
				}
			}
			if (sentenceBuffer.trim()) {
				buffer.push(sentenceBuffer);
				length = sentenceBuffer.length;
			}
			continue;
		}
		if (length > 0 && length + line.length > limit) flush();
		buffer.push(line);
		length += line.length + 1;
	}
	flush();
	return pieces.filter(piece => piece.length > 0);
}

/**
 * Rebuild chunks from an already-extracted document. The stored chunk order is
 * preserved, and the page number of the first chunk carrying one is propagated so
 * citations can point at a page when the extractor provided it.
 */
export function rebuildChunks(rawChunks: RawChunk[], documentClass: CorpusDocumentClass, maxChars = 1800): ClauseChunk[] {
	const ordered = [...rawChunks].sort((left, right) => left.chunk_index - right.chunk_index);
	const text = ordered.map(chunk => chunk.content).join('\n');
	const page = ordered.find(chunk => typeof chunk.page_number === 'number')?.page_number ?? null;
	return segmentIntoClauses(text, documentClass, maxChars).map(chunk => ({ ...chunk, page_number: page }));
}

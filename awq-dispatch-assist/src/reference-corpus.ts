/**
 * The reference corpus and the documents that are deliberately outside it.
 *
 * Why a document can be indexed and still be excluded
 *   `reference_documents` is a storage table: it records every PDF that has been
 *   uploaded and ingested, including documents that are no longer authoritative.
 *   The rule sources this product is allowed to cite are the two company manuals,
 *   and CASR is explicitly not one of them (PRD §5, acceptance §15). Deleting the
 *   CASR rows would destroy the history of what was ingested and how it was
 *   segmented, which the corpus's own generation notes say must stay readable, so
 *   the exclusion is applied at read time instead, in one place.
 *
 * What the exclusion covers
 *   Every reader goes through `excludedReferenceDocumentIds`:
 *   - retrieval, so an assistant answer cannot cite CASR or quote its text,
 *   - the assessment snapshot's reference list, so a report cannot name it as an
 *     applied manual,
 *   - the report's "reference manuals indexed" section.
 *
 * Adding a document here is a product decision about authority, not a
 * housekeeping step, which is why the list is named and commented rather than
 * being a condition inside a query.
 */

/** File-name fragments that place a document outside the citable corpus. */
const EXCLUDED_FILE_NAME_PATTERNS: readonly RegExp[] = [
	// Civil Aviation Safety Regulations. The agreed rule sources are Operations
	// Manual Part A (IAA/FOP/M/001) and the Flight Dispatch Manual (IAA/FOP/M/008).
	/\bCASR\b/i,
	/civil aviation safety regulation/i
];

/** True when this document must not be cited, quoted or listed as an applied manual. */
export function isExcludedFromCorpus(fileName: string | null | undefined): boolean {
	const name = String(fileName ?? '');
	return EXCLUDED_FILE_NAME_PATTERNS.some(pattern => pattern.test(name));
}

/**
 * Filter a list of reference documents down to the citable corpus.
 *
 * Used for the assessment snapshot, the report's manual list, and any other place
 * a document name is shown as applied. The list is small in every one of those
 * cases, so a predicate is clearer than threading another SQL clause through each
 * query — and because it is one function, a new reader cannot forget the rule.
 */
export function citableReferenceDocuments<T extends { file_name?: string | null }>(documents: readonly T[]): T[] {
	return documents.filter(document => !isExcludedFromCorpus(document.file_name));
}

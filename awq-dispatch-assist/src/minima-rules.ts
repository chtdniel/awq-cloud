/**
 * The minima registry's decision rules, separated from its storage calls.
 *
 * These are the parts worth testing without a database: which records an
 * assessment may use, whether an approval is allowed, and whether an edit keeps
 * an existing approval. They are pure, so the storage functions in
 * `minima-registry.ts` call them rather than re-implementing the rules inline.
 */

import type { MinimaRecord, MinimaStatus } from './minima';

/** The only status an assessment may read. */
export const USABLE_MINIMA_STATUS: MinimaStatus = 'approved';

/**
 * Whether an assessment may use this record.
 *
 * A draft, a superseded value, and a rejected value are all unavailable. The
 * check is deliberately written as an allow-list rather than a deny-list, so a
 * status added later is unavailable until it is named here.
 */
export function isUsableByAssessment(record: Pick<MinimaRecord, 'status'> | null): boolean {
	return record !== null && record.status === USABLE_MINIMA_STATUS;
}

export type ApprovalDecision =
	| { ok: true }
	| { ok: false; reason: 'not-found' | 'superseded' | 'no-values' };

/**
 * Whether a record may be approved.
 *
 * A record with neither a ceiling nor a visibility value has nothing for the
 * engine to compare, so approving it would create a record that reads as usable
 * minima while checking nothing. That is the case this refuses (PRD §5,
 * acceptance §29).
 */
export function canApprove(record: Pick<MinimaRecord, 'status' | 'ceilingFt' | 'visibilityM'> | null): ApprovalDecision {
	if (!record) return { ok: false, reason: 'not-found' };
	if (record.status === 'superseded') return { ok: false, reason: 'superseded' };
	if (record.ceilingFt === null && record.visibilityM === null) return { ok: false, reason: 'no-values' };
	return { ok: true };
}

/**
 * The status a record holds after an ADMIN correction.
 *
 * Correcting an approved record clears the approval: the value that was approved
 * is no longer the value on the record, so the approval cannot carry over and the
 * record returns to `draft` for a fresh review. Correcting a draft leaves it a
 * draft, and a rejected or superseded record is not editable at all.
 */
export function statusAfterCorrection(record: Pick<MinimaRecord, 'status'>): MinimaStatus | null {
	if (record.status === 'superseded') return null;
	if (record.status === 'approved') return 'draft';
	return record.status;
}

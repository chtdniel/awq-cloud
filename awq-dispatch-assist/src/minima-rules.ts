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
 *
 * This is the only place the rule is expressed. The server enforces it, and the
 * registry view asks the same function so it can disable the control and state the
 * reason *before* the click, instead of presenting an enabled button whose only
 * possible outcome is an error message. A rule that lives in two places drifts;
 * this one does not.
 */
export function canApprove(record: Pick<MinimaRecord, 'status' | 'ceilingFt' | 'visibilityM'> | null): ApprovalDecision {
	if (!record) return { ok: false, reason: 'not-found' };
	if (record.status === 'superseded') return { ok: false, reason: 'superseded' };
	if (record.ceilingFt === null && record.visibilityM === null) return { ok: false, reason: 'no-values' };
	return { ok: true };
}

/**
 * Why a record cannot yet be approved, in the reviewer's own terms.
 *
 * Returned as a sentence rather than a code so the registry view and the API can
 * show the same explanation, and so a reviewer learns what to do rather than only
 * that something is refused.
 */
export function approvalBlockedReason(record: Pick<MinimaRecord, 'status' | 'ceilingFt' | 'visibilityM'> | null): string | null {
	const decision = canApprove(record);
	if (decision.ok) return null;
	switch (decision.reason) {
		case 'not-found':
			return 'This record no longer exists.';
		case 'superseded':
			return 'This record was superseded by a newer approved record for the same procedure.';
		case 'no-values':
			return 'Neither a ceiling nor a visibility could be read from the chart, so there is nothing to verify and nothing for an assessment to compare against. Read the value off the PDF, enter it in the fields above, then approve.';
	}
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

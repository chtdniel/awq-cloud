import { describe, expect, it } from 'vitest';
import { approvalBlockedReason, canApprove, canRetireForMissingSource, isUsableByAssessment, retireBlockedReason, statusAfterCorrection } from '../src/minima-rules';
import { MINIMA_STATUSES } from './helpers/minima-values';

/**
 * Minima registry rule tests.
 *
 * The bounds worth defending are the approval gate and the loss of approval on
 * edit: those two are what stop an unverified AI transcription from reaching an
 * assessment, which is the safety property PRD acceptance criteria 27 to 29
 * describe.
 */

describe('which records an assessment may use', () => {
	it('uses an approved record', () => {
		expect(isUsableByAssessment({ status: 'approved' })).toBe(true);
	});

	it('refuses every other state, including a fresh draft', () => {
		for (const status of MINIMA_STATUSES.filter(value => value !== 'approved')) {
			expect(isUsableByAssessment({ status })).toBe(false);
		}
		expect(isUsableByAssessment(null)).toBe(false);
	});
});

describe('whether a record may be approved', () => {
	it('approves a draft that states a ceiling and a visibility', () => {
		expect(canApprove({ status: 'draft', ceilingFt: 200, visibilityM: 800 })).toEqual({ ok: true });
	});

	it('approves a draft that states only one of the two values', () => {
		// A CAT II/III planning minima can legitimately carry a visibility with no
		// ceiling, so one stated value is enough to be usable.
		expect(canApprove({ status: 'draft', ceilingFt: null, visibilityM: 800 })).toEqual({ ok: true });
		expect(canApprove({ status: 'draft', ceilingFt: 200, visibilityM: null })).toEqual({ ok: true });
	});

	it('refuses a record with no values, because approving it would check nothing', () => {
		expect(canApprove({ status: 'draft', ceilingFt: null, visibilityM: null })).toEqual({ ok: false, reason: 'no-values' });
	});

	it('refuses to approve a superseded record', () => {
		expect(canApprove({ status: 'superseded', ceilingFt: 200, visibilityM: 800 })).toEqual({ ok: false, reason: 'superseded' });
	});

	it('reports a missing record', () => {
		expect(canApprove(null)).toEqual({ ok: false, reason: 'not-found' });
	});
});

/**
 * The blocked reason is what the registry view prints and what the API returns, so
 * a reviewer reading either surface learns the same thing. These cases exist because
 * a real approval attempt failed with a bare refusal and the reason was only in the
 * server's error string.
 */
describe('why approval is blocked, in the reviewer\'s terms', () => {
	it('says nothing when the record can be approved', () => {
		expect(approvalBlockedReason({ status: 'draft', ceilingFt: 200, visibilityM: 800 })).toBeNull();
	});

	it('names the missing value and what to do about it', () => {
		const reason = approvalBlockedReason({ status: 'draft', ceilingFt: null, visibilityM: null });
		expect(reason).toMatch(/ceiling/i);
		expect(reason).toMatch(/visibility/i);
		expect(reason).toMatch(/read the value/i);
		expect(reason).toMatch(/PDF/i);
	});

	it('explains a superseded record', () => {
		expect(approvalBlockedReason({ status: 'superseded', ceilingFt: 200, visibilityM: 800 })).toMatch(/superseded/i);
	});

	it('explains a record that has gone', () => {
		expect(approvalBlockedReason(null)).toMatch(/no longer exists/i);
	});
});

describe('status after an ADMIN correction', () => {
	it('returns an approved record to draft, because the reviewed value changed', () => {
		expect(statusAfterCorrection({ status: 'approved' })).toBe('draft');
	});

	it('leaves a draft a draft', () => {
		expect(statusAfterCorrection({ status: 'draft' })).toBe('draft');
	});

	it('leaves a rejected record rejected', () => {
		expect(statusAfterCorrection({ status: 'rejected' })).toBe('rejected');
	});

	it('refuses to edit a superseded record', () => {
		expect(statusAfterCorrection({ status: 'superseded' })).toBeNull();
	});
});

/**
 * Retiring a record whose source chart is gone.
 *
 * This is the rule behind the case that was found in production: every chart object under
 * `airport/` had been removed while the records extracted from them were still in the
 * registry, 8 of them approved and usable. The bounds below are what stop the action from
 * doing anything except taking a value out of use: it cannot retire a record whose source
 * is present, and it cannot touch a record that has already left the active set.
 */
describe('retiring a record whose source chart is gone', () => {
	it('retires a draft and an approved record when the source is missing', () => {
		expect(canRetireForMissingSource({ status: 'draft' }, false)).toEqual({ ok: true });
		expect(canRetireForMissingSource({ status: 'approved' }, false)).toEqual({ ok: true });
	});

	it('refuses when the source chart is still there, even for an approved record', () => {
		// The record has not lost anything, so retiring it would be discarding a verified
		// value for no reason. This is also the guard against a stale preview: the check
		// runs again immediately before the change.
		expect(canRetireForMissingSource({ status: 'approved' }, true)).toEqual({ ok: false, reason: 'source-present' });
		expect(canRetireForMissingSource({ status: 'draft' }, true)).toEqual({ ok: false, reason: 'source-present' });
	});

	it('leaves a rejected or superseded record alone', () => {
		// Both are already outside the active set. Re-labelling them would overwrite the
		// reason they left, which is the audit trail a reviewer relies on.
		expect(canRetireForMissingSource({ status: 'rejected' }, false)).toEqual({ ok: false, reason: 'not-live' });
		expect(canRetireForMissingSource({ status: 'superseded' }, false)).toEqual({ ok: false, reason: 'not-live' });
	});

	it('explains a skip rather than reporting a silent success', () => {
		expect(retireBlockedReason({ status: 'approved' }, true)).toMatch(/still in the document store/i);
		expect(retireBlockedReason({ status: 'rejected' }, false)).toMatch(/already rejected/i);
		expect(retireBlockedReason(null, false)).toMatch(/no longer exists/i);
	});

	it('says nothing when the record can be retired', () => {
		expect(retireBlockedReason({ status: 'approved' }, false)).toBeNull();
	});
});

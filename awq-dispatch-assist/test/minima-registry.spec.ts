import { describe, expect, it } from 'vitest';
import { approvalBlockedReason, canApprove, isUsableByAssessment, statusAfterCorrection } from '../src/minima-rules';
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

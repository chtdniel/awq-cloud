import { describe, expect, it } from 'vitest';
import { citableReferenceDocuments, isExcludedFromCorpus } from '../src/reference-corpus';

/**
 * Reference corpus exclusion tests.
 *
 * PRD §5 and acceptance criterion 15 put CASR outside the agreed rule sources, and
 * the requirement is that it appears neither in the reference corpus nor in any
 * output. These cases pin the predicate that every reader shares.
 */

describe('corpus exclusions', () => {
	it('excludes the CASR regulation document', () => {
		expect(isExcludedFromCorpus('CASR-Part-121-Amdt.-12.pdf')).toBe(true);
		expect(isExcludedFromCorpus('casr part 121.pdf')).toBe(true);
		expect(isExcludedFromCorpus('Civil Aviation Safety Regulation Part 121.pdf')).toBe(true);
	});

	it('keeps the two agreed company manuals', () => {
		expect(isExcludedFromCorpus('Operations Manual Part A.pdf')).toBe(false);
		expect(isExcludedFromCorpus('Flight-Dispatch-Manual.pdf')).toBe(false);
	});

	it('keeps an AIP chart and an unrelated document', () => {
		expect(isExcludedFromCorpus('ILS-Z RWY 21 - PAGE 2.pdf')).toBe(false);
		expect(isExcludedFromCorpus('Loadsheet 2026-09-23.pdf')).toBe(false);
	});

	it('treats a missing name as not excluded rather than throwing', () => {
		expect(isExcludedFromCorpus(null)).toBe(false);
		expect(isExcludedFromCorpus(undefined)).toBe(false);
		expect(isExcludedFromCorpus('')).toBe(false);
	});

	it('filters a document list down to the citable corpus', () => {
		const documents = [
			{ id: 2, file_name: 'Operations Manual Part A.pdf' },
			{ id: 3, file_name: 'Flight-Dispatch-Manual.pdf' },
			{ id: 4, file_name: 'CASR-Part-121-Amdt.-12.pdf' }
		];
		const citable = citableReferenceDocuments(documents);
		expect(citable.map(document => document.id)).toEqual([2, 3]);
	});

	it('filters a document whose name is absent rather than dropping it', () => {
		// A row with no name cannot be identified as an excluded document, and dropping
		// it would silently hide a manual from the report.
		expect(citableReferenceDocuments([{ id: 7 } as { id: number; file_name?: string }])).toHaveLength(1);
	});
});

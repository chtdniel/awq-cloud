import { describe, expect, it } from 'vitest';
import { inferScheme, rebuildChunks, segmentIntoClauses } from '../src/clause';

/**
 * Fixtures are quoted from the three documents in the live reference corpus
 * (Operations Manual Part A, Flight Dispatch Manual, CASR Part 121) so the tests
 * track the real numbering and layout, including extraction artefacts, rather
 * than an idealised sample.
 */

describe('clause scheme inference', () => {
	it('identifies CASR part numbering by its leading component', () => {
		expect(inferScheme('121.635')).toBe('casr');
		expect(inferScheme('121.1')).toBe('casr');
	});

	it('leaves manual chapter numbering generic', () => {
		expect(inferScheme('7.8.1')).toBe('generic');
		expect(inferScheme('4.8.11.1')).toBe('generic');
		expect(inferScheme('0.1.5')).toBe('generic');
	});
});

describe('CASR segmentation', () => {
	// Verbatim from CASR Part 121: heading and body share a line.
	const casr = [
		'Director. 121.135 Contents (a) Each manual required by Section 121.133 must: (1) Include instructions and information necessary to allow the personnel concerned to perform their duties.',
		'',
		'121.137 Distribution and Availability',
		'Each certificate holder shall furnish copies of the manual to the persons listed in this section.',
		'',
		'121.635 [Reserved]',
		'121.637 Takeoffs from Unlisted and Alternate Airports (a) No pilot may takeoff an airplane from an airport that is not listed in the Operations Specifications.',
	].join('\n');

	it('captures clause numbers from body headings', () => {
		const ids = segmentIntoClauses(casr, 'regulation').map(chunk => chunk.clause_id);
		expect(ids).toContain('121.135');
		expect(ids).toContain('121.137');
		expect(ids).toContain('121.637');
	});

	it('records the regulatory scheme for CASR clauses', () => {
		const target = segmentIntoClauses(casr, 'regulation').find(chunk => chunk.clause_id === '121.135');
		expect(target?.clause_scheme).toBe('casr');
	});

	it('captures the title when the heading opens its body on the same line', () => {
		const target = segmentIntoClauses(casr, 'regulation').find(chunk => chunk.clause_id === '121.135');
		expect(target?.section_title).toBe('Contents');
	});

	it('captures the title of a standalone heading', () => {
		const target = segmentIntoClauses(casr, 'regulation').find(chunk => chunk.clause_id === '121.137');
		expect(target?.section_title).toBe('Distribution and Availability');
	});

	it('keeps a reserved section with its identity', () => {
		const target = segmentIntoClauses(casr, 'regulation').find(chunk => chunk.clause_id === '121.635');
		expect(target).toBeDefined();
		expect(target?.section_title).toBe('[Reserved]');
	});

	it('does not treat a cross-reference as a clause boundary', () => {
		const ids = segmentIntoClauses(casr, 'regulation').map(chunk => chunk.clause_id);
		// `Section 121.133` appears mid-line as a reference, never as a heading.
		expect(ids).not.toContain('121.133');
	});
});

describe('Operations Manual segmentation', () => {
	const om = [
		'7.8 Rules Related to FOO',
		'7.8.1 Duty Time Limitations',
		'The flight operation officer shall not be assigned to duty for more than the maximum permitted period.',
		'',
		'7.8.2 Rest Requirements',
		'Adequate rest must be provided before any duty period that exceeds the permitted limits.',
	].join('\n');

	it('splits manual sections and keeps them out of the CASR scheme', () => {
		const target = segmentIntoClauses(om, 'operations-manual').find(chunk => chunk.clause_id === '7.8.1');
		expect(target).toBeDefined();
		expect(target?.clause_scheme).not.toBe('casr');
		expect(target?.section_title).toBe('Duty Time Limitations');
	});

	it('keeps the FDM clause body attached to its clause', () => {
		const fdm = [
			'4.8.11.1 FOO should accomplish the following procedures to obtain flight information',
			'a. Liaise with Duty Manager for the latest aircraft allocation or aircraft updates for the next day.',
			'b. Produce Daily Flights Schedule for the next day.',
		].join('\n');
		const target = segmentIntoClauses(fdm, 'dispatch-manual').find(chunk => chunk.clause_id === '4.8.11.1');
		expect(target?.content).toContain('Liaise with Duty Manager');
		expect(target?.clause_scheme).toBe('fdm');
	});
});

describe('boundary precision', () => {
	it('does not cut on a table-of-contents dot leader', () => {
		const toc = [
			'121.135 Contents ............................................................................. G-1',
			'121.137 Distribution and Availability ......................................................... G-1',
			'121.99 Communication Facilities: Flag, Domestic and Supplemental Air Carriers ................. E-2',
		].join('\n');
		const claimed = segmentIntoClauses(toc, 'regulation').filter(chunk => chunk.clause_id !== null);
		expect(claimed).toHaveLength(0);
	});

	it('does not treat a hyphenated page footer as a clause', () => {
		const text = [
			'4.8-28 Flight Dispatch',
			'The officer shall verify the weather minima before signing the release.',
		].join('\n');
		const claimed = segmentIntoClauses(text, 'dispatch-manual').filter(chunk => chunk.clause_id !== null);
		expect(claimed).toHaveLength(0);
	});

	it('does not read a document revision number as a clause', () => {
		const text = [
			'CASR 121 Amdt. 12 May 2017',
			'PM 61 Tahun 2017 applies to all certificate holders operating under this part.',
		].join('\n');
		const claimed = segmentIntoClauses(text, 'regulation').filter(chunk => chunk.clause_id !== null);
		expect(claimed).toHaveLength(0);
	});

	it('segments a document with no numbering without inventing clauses', () => {
		const chunks = segmentIntoClauses('This manual contains general guidance with no numbered sections.', 'other');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].clause_id).toBeNull();
	});
});

describe('clause integrity regressions', () => {
	it('keeps a long clause whole when its body extends past the boundary sample window', () => {
		// Regression: the clause end was once computed from the bounded body sample used
		// for boundary detection, which truncated every clause longer than the sample.
		// CASR 121.309 (~4,500 characters) was cut at 773 and its remainder stored with
		// no clause identity. The next clause's start is the only valid terminator.
		const body = Array.from({ length: 40 }, (_, index) => `(${index + 2}) Requirement number ${index + 2} for emergency equipment must be satisfied.`).join(' ');
		const text = [
			'121.309 Emergency Equipment (a) General: No person may operate an airplane unless it is equipped with the emergency equipment listed in this section.',
			body,
			'121.310 Additional Emergency Equipment. Each passenger emergency exit marking must meet the following requirements.',
		].join('\n');
		const chunks = segmentIntoClauses(text, 'regulation');
		const pieces = chunks.filter(chunk => chunk.clause_id === '121.309');
		const whole = pieces.map(piece => piece.content).join(' ');
		expect(whole).toContain('Requirement number 40');
		expect(whole.length).toBeGreaterThan(2000);
		// No stored chunk may begin mid-word, which is the signature of a bad split.
		for (const chunk of chunks) {
			expect(chunk.content).not.toMatch(/^[a-z]{2,} /);
		}
	});

	it('does not treat a measurement value as a clause number', () => {
		// Regression: `0.05` (from "0.05 foot-candles"), `123.45` and `131.775` were
		// accepted as clause numbers, and because a false boundary ends a clause they
		// cut real clauses in half.
		const text = [
			'121.309 Emergency Equipment (a) General: Equipment must be provided as follows.',
			'The illumination must be at least 0.05 foot-candles at each required location.',
			'For example, an airplane certificated under 123.45 may differ. See also 131.775 for foreign operators.',
			'121.310 Additional Emergency Equipment. Each passenger emergency exit marking must meet the requirements.',
		].join('\n');
		const ids = segmentIntoClauses(text, 'regulation').map(chunk => chunk.clause_id).filter(Boolean);
		expect(ids).not.toContain('0.05');
		expect(ids).not.toContain('123.45');
		expect(ids).not.toContain('131.775');
		expect(ids).toContain('121.309');
		expect(ids).toContain('121.310');
	});

	it('keeps the whole 121.309 body inside a 121.309 piece', () => {
		const text = [
			'121.309 Emergency Equipment (a) General: Equipment must be provided as follows.',
			'(4) When carried in a compartment or container, it must be marked as to contents and date of last inspection.',
			'(c) Hand fire extinguishers for crew, passenger, cargo, and galley compartments must be provided.',
			'121.310 Additional Emergency Equipment. Each passenger emergency exit marking must meet the requirements.',
		].join('\n');
		const chunks = segmentIntoClauses(text, 'regulation');
		const whole = chunks.filter(chunk => chunk.clause_id === '121.309').map(chunk => chunk.content).join(' ');
		expect(whole).toContain('Hand fire extinguishers for crew');
		expect(whole).toContain('marked as to contents');
	});
});

describe('chunk assembly', () => {
	it('splits a clause that exceeds the hard limit but keeps its identity', () => {
		// The ceiling exists so no single row becomes an unusable embedding input,
		// so this body is built past it on sentence boundaries.
		const sentence = 'The certificate holder shall ensure this requirement is satisfied before release. ';
		const body = sentence.repeat(90);
		const chunks = segmentIntoClauses(`121.10 Long Section\n${body}`, 'regulation');
		const pieces = chunks.filter(chunk => chunk.clause_id === '121.10');
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.every(piece => piece.clause_id === '121.10')).toBe(true);
		expect(Math.max(...pieces.map(piece => piece.content.length))).toBeLessThanOrEqual(4000);
		// No text may be dropped while splitting.
		const rejoined = pieces.map(piece => piece.content).join(' ');
		expect(rejoined).toContain('The certificate holder shall ensure');
		expect(rejoined.match(/before release\./g)?.length).toBe(90);
	});

	it('caps unnumbered front matter so a table of contents cannot become one huge row', () => {
		const toc = Array.from({ length: 400 }, (_, index) => `121.${index + 1} Section title ${index + 1} .......... ${index}-1`).join('\n');
		const chunks = segmentIntoClauses(`${toc}\n\n121.1000 Real Clause\nBody text.`, 'regulation');
		expect(Math.max(...chunks.map(chunk => chunk.content.length))).toBeLessThanOrEqual(4000);
	});

	it('keeps clauses in separate chunks so no clause number is lost', () => {
		const text = ['121.50 Alpha', 'Short body one.', '121.51 Beta', 'Short body two.'].join('\n');
		const ids = segmentIntoClauses(text, 'regulation').map(chunk => chunk.clause_id).filter(Boolean);
		expect(ids).toContain('121.50');
		expect(ids).toContain('121.51');
	});

	it('loses no text when reassembling stored chunks', () => {
		const raw = [
			{ chunk_index: 2, content: '121.20 Second section body text that is long enough to be prose.' },
			{ chunk_index: 0, content: '121.10 First section body text that is long enough to be prose here.' },
			{ chunk_index: 1, content: 'Continuation of the first section.' },
		];
		const chunks = rebuildChunks(raw, 'regulation');
		const joined = chunks.map(chunk => chunk.content).join(' ');
		expect(joined).toContain('Continuation of the first section.');
		expect(joined).toContain('Second section body text');
		expect(chunks[0].content).toContain('121.10');
	});

	it('assigns sequential chunk indexes starting at zero', () => {
		const text = ['121.30 Alpha', 'body text here that is sufficiently long for prose.', '121.31 Beta', 'more body text that is sufficiently long for prose.'].join('\n');
		segmentIntoClauses(text, 'regulation').forEach((chunk, index) => expect(chunk.chunk_index).toBe(index));
	});

	it('emits preamble before the first clause without a false clause identity', () => {
		const text = ['Operations Manual Part A', 'Issue 07 Revision 00', '7.8.1 Duty Time Limitations', 'Body of the clause.'].join('\n');
		const chunks = segmentIntoClauses(text, 'operations-manual');
		expect(chunks[0].clause_id).toBeNull();
		expect(chunks[0].content).toContain('Operations Manual Part A');
		expect(chunks.find(chunk => chunk.clause_id === '7.8.1')).toBeDefined();
	});
});

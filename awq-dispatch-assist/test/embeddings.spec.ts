import { describe, expect, it, vi } from 'vitest';
import {
	EMBED_BATCH_SIZE,
	EMBEDDING_DIMENSIONS,
	EMBEDDING_MODEL,
	EmbeddingDimensionError,
	embedTexts,
	normaliseEmbeddings,
	vectorMetadata
} from '../src/embeddings';
import { queryTokens } from '../src/retrieval';

/**
 * These tests pin the contracts that fail quietly in production: the vector width
 * accepted by an index whose dimensions cannot be changed, the response shapes the
 * AI binding can return, and the 64-byte limit on indexed Vectorize metadata.
 */

/** Minimal stand-in for the AI binding, so no network call is made. */
function fakeEnv(handler: (model: string, inputs: unknown) => unknown): Env {
	return { AI: { run: (model: string, inputs: unknown) => handler(model, inputs) } } as unknown as Env;
}

function vector(width = EMBEDDING_DIMENSIONS): number[] {
	return Array.from({ length: width }, (_, index) => index / width);
}

describe('embedding batch contract', () => {
	it('returns one vector per input', async () => {
		const env = fakeEnv(() => [vector(), vector()]);
		const result = await embedTexts(env, ['a', 'b']);
		expect(result).toHaveLength(2);
		expect(result[0]).toHaveLength(EMBEDDING_DIMENSIONS);
	});

	it('rejects a count mismatch rather than returning a short list', async () => {
		const env = fakeEnv(() => [vector()]);
		await expect(embedTexts(env, ['a', 'b'])).rejects.toThrow(/1 vectors for 2 inputs/);
	});

	it('rejects a vector whose width does not match the index', async () => {
		const env = fakeEnv(() => [vector(768)]);
		await expect(embedTexts(env, ['a'])).rejects.toBeInstanceOf(EmbeddingDimensionError);
	});

	it('reports the expected and received width in the dimension error', async () => {
		const env = fakeEnv(() => [vector(512)]);
		await expect(embedTexts(env, ['a'])).rejects.toThrow(new RegExp(`512 dimensions but the Vectorize index expects ${EMBEDDING_DIMENSIONS}`));
	});

	it('refuses a batch larger than the configured size', async () => {
		const env = fakeEnv(() => []);
		const texts = Array.from({ length: EMBED_BATCH_SIZE + 1 }, () => 'x');
		await expect(embedTexts(env, texts)).rejects.toThrow(/above the batch size/);
	});

	it('sends the multilingual model and does not silently truncate input', async () => {
		const run = vi.fn(() => [vector()]);
		const env = fakeEnv(run);
		await embedTexts(env, ['runway visual range']);
		const [model, inputs] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
		expect(model).toBe(EMBEDDING_MODEL);
		expect(inputs).toEqual({ text: ['runway visual range'] });
		// Truncation would index part of a clause while citing all of it.
		expect(inputs).not.toHaveProperty('truncate_inputs');
	});

	it('returns an empty list for an empty input without calling the model', async () => {
		const run = vi.fn(() => []);
		const env = fakeEnv(run);
		expect(await embedTexts(env, [])).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});
});

describe('response shape tolerance', () => {
	it('accepts a bare array of vectors', () => {
		expect(normaliseEmbeddings([vector(4), vector(4)])).toHaveLength(2);
	});

	it('accepts the data envelope', () => {
		expect(normaliseEmbeddings({ data: [vector(4)] })).toHaveLength(1);
	});

	it('accepts the response envelope', () => {
		expect(normaliseEmbeddings({ response: [vector(4)] })).toHaveLength(1);
	});

	it('returns nothing for an unrecognised shape instead of a wrong vector', () => {
		expect(normaliseEmbeddings({ unexpected: true } as never)).toEqual([]);
	});
});

describe('vector metadata stays within the Vectorize limit', () => {
	const chunk = {
		id: 12345,
		reference_document_id: 4,
		clause_id: '121.135',
		clause_scheme: 'casr',
		section_title: 'Manual contents',
		content: 'A very long clause body that must not be copied into vector metadata. '.repeat(50)
	};

	it('stores identifiers only, never chunk text', () => {
		const metadata = vectorMetadata(chunk, 2);
		expect(metadata).not.toHaveProperty('content');
		expect(JSON.stringify(metadata)).not.toContain('clause body');
	});

	it('keeps every value within the 64-byte indexed field limit', () => {
		for (const [key, value] of Object.entries(vectorMetadata(chunk, 2))) {
			expect(Buffer.byteLength(String(value), 'utf8'), `${key} exceeds the indexed metadata limit`).toBeLessThanOrEqual(64);
		}
	});

	it('marks clause presence so retrieval can filter citable chunks', () => {
		expect(vectorMetadata(chunk, 2).hasClause).toBe('yes');
		expect(vectorMetadata({ ...chunk, clause_id: null }, 2).hasClause).toBe('no');
	});

	it('records the ingest generation so a stale generation can be filtered out', () => {
		expect(vectorMetadata(chunk, 2).ingestVersion).toBe('2');
	});
});

describe('query tokenisation', () => {
	it('extracts uppercase identifiers of three or more characters', () => {
		const tokens = queryTokens('What does CASR 121.635 require for RVR?');
		expect(tokens).toContain('CASR');
		expect(tokens).toContain('RVR');
	});

	it('keeps dotted clause numbers as single tokens', () => {
		// Clause numbers are the most precise keys in this corpus, so they must
		// survive tokenisation whole rather than being split on the dot.
		expect(queryTokens('Check 4.8.11.1 and 121.635')).toContain('4.8.11.1');
		expect(queryTokens('Check 4.8.11.1 and 121.635')).toContain('121.635');
	});

	it('uppercases input before matching, so prose words are included too', () => {
		// This is intentional: the lexical ranker is a substring matcher and the
		// fusion step discounts common terms. Asserting it here documents the
		// behaviour instead of leaving it to be rediscovered.
		expect(queryTokens('what is the minimum fuel requirement')).toEqual(['WHAT', 'THE', 'MINIMUM', 'FUEL', 'REQUIREMENT']);
	});

	it('deduplicates and caps the token count', () => {
		expect(queryTokens('RVR RVR RVR')).toEqual(['RVR']);
		expect(queryTokens('AAA BBB CCC DDD EEE FFF GGG HHH III JJJ').length).toBeLessThanOrEqual(8);
	});

	it('drops tokens shorter than three characters', () => {
		// Two-letter tokens produce too many spurious substring matches to be useful.
		expect(queryTokens('a of to AB xy')).toEqual([]);
	});

	it('extracts no identifiers from a punctuation-only question', () => {
		expect(queryTokens('??? ...')).toEqual([]);
	});
});

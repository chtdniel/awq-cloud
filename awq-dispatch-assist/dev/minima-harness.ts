/**
 * Development-only minima extraction harness.
 *
 * Why this exists
 *   The production minima extraction path is reachable only through an
 *   authenticated ADMIN session on the deployed Worker. Transcription quality
 *   has to be measured against the real charts before any of it is trusted, and
 *   measuring it through a browser session couples the measurement to the UI.
 *   This module exposes the same two steps — Workers AI markdown conversion and
 *   the DeepSeek extraction call — behind a shared-secret endpoint so the
 *   pipeline can be measured directly.
 *
 * Why it is safe to ship in the repository
 *   It is not part of the production entry point. `src/index.ts` never imports
 *   it; only `dev/dev-entry.ts` does, and that module is deployed as a separate,
 *   temporary Worker (`wrangler.dev.jsonc`). The endpoint refuses to run unless
 *   the `DEV_HARNESS_SECRET` secret is configured and matches the request, so a
 *   deployment of this module without the secret enabled serves 404.
 *
 * It never writes a minima record. It returns what the extractor proposed, which
 * is exactly the material an ADMIN dispatcher would otherwise review in the UI.
 */

import { extractChart, type ChartSource } from '../src/minima-extraction';
import { sha256Hex } from '../src/minima-registry';

export type DevHarnessEnv = {
	DOCUMENTS: R2Bucket;
	AI: Ai;
	DEEPSEEK_API_KEY?: string;
	DEV_HARNESS_SECRET?: string;
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Convert one or more chart PDFs and return the drafts the extractor proposed.
 *
 * `dryRun` is the only mode: nothing is written anywhere.
 */
export async function handleMinimaHarness(request: Request, env: DevHarnessEnv): Promise<Response> {
	const secret = String(env.DEV_HARNESS_SECRET ?? '').trim();
	// Without the secret the harness is inert rather than open.
	if (!secret) return new Response('Not found.', { status: 404 });
	const presented = new URL(request.url).searchParams.get('secret') ?? '';
	if (presented !== secret) return new Response('Not found.', { status: 404 });

	let body: { objectKeys?: unknown; model?: unknown; timeoutMs?: unknown; raw?: unknown };
	try {
		body = await request.json() as typeof body;
	} catch {
		return json({ error: 'A JSON body with objectKeys is required.' }, 400);
	}
	const objectKeys = Array.isArray(body.objectKeys) ? body.objectKeys.map(value => String(value).trim()).filter(Boolean).slice(0, 4) : [];
	if (!objectKeys.length) return json({ error: 'At least one objectKey is required.' }, 400);
	for (const key of objectKeys) {
		if (!key.startsWith('airport/')) return json({ error: 'Only airport/ objects can be converted.' }, 400);
	}

	const model = String(body.model ?? '').trim() || 'deepseek-flash';
	// The harness allows a longer call than production: it exists to measure model
	// behaviour, and a reasoning model can legitimately take longer than the
	// production budget on one chart. A timeout here is a measurement artifact, not
	// a finding about the extractor.
	const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Math.min(300_000, Math.max(10_000, Number(body.timeoutMs))) : 240_000;
	/**
	 * Conversion-only mode, so the two halves of the pipeline can be timed apart.
	 *
	 * Without this a slow run cannot be attributed: the R2 read, the Workers AI
	 * markdown conversion and the model call share one budget, and the only evidence
	 * a failure gives is which timeout ran out. Separating them is what decides
	 * whether the fix is a longer budget or a different pipeline shape.
	 */
	const convertOnly = body.convertOnly === true;
	const outcomes: Array<Record<string, unknown>> = [];

	for (const objectKey of objectKeys) {
		const object = await env.DOCUMENTS.get(objectKey);
		if (!object) {
			outcomes.push({ objectKey, ok: false, reason: 'object-not-found' });
			continue;
		}
		const bytes = new Uint8Array(await object.arrayBuffer());
		const fileName = objectKey.split('/').pop() || objectKey;
		const objectIcao = objectKey.split('/')[1]?.toUpperCase() ?? '';
		const source: ChartSource = {
			objectKey,
			icao: /^[A-Z0-9]{4}$/.test(objectIcao) ? objectIcao : '',
			fileName,
			bytes,
			pdfHash: await sha256Hex(bytes)
		};

		let markdown = '';
		let markdownChars = 0;
		/** Wall-clock spent inside the conversion, reported for both modes. */
		let conversionMs = 0;
		const toMarkdown = async (file: { fileName: string; bytes: Uint8Array }): Promise<string> => {
			const started = Date.now();
			try {
				const converted = await env.AI.toMarkdown({
					name: file.fileName,
					blob: new Blob([file.bytes], { type: 'application/pdf' })
				});
				const result = Array.isArray(converted) ? converted[0] : converted;
				if (!result || result.format === 'error' || typeof result.data !== 'string') {
					throw new Error(result && 'error' in result ? String(result.error) : 'conversion produced no text');
				}
				markdown = result.data;
				markdownChars = result.data.length;
				return result.data;
			} finally {
				conversionMs = Date.now() - started;
			}
		};

		if (convertOnly) {
			const started = Date.now();
			try {
				await toMarkdown(source);
				outcomes.push({ objectKey, ok: true, convertOnly: true, conversionMs, totalMs: Date.now() - started, markdownChars, bytes: bytes.length, markdownHead: markdown.slice(0, 600) });
			} catch (error) {
				const message = error instanceof Error ? error.message : 'conversion failed';
				outcomes.push({ objectKey, ok: false, convertOnly: true, conversionMs, totalMs: Date.now() - started, reason: message.slice(0, 200) });
			}
			continue;
		}

		const extractStarted = Date.now();
		const outcome = await extractChart(source, {
			apiKey: String(env.DEEPSEEK_API_KEY ?? '').trim(),
			model,
			timeoutMs,
			toMarkdown
		});

		if (!outcome.ok) {
			// The converted text is returned even on failure: measuring transcription
			// quality starts with knowing what the converter actually produced, and a
			// chart whose minima table did not survive conversion cannot be fixed by
			// prompting the extractor differently.
			outcomes.push({ objectKey, ok: false, reason: outcome.reason, conversionMs, totalMs: Date.now() - extractStarted, markdownChars, markdown, bytes: bytes.length });
			continue;
		}
		outcomes.push({
			objectKey,
			ok: true,
			bytes: bytes.length,
			conversionMs,
			totalMs: Date.now() - extractStarted,
			markdownChars,
			markdownHead: markdown.slice(0, 1500),
			drafts: outcome.drafts
		});
	}

	return json({ ok: outcomes.every(outcome => outcome.ok === true), model, objects: outcomes });
}

/**
 * Development entry point.
 *
 * Wraps the production Worker with the development-only minima extraction
 * harness, so the real chart-to-draft pipeline can be measured against the real
 * R2 objects and the real DeepSeek credential without going through the UI.
 *
 * This module is never deployed to production: `wrangler.jsonc` points at
 * `src/index.ts`. It exists for `wrangler.dev.jsonc`, which deploys a separate
 * temporary Worker. See dev/minima-harness.ts for why that separation is safe.
 *
 * Everything not handled here falls through to the production Worker unchanged.
 */

import production from '../src/index';
import { handleMinimaHarness, type DevHarnessEnv } from './minima-harness';

export default {
	async fetch(request: Request, env: Env & DevHarnessEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/dev/minima-extract') {
			if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
			return handleMinimaHarness(request, env);
		}
		return production.fetch(request, env, ctx);
	}
} satisfies ExportedHandler<Env & DevHarnessEnv>;

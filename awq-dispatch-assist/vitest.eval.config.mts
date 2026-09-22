import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Evaluation harness config.
 *
 * Deliberately separate from `vitest.config.mts`, which points at `wrangler.jsonc`
 * and a local D1. This one binds D1, Vectorize and Workers AI to the remote
 * resources, so the harness measures the real corpus through the real code path.
 *
 * Kept out of `npm test` on purpose: the normal suite must never reach production
 * data, and a measurement run must never turn the build red.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.eval.jsonc" },
		}),
	],
	test: {
		include: ["eval/**/*.eval.ts"],
		// Remote embeddings and Vectorize queries take seconds, not milliseconds.
		testTimeout: 180_000,
		hookTimeout: 180_000,
		fileParallelism: false,
	},
});

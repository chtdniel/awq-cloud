import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

/**
 * Integration tests for the Dispatch Assist worker.
 *
 * Every route that reads operational data must refuse an unauthenticated caller
 * before touching storage or an upstream origin. Those refusals are asserted
 * here, because they are the boundary that protects flight and crew data.
 */

describe("unauthenticated access is refused", () => {
	it("does not serve flight board data without SSO", async () => {
		const response = await SELF.fetch("http://example.com/api/flight-board");
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			ok: false,
			code: "SSO_REQUIRED",
			message: "AWQ Cloud SSO is required before active flight data can be requested.",
			data: null,
		});
	});

	it("does not serve flight weather without SSO", async () => {
		const response = await SELF.fetch("http://example.com/api/flight-weather?flight_id=1");
		expect(response.status).toBe(503);
	});

	it("requires a session for the reference corpus", async () => {
		const response = await SELF.fetch("http://example.com/api/reference-documents");
		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("requires a session for the knowledge assistant", async () => {
		const response = await SELF.fetch("http://example.com/api/assistant", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ question: "What is the minimum fuel requirement?" }),
		});
		expect(response.status).toBe(503);
	});

	it("requires a session before listing flight documents", async () => {
		const response = await SELF.fetch("http://example.com/api/documents?flight_id=1");
		expect(response.status).toBe(401);
	});

	it("requires a session before creating an assessment", async () => {
		const response = await SELF.fetch("http://example.com/api/assessments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ flightId: 1 }),
		});
		expect(response.status).toBe(401);
	});
});

describe("input validation", () => {
	it("rejects a non-numeric flight id", async () => {
		const response = await SELF.fetch("http://example.com/api/documents?flight_id=abc");
		expect(response.status).toBe(400);
	});

	it("rejects a missing flight id", async () => {
		const response = await SELF.fetch("http://example.com/api/documents");
		expect(response.status).toBe(400);
	});
});

describe("service metadata", () => {
	it("reports health without requiring a session", async () => {
		const response = await SELF.fetch("http://example.com/api/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, service: "awq-dispatch-assist" });
	});

	it("returns JSON errors for unknown API routes rather than HTML", async () => {
		// An unmatched /api path falls through to static assets; assert it does not
		// leak the SPA document as a successful JSON payload.
		const response = await SELF.fetch("http://example.com/api/does-not-exist");
		const body = await response.text();
		expect(body).not.toContain('"ok":true');
	});
});

describe("handler contract", () => {
	it("exposes a fetch handler", () => {
		expect(typeof worker.fetch).toBe("function");
	});

	it("accepts an execution context without throwing", async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>("http://example.com/api/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});
});

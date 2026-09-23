/**
 * NOTAM selection from AWQ Cloud.
 *
 * Where the data lives
 *   AWQ Cloud stores its NOTAM feed in the same D1 database this Worker binds as
 *   `DB`, in the `notams` table (`id`, `location`, `message`, `valid_from`,
 *   `valid_to`, `risk_level`, `is_active`, `kind`). Reading it through the binding
 *   rather than over HTTP keeps the selection on the same authenticated origin as
 *   the rest of the assessment and avoids a second credential.
 *
 * What this module is not allowed to do
 *   It never writes. The NOTAM feed is another product's data, so this Worker only
 *   reads it. Nothing here deletes or edits a NOTAM row.
 *
 * The selection is manual by design
 *   PRD §9 has the dispatcher choose the relevant NOTAM. The list is filtered by
 *   aerodrome and by validity overlap, so what is offered is what could apply to
 *   the flight, and the dispatcher still decides which of those to attach. An
 *   empty selection is `NOTAM REVIEW PENDING`, which the assessment must show
 *   rather than treating it as a clean check.
 */

import type { SelectedNotam } from './dispatch';

export type NotamCandidate = {
	id: string;
	location: string;
	message: string;
	validFrom: string | null;
	validTo: string | null;
	riskLevel: string | null;
	kind: string | null;
};

/**
 * One NOTAM row as stored.
 *
 * `message` carries the whole NOTAM block including its `Q)` and `E)` sections,
 * so the dispatcher sees the raw text that a keyword scan is applied to.
 */
type NotamRow = {
	id: string;
	location: string;
	message: string;
	valid_from: string | null;
	valid_to: string | null;
	risk_level: string | null;
	kind: string | null;
};

/** How far outside a window a NOTAM is still offered, in hours. */
const VALIDITY_TOLERANCE_HOURS = 3;

/**
 * NOTAM for the given aerodromes whose validity can overlap the flight windows.
 *
 * A NOTAM with no `valid_to` is permanent until superseded, so it is always
 * offered. A NOTAM with no `valid_from` is offered too: an unreadable start is a
 * reason to show it, not to hide it.
 */
export async function listNotamCandidates(
	env: Env,
	locations: readonly string[],
	windowFrom: Date,
	windowTo: Date
): Promise<NotamCandidate[]> {
	const stations = [...new Set(locations.map(value => String(value ?? '').trim().toUpperCase()).filter(value => /^[A-Z0-9]{4}$/.test(value)))];
	if (!stations.length) return [];

	const placeholders = stations.map(() => '?').join(', ');
	const from = new Date(windowFrom.getTime() - VALIDITY_TOLERANCE_HOURS * 3_600_000).toISOString();
	const to = new Date(windowTo.getTime() + VALIDITY_TOLERANCE_HOURS * 3_600_000).toISOString();

	const { results } = await env.DB.prepare(
		`SELECT id, location, message, valid_from, valid_to, risk_level, kind
		   FROM notams
		  WHERE is_active = 1
		    AND location IN (${placeholders})
		    AND (valid_from IS NULL OR valid_from <= ?)
		    AND (valid_to IS NULL OR valid_to >= ?)
		  ORDER BY location ASC, valid_from ASC`
	)
		.bind(...stations, to, from)
		.all<NotamRow>();

	return (results || []).map(row => ({
		id: String(row.id),
		location: String(row.location).toUpperCase(),
		message: String(row.message ?? ''),
		validFrom: row.valid_from,
		validTo: row.valid_to,
		riskLevel: row.risk_level,
		kind: row.kind
	}));
}

/**
 * Resolve the dispatcher's selection back to stored NOTAM rows.
 *
 * The client sends identifiers only. Reading the text back from the database
 * means a snapshot records the NOTAM as it actually is, and a tampered or stale
 * client cannot introduce NOTAM text that was never published. Identifiers that
 * no longer exist are reported rather than silently dropped, because a selection
 * that lost a member is a different review than the one the dispatcher made.
 */
export async function resolveSelectedNotams(
	env: Env,
	ids: readonly string[],
	locations: readonly string[]
): Promise<{ selected: SelectedNotam[]; missing: string[] }> {
	const wanted = [...new Set(ids.map(value => String(value ?? '').trim()).filter(Boolean))].slice(0, 50);
	if (!wanted.length) return { selected: [], missing: [] };

	const allowed = new Set(locations.map(value => String(value ?? '').trim().toUpperCase()));
	const placeholders = wanted.map(() => '?').join(', ');
	const { results } = await env.DB.prepare(
		`SELECT id, location, message, valid_from, valid_to, risk_level FROM notams WHERE id IN (${placeholders})`
	)
		.bind(...wanted)
		.all<NotamRow>();

	const fetchedAt = new Date().toISOString();
	const found = new Map((results || []).map(row => [String(row.id), row]));
	const selected: SelectedNotam[] = [];
	const missing: string[] = [];

	for (const id of wanted) {
		const row = found.get(id);
		if (!row) {
			missing.push(id);
			continue;
		}
		const location = String(row.location).toUpperCase();
		if (allowed.size && !allowed.has(location)) {
			// A NOTAM for an aerodrome this flight does not use is not evidence about
			// this flight, so it is rejected rather than attached.
			missing.push(id);
			continue;
		}
		selected.push({
			id,
			location,
			message: String(row.message ?? ''),
			validFrom: row.valid_from,
			validTo: row.valid_to,
			riskLevel: row.risk_level,
			fetchedAt
		});
	}

	return { selected, missing };
}

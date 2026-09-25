import { fetchLatestTafs, tafStationsFromFlights } from '../../shared/taf.mjs';
import { fetchWxWarnings, toWarningRow, WX_WARNING_UPSERT, warningBindValues } from '../../shared/wxwarning.mjs';
// ============================================================================
// AWQ BACKGROUND CRON WORKER
//
// Two schedules, one worker:
//   */30 * * * *  -> live TAFs (this is the original job, unchanged)
//   0 */4 * * *   -> WX WARNING feed: JTWC tropical-cyclone warnings, VAAC
//                    volcanic-ash advisories and VA/TC SIGMET polygons
//
// The WX WARNING page never scrapes anything itself: it reads D1, and this job
// is the only thing that talks to the outside world. That keeps the page fast,
// immune to CORS, and means one set of outbound requests per 4 hours instead of
// one per operator per page view.
// ============================================================================

const WX_WARNING_CRON = '0 */4 * * *';

export default {
    async scheduled(event, env, ctx) {
        if (event.cron === WX_WARNING_CRON) ctx.waitUntil(refreshWxWarnings(env));
        else ctx.waitUntil(refreshTafs(env));
    },

    async fetch(request, env, ctx) {
        const job = new URL(request.url).searchParams.get('job');
        if (job === 'wx-warnings') return json(await refreshWxWarnings(env));
        if (job === 'tafs') return json(await refreshTafs(env));
        const result = await refreshTafs(env);
        return json(result);
    }
};

function json(payload) {
    return new Response(JSON.stringify(payload, null, 2), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function refreshTafs(env) {
    try {
        if (!env.DB) return { error: 'DB binding not available' };

        const { results: flightRows } = await env.DB.prepare(
            'SELECT callsign, dep, dest, alt FROM flights'
        ).all();
        let airportRows = [];
        try {
            ({ results: airportRows } = await env.DB.prepare(
                'SELECT DISTINCT airport_icao, fir_code FROM airport_firs'
            ).all());
        } catch (error) {
            console.warn('airport_firs mapping unavailable; refreshing all valid flight stations:', error.message);
        }
        const firCodes = (airportRows || [])
            .filter(row => row.airport_icao && row.fir_code && row.airport_icao !== row.fir_code)
            .map(row => row.fir_code);
        const stations = tafStationsFromFlights(flightRows || [], { excludedStations: firCodes });

        if (stations.length === 0) return { status: 'NO_STATIONS' };

        const tafMap = await fetchLatestTafs(stations);

        const now = new Date().toISOString();
        const stmts = [];
        for (const st of stations) {
            const raw = tafMap[st] || `TAF ${st} NIL=`;
            stmts.push(
                env.DB.prepare(
                    'INSERT INTO tafs (station, raw_text, issue_time) VALUES (?, ?, ?) ON CONFLICT(station) DO UPDATE SET raw_text=excluded.raw_text, issue_time=excluded.issue_time'
                ).bind(st, raw, now)
            );
        }

        if (stmts.length > 0) {
            await env.DB.batch(stmts);
        }

        return {
            status: 'SUCCESS',
            refreshedCount: stations.length,
            withDataCount: Object.keys(tafMap).length,
            timestamp: now
        };
    } catch (e) {
        return { error: e.message };
    }
}

async function refreshWxWarnings(env) {
    try {
        if (!env.DB) return { error: 'DB binding not available' };
        const started = new Date();
        const { warnings, sources, problems } = await fetchWxWarnings({ now: started });

        const statements = warnings.map(warning =>
            env.DB.prepare(WX_WARNING_UPSERT).bind(...warningBindValues(toWarningRow(warning, { fetchedAt: started })))
        );
        if (statements.length) await env.DB.batch(statements);

        // Anything ingested earlier but absent from this cycle is over: the storm
        // dissipated or the advisory was cancelled. Manual rows are untouched.
        const purged = await env.DB.prepare(
            'DELETE FROM wx_warnings WHERE is_manual = 0 AND (fetched_at IS NULL OR fetched_at < ?)'
        ).bind(started.toISOString()).run();

        // Operator pastes age out after 7 days; a briefing must never quote a
        // week-old pasted product as current.
        const manualPurged = await env.DB.prepare(
            "DELETE FROM wx_warnings WHERE is_manual = 1 AND created_at < datetime('now','-7 days')"
        ).run();

        return {
            status: 'SUCCESS',
            ingested: statements.length,
            purged: writeChanges(purged),
            manualPurged: writeChanges(manualPurged),
            sources,
            problems,
            timestamp: started.toISOString()
        };
    } catch (e) {
        return { error: e.message };
    }
}

// D1 answers `{ meta: { changes } }`; the local harness answers `{ changes }`.
function writeChanges(result) {
    if (!result) return null;
    if (result.meta && typeof result.meta.changes === 'number') return result.meta.changes;
    if (typeof result.changes === 'number') return result.changes;
    return null;
}

import { fetchLatestTafs } from '../../shared/taf.mjs';
// ============================================================================
// AWQ BACKGROUND CRON WORKER
// Triggered every 30 minutes to fetch live TAFs and update Cloudflare D1
// ============================================================================

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(refreshTafs(env));
    },

    async fetch(request, env, ctx) {
        const result = await refreshTafs(env);
        return new Response(JSON.stringify(result, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
};

async function refreshTafs(env) {
    try {
        if (!env.DB) return { error: 'DB binding not available' };

        const { results: stationsRows } = await env.DB.prepare(
            'SELECT DISTINCT dep as st FROM flights UNION SELECT DISTINCT dest as st FROM flights UNION SELECT DISTINCT alt as st FROM flights'
        ).all();

        const stations = (stationsRows || [])
            .map(r => String(r.st || '').trim().toUpperCase())
            .filter(s => /^[A-Z]{4}$/.test(s));

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

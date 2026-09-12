// ============================================================================
// CLOUDFLARE PAGES CRON / REFRESH WORKER ENDPOINT
// Fetches live TAF data for all active flight stations and updates D1
// ============================================================================

export async function onRequest(context) {
    try {
        if (!context.env.DB) {
            return Response.json({ error: 'DB binding not found' }, { status: 500 });
        }

        // 1. Fetch stations from DB
        const { results: stationsRows } = await context.env.DB.prepare(
            'SELECT DISTINCT dep as st FROM flights UNION SELECT DISTINCT dest as st FROM flights UNION SELECT DISTINCT alt as st FROM flights'
        ).all();
        
        const stations = (stationsRows || [])
            .map(r => String(r.st || '').trim().toUpperCase())
            .filter(s => /^[A-Z]{4}$/.test(s));

        if (stations.length === 0) {
            return Response.json({ status: 'NO_STATIONS', count: 0 });
        }

        // 2. Fetch live TAFs from NOAA API
        const url = `https://aviationweather.gov/api/data/taf?ids=${stations.join(',')}&format=raw`;
        const res = await fetch(url);
        if (!res.ok) {
            return Response.json({ status: 'API_ERROR', httpStatus: res.status }, { status: 502 });
        }

        const text = await res.text();
        const tafMap = {};
        const blocks = text.split(/(?=\bTAF\s)/);
        blocks.forEach(block => {
            const bTrim = block.trim();
            if (!bTrim) return;
            const m = bTrim.match(/^TAF\s+(?:AMD\s+|COR\s+)?([A-Z]{4})/i);
            if (m) tafMap[m[1].toUpperCase()] = bTrim;
        });

        // 3. Batch upsert into D1 tafs table
        const now = new Date().toISOString();
        const stmts = [];
        for (const st of stations) {
            const raw = tafMap[st] || `TAF ${st} NIL=`;
            stmts.push(
                context.env.DB.prepare(
                    'INSERT INTO tafs (station, raw_text, issue_time) VALUES (?, ?, ?) ON CONFLICT(station) DO UPDATE SET raw_text=excluded.raw_text, issue_time=excluded.issue_time'
                ).bind(st, raw, now)
            );
        }

        if (stmts.length > 0) {
            await context.env.DB.batch(stmts);
        }

        return Response.json({
            status: 'SUCCESS',
            refreshedCount: stations.length,
            withDataCount: Object.keys(tafMap).length,
            timestamp: now
        });
    } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
    }
}

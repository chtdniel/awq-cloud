import { fetchLatestTafs, tafStationsFromFlights } from '../../shared/taf.mjs';
// ============================================================================
// CLOUDFLARE PAGES CRON / REFRESH WORKER ENDPOINT
// Fetches live TAF data for all active flight stations and updates D1
// ============================================================================

export async function onRequest(context) {
    try {
        if (!context.env.DB) {
            return Response.json({ error: 'DB binding not found' }, { status: 500 });
        }

        const { results: flightRows } = await context.env.DB.prepare(
            'SELECT callsign, dep, dest, alt FROM flights'
        ).all();
        let airportRows = [];
        try {
            ({ results: airportRows } = await context.env.DB.prepare(
                'SELECT DISTINCT airport_icao, fir_code FROM airport_firs'
            ).all());
        } catch (error) {
            console.warn('airport_firs mapping unavailable; refreshing all valid flight stations:', error.message);
        }
        const firCodes = (airportRows || [])
            .filter(row => row.airport_icao && row.fir_code && row.airport_icao !== row.fir_code)
            .map(row => row.fir_code);
        const stations = tafStationsFromFlights(flightRows || [], { excludedStations: firCodes });

        if (stations.length === 0) {
            return Response.json({ status: 'NO_STATIONS', count: 0 });
        }

        // 2. Fetch ADDS TAFs with regional fallbacks
        const tafMap = await fetchLatestTafs(stations);

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

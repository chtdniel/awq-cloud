// ============================================================================
// OPERATIONAL FLIGHT BRIEFING PACKAGE (OFBP)
// Printable Airline Dispatch Release for FOO & Flight Crew
// ============================================================================

import { newestTafRows } from '../shared/wxtime.mjs';

export async function onRequest(context) {
    try {
        const url = new URL(context.request.url);
        const flightParam = url.searchParams.get('flights') || '';
        const flightList = flightParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

        if (flightList.length === 0) {
            return new Response('<h1>Error: No flight callsigns specified.</h1><p>Usage: /briefing?flights=QZ646,QZ647</p>', {
                headers: { 'Content-Type': 'text/html' },
                status: 400
            });
        }

        // Fetch flights from D1
        const placeholders = flightList.map(() => '?').join(',');
        const { results: flights } = await context.env.DB.prepare(
            `SELECT * FROM flights WHERE callsign IN (${placeholders}) OR id IN (${placeholders})`
        ).bind(...flightList, ...flightList).all();

        if (!flights || flights.length === 0) {
            return new Response('<h1>Error: Specified flights not found in database.</h1>', {
                headers: { 'Content-Type': 'text/html' },
                status: 404
            });
        }

        // Fetch all routes, tafs, and latlong
        const { results: routes } = await context.env.DB.prepare('SELECT * FROM routes').all();
        const { results: tafRows } = await context.env.DB.prepare('SELECT * FROM tafs').all();
        const tafMap = {};
        // Newest issue_time per station wins — the table accumulates rows.
        newestTafRows(tafRows).forEach(t => {
            tafMap[String(t.station).toUpperCase()] = t.raw_text;
        });

        const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 16) + 'Z';
        
        // Helper to format time as HH:MM
        function compactTime(value) {
            if (value === null || value === undefined) return '';
            const s = String(value).trim();
            if (!s) return '';
            const pad = (n) => (String(n).length < 2 ? '0' + n : String(n));
            const withColon = s.match(/(\d{1,2}):(\d{2})/);
            if (withColon) return pad(withColon[1]) + ':' + withColon[2];
            const digits = s.replace(/[^0-9]/g, '');
            if (digits.length === 4) return digits.slice(0, 2) + ':' + digits.slice(2);
            if (digits.length === 6) return digits.slice(2, 4) + ':' + digits.slice(4);
            if (digits.length >= 8) return digits.slice(8, 10) + ':' + digits.slice(10, 12);
            return s;
        }

        // Render HTML Document
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OFBP - ${flights.map(f => f.callsign).join('_')} - ${nowUtc}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="alternate icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <style>
        :root {
            --primary: #0f172a;
            --accent: #dc2626;
            --border: #cbd5e1;
            --bg-muted: #f8fafc;
        }
        body {
            font-family: 'Courier New', Courier, monospace;
            background: #e2e8f0;
            color: #1e293b;
            margin: 0;
            padding: 24px;
            font-size: 13px;
            line-height: 1.4;
        }
        .container {
            max-width: 960px;
            margin: 0 auto;
            background: #ffffff;
            padding: 32px;
            border-radius: 4px;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid var(--primary);
            padding-bottom: 16px;
            margin-bottom: 20px;
        }
        .logo-title h1 {
            margin: 0;
            font-size: 20px;
            font-weight: 900;
            letter-spacing: 1px;
            color: var(--accent);
        }
        .logo-title p {
            margin: 4px 0 0 0;
            font-size: 11px;
            color: #64748b;
            font-weight: bold;
        }
        .actions {
            display: flex;
            gap: 10px;
        }
        .btn {
            background: var(--primary);
            color: #fff;
            border: none;
            padding: 8px 16px;
            font-size: 12px;
            font-weight: bold;
            font-family: inherit;
            cursor: pointer;
            border-radius: 4px;
        }
        .btn:hover { background: #1e293b; }
        .section-title {
            background: var(--bg-muted);
            border-left: 4px solid var(--primary);
            padding: 6px 10px;
            font-size: 12px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 24px;
            margin-bottom: 12px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 16px;
        }
        th, td {
            border: 1px solid var(--border);
            padding: 8px 10px;
            text-align: left;
        }
        th {
            background: var(--bg-muted);
            font-weight: bold;
            font-size: 11px;
        }
        .wx-box {
            background: #f1f5f9;
            border: 1px solid var(--border);
            padding: 10px 12px;
            margin-bottom: 12px;
            white-space: pre-wrap;
            font-size: 12px;
            border-radius: 2px;
        }
        .station-code {
            font-weight: bold;
            color: var(--accent);
        }
        .signatures {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-top: 36px;
            padding-top: 20px;
            border-top: 2px dashed var(--border);
        }
        .sign-box {
            border: 1px solid var(--border);
            padding: 16px;
            min-height: 80px;
            position: relative;
        }
        .sign-title {
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            color: #475569;
            margin-bottom: 40px;
        }
        .sign-line {
            border-bottom: 1px solid #94a3b8;
            padding-bottom: 4px;
            display: flex;
            justify-content: space-between;
            font-size: 11px;
        }
        @media print {
            body { background: #fff; padding: 0; }
            .container { box-shadow: none; padding: 0; width: 100%; max-width: 100%; }
            .actions { display: none !important; }
            .page-break { page-break-after: always; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo-title">
                <h1>AIRASIA // OCC BRIEFING PACKAGE</h1>
                <p>OPERATIONAL FLIGHT RELEASE & CREW BRIEFING · DISPATCH RELEASE (DXR)</p>
            </div>
            <div class="actions">
                <button class="btn" onclick="window.print()">🖨️ PRINT / PDF RELEASE</button>
            </div>
        </div>

        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:16px; color:#475569;">
            <div><strong>GENERATED AT:</strong> ${nowUtc}</div>
            <div><strong>TOTAL LEGS:</strong> ${flights.length} SECTOR(S)</div>
            <div><strong>AUTHORITY:</strong> AIRLINE DISPATCH CONTROL</div>
        </div>

        ${flights.map((f, idx) => {
            const fDep = String(f.dep || '').toUpperCase();
            const fDest = String(f.dest || '').toUpperCase();
            const fAlt = String(f.alt || '').toUpperCase();
            const activeRoute = routes.find(r => 
                (f.active_route_id && String(r.id).toUpperCase() === String(f.active_route_id).toUpperCase()) ||
                (String(r.dep_airport).toUpperCase() === fDep && String(r.arr_airport).toUpperCase() === fDest)
            );
            const routeStr = activeRoute ? (activeRoute.route_string || activeRoute.waypoint_seq || 'DIRECT') : 'STANDARD COMPANY ROUTING';
            const tafDep = tafMap[fDep] || 'NIL TAF DATA IN DATABASE';
            const tafDest = tafMap[fDest] || 'NIL TAF DATA IN DATABASE';
            const tafAlt = fAlt ? (tafMap[fAlt] || 'NIL TAF DATA IN DATABASE') : 'NONE SPECIFIED';

            return `
            <div style="margin-bottom: 32px; border-bottom: 1px solid #e2e8f0; padding-bottom: 24px;">
                <div class="section-title">SECTOR ${idx + 1}: ${f.callsign} · ${fDep} ➔ ${fDest}</div>
                <table>
                    <thead>
                        <tr>
                            <th>FLIGHT NO</th>
                            <th>DOF</th>
                            <th>AC TYPE</th>
                            <th>DEP / STD</th>
                            <th>DEST / STA</th>
                            <th>ALTN</th>
                            <th>CRZ FL</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><strong>${f.callsign}</strong></td>
                            <td>${f.dof || '-'}</td>
                            <td>${f.ac_type || '-'}</td>
                            <td><strong>${fDep}</strong> / ${compactTime(f.etd) || '-'}Z</td>
                            <td><strong>${fDest}</strong> / ${compactTime(f.eta) || '-'}Z</td>
                            <td><strong>${fAlt || '-'}</strong></td>
                            <td>${f.alt || 'FL340'}</td>
                        </tr>
                    </tbody>
                </table>

                <div style="margin: 12px 0;">
                    <strong>FILED OPERATIONAL ROUTE:</strong>
                    <div style="background:#f8fafc; padding:8px 10px; border:1px solid #e2e8f0; margin-top:4px; font-size:12px;">
                        ${routeStr}
                    </div>
                </div>

                <div class="section-title" style="margin-top:16px;">TERMINAL AERODROME FORECAST (TAF)</div>
                <div class="wx-box"><span class="station-code">${fDep}:</span> ${tafDep}</div>
                <div class="wx-box"><span class="station-code">${fDest}:</span> ${tafDest}</div>
                ${fAlt ? `<div class="wx-box"><span class="station-code">${fAlt} (ALTN):</span> ${tafAlt}</div>` : ''}
            </div>
            `;
        }).join('')}

        <div class="signatures">
            <div class="sign-box">
                <div class="sign-title">DISPATCHER (FOO) RELEASE SIGN-OFF</div>
                <div class="sign-line">
                    <span>NAME / LIC: ___________________</span>
                    <span>SIGN: ___________________</span>
                </div>
            </div>
            <div class="sign-box">
                <div class="sign-title">PILOT-IN-COMMAND (PIC) ACCEPTANCE</div>
                <div class="sign-line">
                    <span>NAME: _______________________</span>
                    <span>SIGN: ___________________</span>
                </div>
            </div>
        </div>

        <div style="text-align:center; font-size:10px; color:#94a3b8; margin-top:24px;">
            AWQ-CLOUD FLIGHT OPERATIONS SYSTEM · ALL RIGHTS RESERVED
        </div>
    </div>
</body>
</html>`;

        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    } catch (e) {
        return new Response('<h1>Internal Error: ' + e.message + '</h1>', {
            headers: { 'Content-Type': 'text/html' },
            status: 500
        });
    }
}

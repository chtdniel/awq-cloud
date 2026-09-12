DROP TABLE IF EXISTS routes;
CREATE TABLE routes (
    id TEXT PRIMARY KEY,
    dep_airport TEXT NOT NULL,
    arr_airport TEXT NOT NULL,
    dep_rwy TEXT,
    sid TEXT,
    waypoint_seq TEXT,
    star TEXT,
    arr_rwy TEXT,
    route_string TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WADDWIII10', 'WADD', 'WIII', '09', 'OKANG2B', 'OKANG T4 FARIZ T6 KURUS', 'KURUS2E', '07L', 'WADD RWY-09 OKANG2B OKANG T4 FARIZ T6 KURUS KURUS2E RWY-07L WIII');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WIIIWADD10', 'WIII', 'WADD', '25R', 'CA2D', 'CA T3 MOVMO', 'MOVMO2D', '27', 'WIII RWY-25R CA2D CA T3 MOVMO MOVMO2D RWY-27 WADD');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WADDYPPH10', 'WADD', 'YPPH', '27', 'LIPRA2B', 'LIPRA G578 EGATU L514 AVPAL Q38 JULIM', 'JULIM8A', '06', 'WADD RWY-27 LIPRA2B LIPRA G578 EGATU L514 AVPAL Q38 JULIM JULIM8A RWY-6 YPPH');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('YPPHWADD10', 'YPPH', 'WADD', '21', 'AVNEX5', 'AVNEX DCT ESDEG Q587 METUM R592 GIWOT', 'GIWOT2C', '09', 'YPPH RWY-21 AVNEX5 AVNEX DCT ESDEG Q587 METUM R592 GIWOT GIWOT2C RWY-09 WADD');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WADDWATO10', 'WADD', 'WATO', '27', 'TEPOS2B', 'TEPOS DCT NMA DCT HUMAI', 'HUMAI2A', '17', 'WADD RWY-27 TEPOS2B TEPOS DCT NMA DCT HUMAI HUMAI2A RWY-17 WATO');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WATOWADD10', 'WATO', 'WADD', '35', 'TOGEM1A', 'TOGEM DCT NMA DCT SASAX', 'SASAX2L', '09', 'WATO RWY-35 TOGEM1A TOGEM DCT NMA DCT SASAX SASAX2L RWY-09 WADD');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WADDVTSP10', 'WADD', 'VTSP', '09', 'UDONO2A', 'UDONO M635 VTK B338 VMR B469 VPK M751 VKB A334 HTY W14 EPGOT', 'EPGOT1C', '09', 'WADD RWY-09 UDONO2A   UDONO M635 VTK B338 VMR B469 VPK M751 VKB A334 HTY W14 EPGOT EPGOT1C  RWY-09 VTSP');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('VTSPWADD10', 'VTSP', 'WADD', '27', 'REBED1B', 'REBED B579 VPL Y509 ANGUN Y508 NIREN M630 BOBAG P501 ANITO B470 PKP L511 SBR W33 MOVMO', 'MOVMO2D', '27', 'VTSP RWY-27 REBED1B  REBED B579 VPL Y509 ANGUN Y508 NIREN M630 BOBAG P501 ANITO B470 PKP L511 SBR W33 MOVMO MOVMO2D  RWY-27 WADD');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WIIIWADD11', 'WIII', 'WADD', '25R', 'CA2D', 'CA T3 BA DCT SBR W33 MOVMO', 'MOVMO', '27', 'WIII RWY-25R CA2D CA T3 BA DCT SBR W33 MOVMO MOVMO RWY-27 WADD');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WIIIWADD12', 'WIII', 'WADD', '25R', 'CA2D', 'CA T3 BA DCT SBR W33 MOVMO', 'MOVMO2D', '27', 'WIII RWY-25R  CA2D  CA T3 BA DCT SBR W33 MOVMO MOVMO2D  RWY-27 WADD');
INSERT OR REPLACE INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES ('WADDYPPH11', 'WADD', 'YPPH', '27', 'NYOMA1B', 'NYOMA G326 ONOXA DCT 1454S12027E DCT ISKAN DCT OSOTO L514 AVPAL Q38 JULIM', 'JULIM6A', '06', 'WADD RWY-27 NYOMA1B NYOMA G326 ONOXA DCT 1454S12027E DCT ISKAN DCT OSOTO L514 AVPAL Q38 JULIM JULIM6A RWY-06 YPPH');
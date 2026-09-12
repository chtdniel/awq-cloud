/**
 * Schema.gs
 * Defines and initializes the real database schemas in Cloudflare D1.
 */

function setupD1Schema() {
  Logger.log("Starting Schema Setup in D1...");

  var schemas = [
    // 1. FLIGHTS TABLE
    `CREATE TABLE IF NOT EXISTS flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      callsign TEXT NOT NULL,
      ac_type TEXT,
      dep TEXT NOT NULL,
      dest TEXT NOT NULL,
      route TEXT,
      etd DATETIME,
      eta DATETIME,
      status TEXT,
      remarks TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // 2. NOTAM TABLE
    `CREATE TABLE IF NOT EXISTS notams (
      id TEXT PRIMARY KEY,
      location TEXT NOT NULL,
      notam_code TEXT,
      message TEXT NOT NULL,
      valid_from DATETIME,
      valid_to DATETIME,
      risk_level TEXT,
      is_active BOOLEAN DEFAULT 1,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // 3. LATLONG / WAYPOINT TABLE
    `CREATE TABLE IF NOT EXISTS latlong (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waypoint_name TEXT UNIQUE NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      fir TEXT,
      description TEXT
    );`
  ];

  for (var i = 0; i < schemas.length; i++) {
    Logger.log("Executing Table Schema " + (i + 1) + "...");
    try {
      var result = D1Helper.run(schemas[i]);
      Logger.log("Success: " + JSON.stringify(result));
    } catch (e) {
      Logger.log("Error creating schema " + (i + 1) + ": " + e.toString());
    }
  }
  
  Logger.log("Schema Setup Completed.");
}

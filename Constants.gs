/**
 * Constants.gs
 * Centralized constants used across the AWQ Dashboard project.
 */

// FIR risk classification
var FIR_HIGH_RISK_Q = ['QCSAS', 'QCAAS', 'QAXCH', 'QWMLW', 'QWCLW'];
var FIR_MED_RISK_Q = ['QWULW', 'QRALW', 'QWELW', 'QWPLW'];

// FIR NOTAM cache
var FIR_NOTAM_CACHE_KEY = 'fir_notam_editor_v1';
var FIR_NOTAM_CACHE_TTL = 30;

// Cache TTL in seconds
var CACHE_TTL_FIR_PARITY = 300;       // flights/routes/notams cache
var CACHE_TTL_ACTIVE_NOTAMS = 300;    // active notams map cache
var CACHE_TTL_FIR_NOTAM_EDITOR = 30;  // FIR NOTAM editor cache
var CACHE_TTL_LATLONG = 30;           // LATLONG editor cache
var CACHE_TTL_FLIGHT_DASHBOARD = 60;  // flight dashboard cache

// Lock service timeouts (ms)
var LOCK_TIMEOUT_OVERWRITE_NOTAM = 30000;
var LOCK_TIMEOUT_FIR_NOTAM_WRITE = 10000;
var LOCK_TIMEOUT_FIR_BULK_IMPORT = 15000;
var LOCK_TIMEOUT_SAVE_FLIGHT_EDIT = 30000;

// FIR parity constants
var FIR_CACHE_KEY_FLIGHTS_ROUTES = 'flights_routes_spreadsheet_v2';
var FIR_CACHE_KEY_ANALYZE_DATASET = 'analyze_dataset_v1';
var FIR_CACHE_KEY_ACTIVE_NOTAMS_V1 = 'active_notams_map_v1';
var FIR_CACHE_KEY_ACTIVE_NOTAMS_V2 = 'active_notams_map_v2';
var FIR_CACHE_KEY_ACTIVE_NOTAMS_V3 = 'active_notams_map_v3';
var FIR_CACHE_KEY_NOTAM_EDITOR = 'fir_notam_editor_v1';
var FIR_CACHE_KEY_LATLONG_EDITOR = 'latlong_editor_v1';
var FIR_CACHE_KEY_FLIGHT_DASHBOARD = 'flight_dashboard_v2';

// FIR NOTAM column count
var FIR_NOTAM_COLS = 7;

// Sheet names (centralized to avoid typos)
var SHEET_FLT_INFO = 'FLT INFO';
var SHEET_NOTAM = 'NOTAM';
var SHEET_FIR = 'FIR';
var SHEET_ROUTE = 'Route';
var SHEET_LATLONG = 'LATLONG';
var SHEET_TAF = 'TAF';
var SHEET_NOTAM_HISTORY = 'NOTAM_HISTORY';
var SHEET_AIRPORT_TIMEZONE = 'AIRPORT_TIMEZONE';
var SHEET_AC = 'AC';
var SHEET_AIRPORT_NOTES = 'AIRPORT_NOTES';
var SHEET_AIRPORT_FIR = 'AIRPORT_FIR';

// Airport -> FIR mapping cache (B-strategy, FIR mapping)
var CACHE_TTL_AIRPORT_FIR = 300;
var FIR_CACHE_KEY_AIRPORT_FIR = 'airport_fir_map_v1';

// Route polyline cache (geospatial indirect impact, Fase 3)
var FIR_CACHE_KEY_ROUTE_POLYLINE = 'route_polyline_map_v1';
var CACHE_TTL_ROUTE_POLYLINE = 300;

// Operational Readiness freshness — default 6 hours (360 minutes)
// Operations/Safety approval required before production — default 6h
var OPERATIONAL_READINESS_NOTAM_MAX_AGE_MINUTES = 360;
var OPERATIONAL_READINESS_TAF_MAX_AGE_MINUTES = 360;

// Script property keys
var PROP_SPREADSHEET_ID = 'spreadsheetId';
var PROP_OCC_ALLOWED_EMAILS = 'OCC_ALLOWED_EMAILS';
var PROP_OCC_FIR_LINK = 'OCC_FIR_LINK';
var PROP_FIR_FLT_INFO_SHEET = 'FIR_FLT_INFO_SHEET';
var PROP_OCC_NOTAM_STATE = 'occ_notam_state';

// WX S2+S1 — sheet-driven weather rules (TEST only, Fase 1 tanpa AI)
var SHEET_WX_RULES = 'WX_RULES';
var SHEET_WX_MANUAL_EXCERPT = 'WX_MANUAL_EXCERPT';
var FIR_CACHE_KEY_WX_RULES = 'wx_rules_v1';
var FIR_CACHE_KEY_WX_MANUAL = 'wx_manual_v1';
var PROP_USE_WX_RULES = 'USE_WX_RULES';
var PROP_WX_TEST_SHEET_ID = 'WX_TEST_SHEET_ID';

// WX Fase 2 AI (TEST only). Key NEVER hardcoded: set GEMINI_API_KEY once via
// Project Settings > Script Properties. Free-tier model; temperature fixed 0.
var PROP_GEMINI_API_KEY = 'GEMINI_API_KEY';
var PROP_WX_GEMINI_MODEL = 'WX_GEMINI_MODEL';
var WX_GEMINI_MODEL = 'gemini-3.5-flash-lite';
var WX_AI_MANUAL_MAX_CHARS = 4000;
// WX Fase 2b — second provider via OpenRouter (switch, Gemini stays default).
// Keys NEVER hardcoded: OPENROUTER_API_KEY via Script Properties. Model IDs
// rotate; override via WX_OPENROUTER_MODEL property without deploy.
var PROP_WX_AI_PROVIDER = 'WX_AI_PROVIDER'; // 'gemini' (default) | 'openrouter' | 'custom'
var PROP_OPENROUTER_API_KEY = 'OPENROUTER_API_KEY';
var PROP_WX_OPENROUTER_MODEL = 'WX_OPENROUTER_MODEL';
var WX_OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
// WX Fase 2c — third provider: any OpenAI-compatible base URL (e.g. KryptonLab).
// Model default empty on purpose: populate WX_CUSTOM_MODEL from catalog probe result.
var PROP_WX_CUSTOM_BASE_URL = 'WX_CUSTOM_BASE_URL';
var PROP_WX_CUSTOM_API_KEY = 'WX_CUSTOM_API_KEY';
var PROP_WX_CUSTOM_MODEL = 'WX_CUSTOM_MODEL';
var WX_CUSTOM_BASE_URL = 'https://api.kryptonlab.id/v1';
var WX_CUSTOM_MODEL = '';
// WX Fase 2d — model catalog editable from Settings page + master kill-switch.
// Catalog only contains {id,provider,model,label,enabled}; API key NEVER
// stored here (kept via separate Script Properties). Empty/corrupt =
// fallback to WX_AI_CATALOG_DEFAULT (reflection of current WX dropdown).
var PROP_WX_AI_ENABLED = 'WX_AI_ENABLED';
var PROP_WX_AI_CATALOG = 'WX_AI_CATALOG';
var WX_AI_CATALOG_MAX = 20;
var WX_AI_CATALOG_DEFAULT = [
  { id: 'gemini-flash-lite', provider: 'gemini', model: 'gemini-3.5-flash-lite', label: 'Gemini · 3.5-flash-lite', enabled: true },
  { id: 'kl-deepseek-v32', provider: 'custom', model: 'kl/deepseek-v3.2', label: 'CIZ-AI · deepseek-v3.2', enabled: true },
  { id: 'kl-hy3', provider: 'custom', model: 'kl/hy3', label: 'CIZ-AI · hy3', enabled: true },
  { id: 'kl-gemini-38-flash', provider: 'custom', model: 'kl/gemini-3.8-flash', label: 'CIZ-AI · gemini-3.8-flash', enabled: true },
  { id: 'kl-gemini-31-pro', provider: 'custom', model: 'kl/gemini-3.1-pro', label: 'CIZ-AI · gemini-3.1-pro', enabled: true }
];
// Safety: TEST sheet id is NEVER hardcoded here. wxSeedWxSheets() compares the
// bound spreadsheet against WX_TEST_SHEET_ID (or an explicitly passed id) and
// refuses to write on mismatch — a mispointed spreadsheetId fails closed.
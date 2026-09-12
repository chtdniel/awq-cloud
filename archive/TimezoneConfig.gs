/**
 * Timezone Configuration Module (Fix #3)
 * Centralized timezone handling to avoid inconsistencies across dashboard
 * 
 * Purpose:
 * - Ensure all date/time operations use consistent timezone references
 * - Provide standardized formatting functions for display/backend/storage
 * - Prevent timezone confusion between UTC, session timezone, and spreadsheet locale
 * 
 * Configuration:
 * - SCRIPT_TIMEZONE: Backend processing timezone (Asia/Makassar by default)
 * - DISPLAY_TIMEZONE: Default UI display timezone (can be overridden per user)
 * - UTC_TIMEZONE: Data storage standard (always UTC)
 */

const TIMEZONE_CONFIG = {
  SCRIPT_TIMEZONE: 'Asia/Makassar',     // Backend processing timezone
  DISPLAY_TIMEZONE: 'Asia/Jakarta',     // Default UI display timezone
  UTC_TIMEZONE: 'UTC',                  // Data storage standard
  
  /**
   * Convert seconds offset to IANA timezone name
   * @param {number} offsetSeconds - Offset in seconds from UTC
   * @returns {string} IANA timezone identifier
   */
  getDisplayTimezoneFromOffset(offsetSeconds) {
    const offsetHours = Math.floor(offsetSeconds / 3600);
    const offsets = {
      '+7': 'Asia/Jakarta',  // WIB - Indonesia Western Time
      '+8': 'Asia/Makassar', // WITA - Indonesia Central Time  
      '+9': 'Asia/Jayapura', // WIT - Indonesia Eastern Time
      '+0': 'UTC'           // Coordinated Universal Time
    };
    return offsets['+' + offsetHours] || this.SCRIPT_TIMEZONE;
  },
  
  /**
   * Get UTC timestamp string (standardized format)
   * @returns {string} UTC timestamp in 'yyyy-MM-dd HH:mm:ss' format
   */
  getUTCTimestamp() {
    return formatDateInTimezone(new Date(), this.UTC_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  }
};

/**
 * Get current script timezone properties (fallback constant)
 * Reads from PropertiesService if available, otherwise returns default
 * @returns {string} Current script timezone identifier
 */
function getCurrentScriptTimezone() {
  try {
    const props = PropertiesService.getScriptProperties();
    const stored = props.getProperty('SCRIPT_TIMEZONE');
    if (stored && isValidTimezone(stored)) {
      return stored;
    }
  } catch (e) {
    // Ignore property access errors (first run scenario)
  }
  return TIMEZONE_CONFIG.SCRIPT_TIMEZONE;
}

/**
 * Set script timezone configuration (admin only)
 * @param {string} timezone - IANA timezone identifier
 * @throws {Error} If invalid timezone specified
 * @returns {string} The configured timezone
 */
function setTimezone(timezone) {
  if (!isValidTimezone(timezone)) {
    throw new Error('Invalid timezone: ' + timezone);
  }
  
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SCRIPT_TIMEZONE', timezone);
  return timezone;
}

/**
 * Validate IANA timezone name
 * @param {string} tz - IANA timezone identifier to validate
 * @returns {boolean} True if valid, false otherwise
 */
function isValidTimezone(tz) {
  try {
    // Try creating a date object with the timezone - will throw if invalid
    new Date().toLocaleString('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Format date to specific timezone
 * @param {Date} date - Date object to format
 * @param {string} timezone - Target timezone identifier
 * @param {string} formatStr - Format pattern (see Utilities.formatDate patterns)
 * @returns {string} Formatted date string
 */
function formatDateInTimezone(date, timezone, formatStr) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  return Utilities.formatDate(date, timezone, formatStr);
}

/**
 * Get UTC timestamp string (standardized storage format)
 * @returns {string} Timestamp in YYYY-MM-DD HH:MM:SS UTC format
 */
function getUTCTimestamp() {
  return formatDateInTimezone(new Date(), TIMEZONE_CONFIG.UTC_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Normalize date value from various formats to ISO string
 * Handles: Date objects, YYYYMMDD strings, formatted dates
 * @param {*} v - Value to normalize
 * @returns {*} Normalized value or original
 */
function normalizeDateValue(v) {
  // Already a valid Date object
  if (v instanceof Date && !isNaN(v.getTime())) {
    return formatDateInTimezone(v, TIMEZONE_CONFIG.UTC_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  }
  
  // DDMMYY or MM/DD/YYYY format
  if (typeof v === 'string' && /^\d{8}$/.test(v)) {
    return parseDDMMYY(v);
  }
  
  // Already correct format
  return v;
}

/**
 * Parse DDMMYY (or YYYYMMDD) format to ISO string
 * @param {string} ddmmYy - String in DDMMYY or YYYYMMDD format
 * @returns {string} ISO formatted date string
 */
function parseDDMMYY(ddmmYy) {
  try {
    const str = String(ddmmYy).trim();
    
    if (str.length === 8) {
      // Assume YYYYMMDD format
      const year = parseInt(str.substring(0, 4), 10);
      const month = parseInt(str.substring(4, 6), 10);
      const day = parseInt(str.substring(6, 8), 10);
      
      // Validate date ranges
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return formatDateInTimezone(
          new Date(Date.UTC(year, month - 1, day)),
          TIMEZONE_CONFIG.UTC_TIMEZONE,
          'yyyy-MM-dd'
        );
      }
    } else if (str.length === 6) {
      // Assume DDMMYY format
      const year = 2000 + parseInt(str.substring(4, 6), 10);
      const month = parseInt(str.substring(2, 4), 10);
      const day = parseInt(str.substring(0, 2), 10);
      
      // Validate date ranges
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return formatDateInTimezone(
          new Date(Date.UTC(year, month - 1, day)),
          TIMEZONE_CONFIG.UTC_TIMEZONE,
          'yyyy-MM-dd'
        );
      }
    }
    
    // Invalid format, return as-is
    return String(ddmmYy);
  } catch (e) {
    console.error('[TIMEZONE] parseDDMMYY error:', e.message);
    return String(ddmmYy);
  }
}

/**
 * Format flight DOF (Date of Flight) to ISO string
 * @param {*} doff - DOF value from flight data (YYYYMMDD, etc.)
 * @returns {string} ISO formatted date string
 */
function formatFlightDOF(doff) {
  try {
    if (doff instanceof Date && !isNaN(doff.getTime())) {
      return formatDateInTimezone(doff, TIMEZONE_CONFIG.UTC_TIMEZONE, 'yyyy-MM-dd');
    }
    
    const str = String(doff || '').trim();
    if (/^\d{8}$/.test(str)) {
      // Assuming YYYYMMDD format
      return parseDDMMYY(str);
    }
    
    // Try duParseFlightDate helper (already exists)
    if (typeof duParseFlightDate === 'function') {
      const parsed = duParseFlightDate(doff);
      if (parsed && !isNaN(parsed.getTime())) {
        return formatDateInTimezone(parsed, TIMEZONE_CONFIG.UTC_TIMEZONE, 'yyyy-MM-dd');
      }
    }
    
    return String(doff);
  } catch (e) {
    console.error('[TIMEZONE] formatFlightDOF error:', e.message);
    return String(doff);
  }
}

/**
 * Calculate flight window start/end times in UTC
 * @param {Object} flight - Flight data object with STD and STA fields
 * @returns {Object} Object with start, end ISO timestamps
 */
function calculateFlightWindow(flight) {
  try {
    const dof = flight.DOF || flight.dof;
    const std = flight.STD || flight.std;
    const sta = flight.STA || flight.sta;
    
    if (!dof || !std || !sta) {
      return { start: null, end: null, valid: false };
    }
    
    // Parse DOF
    const dofParsed = duParseFlightDate(dof);
    if (!dofofParsed || isNaN(dofParsed.getTime())) {
      return { start: null, end: null, valid: false };
    }
    
    // Extract hours and minutes from STD/STA (format: "HH:MM" or "HHMM")
    const parseTime = (timeStr) => {
      const t = String(timeStr || '00:00').replace(':', '');
      const hh = parseInt(t.substring(0, 2), 10) || 0;
      const mm = parseInt(t.substring(2, 4), 10) || 0;
      return hh * 60 + mm; // Return total minutes
    };
    
    const stdMinutes = parseTime(std);
    const staMinutes = parseTime(sta);
    
    // Calculate start time (in milliseconds from epoch)
    const startDate = new Date(Date.UTC(
      dofofParsed.getUTCFullYear(),
      dofofParsed.getUTCMonth(),
      dofofParsed.getUTCDate(),
      0, // Start at midnight UTC
      stdMinutes
    ));
    
    // Calculate end time
    const endDate = new Date(Date.UTC(
      dofofParsed.getUTCFullYear(),
      dofofParsed.getUTCMonth(),
      dofofParsed.getUTCDate(),
      0,
      staMinutes
    ));
    
    // Handle overnight flights
    if (endDate <= startDate) {
      endDate.setUTCDate(endDate.getUTCDate() + 1);
    }
    
    return {
      start: formatDateInTimezone(startDate, TIMEZONE_CONFIG.UTC_TIMEZONE, 'yyyy-MM-dd HH:mm'),
      end: formatDateInTimezone(endDate, TIMEZONE_CONFIG.UTC_TIMEZONE, 'yyyy-MM-dd HH:mm'),
      valid: true
    };
  } catch (e) {
    console.error('[TIMEZONE] calculateFlightWindow error:', e.message);
    return { start: null, end: null, valid: false };
  }
}

/**
 * Cape Lo (Gauss-Conformal) SRID Utilities
 * 
 * Zimbabwe uses 5 Cape Lo zones based on central meridians.
 * Each zone has a specific EPSG SRID for PostGIS spatial operations.
 */

/**
 * Map Cape Lo zone identifiers to EPSG SRIDs
 */
const CAPE_LO_SRID_MAP = {
  25: 22285,  // Lo 25 (25°E) - Western Zimbabwe  — EPSG:22285 = Cape / Lo25
  27: 22287,  // Lo 27 (27°E) - West-Central       — EPSG:22287 = Cape / Lo27
  29: 22289,  // Lo 29 (29°E) - Central             — EPSG:22289 = Cape / Lo29
  31: 22291,  // Lo 31 (31°E) - East-Central        — EPSG:22291 = Cape / Lo31
  33: 22293   // Lo 33 (33°E) - Eastern Zimbabwe    — EPSG:22293 = Cape / Lo33
};

/**
 * Get EPSG SRID for a Cape Lo central meridian
 * 
 * @param {number|string} centralMeridian - Central meridian value (25, 27, 29, 31, or 33)
 * @returns {number} EPSG SRID code
 * 
 * @example
 * getCapeLoSRID(31) // Returns 22291
 * getCapeLoSRID('Lo31') // Returns 22291
 * getCapeLoSRID('31') // Returns 22291
 */
export function getCapeLoSRID(centralMeridian) {
  if (!centralMeridian) {
    console.warn('[Cape Lo SRID] No central meridian provided, defaulting to Lo 31 (SRID 22291)');
    return 22291; // Default to Lo 31
  }

  // Extract numeric value from various formats
  let meridianValue;
  
  if (typeof centralMeridian === 'number') {
    meridianValue = centralMeridian;
  } else if (typeof centralMeridian === 'string') {
    // Handle formats: 'Lo31', 'Lo 31', '31', 'lo31', etc.
    const match = centralMeridian.match(/\d+/);
    if (match) {
      meridianValue = parseInt(match[0], 10);
    }
  }

  const srid = CAPE_LO_SRID_MAP[meridianValue];
  
  if (!srid) {
    console.warn(`[Cape Lo SRID] Invalid central meridian: ${centralMeridian}, defaulting to Lo 31 (SRID 22291)`);
    return 22291; // Default to Lo 31
  }

  return srid;
}

/**
 * Get Cape Lo zone name from central meridian
 * 
 * @param {number|string} centralMeridian - Central meridian value
 * @returns {string} Zone name (e.g., 'Lo 31')
 */
export function getCapeLoZoneName(centralMeridian) {
  const meridianValue = typeof centralMeridian === 'number' 
    ? centralMeridian 
    : parseInt(centralMeridian?.match(/\d+/)?.[0] || '31', 10);
  
  return `Lo ${meridianValue}`;
}

/**
 * Validate if a central meridian is valid for Zimbabwe
 * 
 * @param {number|string} centralMeridian - Central meridian value
 * @returns {boolean} True if valid
 */
export function isValidCapeLoMeridian(centralMeridian) {
  const meridianValue = typeof centralMeridian === 'number'
    ? centralMeridian
    : parseInt(centralMeridian?.match(/\d+/)?.[0] || '0', 10);
  
  return CAPE_LO_SRID_MAP.hasOwnProperty(meridianValue);
}

/**
 * Get all supported Cape Lo zones
 * 
 * @returns {Array<{meridian: number, srid: number, name: string}>}
 */
export function getAllCapeLoZones() {
  return Object.entries(CAPE_LO_SRID_MAP).map(([meridian, srid]) => ({
    meridian: parseInt(meridian, 10),
    srid,
    name: `Lo ${meridian}`,
    description: getCapeLoDescription(parseInt(meridian, 10))
  }));
}

/**
 * Get description for a Cape Lo zone
 * 
 * @param {number} meridian - Central meridian value
 * @returns {string} Description
 */
function getCapeLoDescription(meridian) {
  const descriptions = {
    25: 'Western Zimbabwe',
    27: 'West-Central Zimbabwe',
    29: 'Central Zimbabwe',
    31: 'East-Central Zimbabwe (most common)',
    33: 'Eastern Zimbabwe'
  };
  return descriptions[meridian] || 'Unknown zone';
}

export default {
  getCapeLoSRID,
  getCapeLoZoneName,
  isValidCapeLoMeridian,
  getAllCapeLoZones
};

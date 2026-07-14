// Coordinate Reference System Definitions for Zimbabwe Survey Plans
// Supports Cape Lo 29, Lo 31, and other Zimbabwe projections

export const ZIMBABWE_CRS = {
  'EPSG:22291': {
    name: 'Cape Lo 31',
    description: 'Zimbabwe National Grid - Zone 31',
    proj4: '+proj=tmerc +lat_0=0 +lon_0=31 +k=1 +x_0=0 +y_0=0 +ellps=clrk80 +towgs84=-136,-108,-292,0,0,0,0 +units=m +no_defs',
    wkt: 'PROJCS["Cape_Lo_31",GEOGCS["Cape",DATUM["Cape",SPHEROID["Clarke 1880 (Arc)",6378249.145,293.465],TOWGS84[-136,-108,-292,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0,AUTHORITY["EPSG","8801"]],PARAMETER["central_meridian",31,AUTHORITY["EPSG","8802"]],PARAMETER["scale_factor",1,AUTHORITY["EPSG","8805"]],PARAMETER["false_easting",0,AUTHORITY["EPSG","8806"]],PARAMETER["false_northing",0,AUTHORITY["EPSG","8807"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","22291"]]',
    datum: 'Cape',
    ellipsoid: 'Clarke 1880 (Arc)',
    units: 'metre',
    centralMeridian: 31,
    falseEasting: 0,
    falseNorthing: 0,
    scaleFactor: 1
  },
  
  'EPSG:22293': {
    name: 'Cape Lo 29',
    description: 'Zimbabwe National Grid - Zone 29',
    proj4: '+proj=tmerc +lat_0=0 +lon_0=29 +k=1 +x_0=0 +y_0=0 +ellps=clrk80 +towgs84=-136,-108,-292,0,0,0,0 +units=m +no_defs',
    wkt: 'PROJCS["Cape_Lo_29",GEOGCS["Cape",DATUM["Cape",SPHEROID["Clarke 1880 (Arc)",6378249.145,293.465],TOWGS84[-136,-108,-292,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0,AUTHORITY["EPSG","8801"]],PARAMETER["central_meridian",29,AUTHORITY["EPSG","8802"]],PARAMETER["scale_factor",1,AUTHORITY["EPSG","8805"]],PARAMETER["false_easting",0,AUTHORITY["EPSG","8806"]],PARAMETER["false_northing",0,AUTHORITY["EPSG","8807"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","22293"]]',
    datum: 'Cape',
    ellipsoid: 'Clarke 1880 (Arc)',
    units: 'metre',
    centralMeridian: 29,
    falseEasting: 0,
    falseNorthing: 0,
    scaleFactor: 1
  },
  
  'EPSG:22292': {
    name: 'Cape Lo 27',
    description: 'Zimbabwe National Grid - Zone 27',
    proj4: '+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=0 +y_0=0 +ellps=clrk80 +towgs84=-136,-108,-292,0,0,0,0 +units=m +no_defs',
    wkt: 'PROJCS["Cape_Lo_27",GEOGCS["Cape",DATUM["Cape",SPHEROID["Clarke 1880 (Arc)",6378249.145,293.465],TOWGS84[-136,-108,-292,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0,AUTHORITY["EPSG","8801"]],PARAMETER["central_meridian",27,AUTHORITY["EPSG","8802"]],PARAMETER["scale_factor",1,AUTHORITY["EPSG","8805"]],PARAMETER["false_easting",0,AUTHORITY["EPSG","8806"]],PARAMETER["false_northing",0,AUTHORITY["EPSG","8807"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","22292"]]',
    datum: 'Cape',
    ellipsoid: 'Clarke 1880 (Arc)',
    units: 'metre',
    centralMeridian: 27,
    falseEasting: 0,
    falseNorthing: 0,
    scaleFactor: 1
  },
  
  'EPSG:22294': {
    name: 'Cape Lo 25',
    description: 'Zimbabwe National Grid - Zone 25',
    proj4: '+proj=tmerc +lat_0=0 +lon_0=25 +k=1 +x_0=0 +y_0=0 +ellps=clrk80 +towgs84=-136,-108,-292,0,0,0,0 +units=m +no_defs',
    wkt: 'PROJCS["Cape_Lo_25",GEOGCS["Cape",DATUM["Cape",SPHEROID["Clarke 1880 (Arc)",6378249.145,293.465],TOWGS84[-136,-108,-292,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0,AUTHORITY["EPSG","8801"]],PARAMETER["central_meridian",25,AUTHORITY["EPSG","8802"]],PARAMETER["scale_factor",1,AUTHORITY["EPSG","8805"]],PARAMETER["false_easting",0,AUTHORITY["EPSG"]["8806"]],PARAMETER["false_northing",0,AUTHORITY["EPSG","8807"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","22294"]]',
    datum: 'Cape',
    ellipsoid: 'Clarke 1880 (Arc)',
    units: 'metre',
    centralMeridian: 25,
    falseEasting: 0,
    falseNorthing: 0,
    scaleFactor: 1
  },
  
  'EPSG:4326': {
    name: 'WGS 84',
    description: 'World Geodetic System 1984',
    proj4: '+proj=longlat +datum=WGS84 +no_defs',
    wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
    datum: 'WGS84',
    ellipsoid: 'WGS 84',
    units: 'degree',
    isGeographic: true
  }
};

/**
 * Get CRS information by EPSG code
 */
export function getCRSByEPSG(epsgCode) {
  return ZIMBABWE_CRS[epsgCode] || null;
}

/**
 * Get all available CRS for Zimbabwe
 */
export function getZimbabweCRS() {
  return Object.keys(ZIMBABWE_CRS)
    .filter(key => key.startsWith('EPSG:2229')) // Cape Lo zones
    .map(key => ({
      code: key,
      ...ZIMBABWE_CRS[key]
    }));
}

/**
 * Convert Proj4 string to WKT format
 */
export function proj4ToWKT(proj4String) {
  // This is a simplified conversion - in production, use a proper library
  const crs = Object.values(ZIMBABWE_CRS).find(c => c.proj4 === proj4String);
  return crs ? crs.wkt : null;
}

/**
 * Determine appropriate Lo zone based on longitude
 */
export function determineLoZone(longitude) {
  if (longitude >= 28 && longitude < 30) return 'EPSG:22293'; // Lo 29
  if (longitude >= 30 && longitude < 32) return 'EPSG:22291'; // Lo 31
  if (longitude >= 26 && longitude < 28) return 'EPSG:22292'; // Lo 27
  if (longitude >= 24 && longitude < 26) return 'EPSG:22294'; // Lo 25
  
  return 'EPSG:22291'; // Default to Lo 31
}

/**
 * Validate coordinate bounds for given CRS
 */
export function validateCoordinateBounds(epsgCode, y, x) {
  const crs = ZIMBABWE_CRS[epsgCode];
  if (!crs) return false;
  
  if (crs.isGeographic) {
    return y >= -90 && y <= 90 && x >= -180 && x <= 180;
  }
  
  // Cape Lo zones - approximate bounds for Zimbabwe
  const bounds = {
    'EPSG:22291': { minY: -500000, maxY: 900000, minX: 2000000, maxX: 2800000 },
    'EPSG:22293': { minY: -500000, maxY: 900000, minX: 2000000, maxX: 2800000 },
    'EPSG:22292': { minY: -500000, maxY: 900000, minX: 2000000, maxX: 2800000 },
    'EPSG:22294': { minY: -500000, maxY: 900000, minX: 2000000, maxX: 2800000 }
  };
  
  const zoneBounds = bounds[epsgCode];
  if (!zoneBounds) return false;
  
  return y >= zoneBounds.minY && y <= zoneBounds.maxY &&
         x >= zoneBounds.minX && x <= zoneBounds.maxX;
}

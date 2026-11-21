/**
 * @file routing.js
 * Geographic pathfinding algorithms, ocean/land validation, obstacle avoidance,
 * and waypoint interpolation for God's Eye View simulation.
 * Pure JavaScript module compatible with both Browser and Node.js environments.
 */

import {
  geodesicDistanceKm,
  calculateBearing,
  bearingToCompassDirection,
  calculateHeadingDifference,
  calculateCrossTrackDistance,
  calculateETA,
} from '../geoMath.mjs';

/** Earth's mean radius in kilometers. */
const EARTH_RADIUS_KM = 6371.0;

/** Default Iceberg Safety Buffer in kilometers */
export const DEFAULT_ICEBERG_SAFETY_BUFFER_KM = 3.5;

/**
 * Antarctic Land Mask Polygons (Simplified Antarctic Coastline & Peninsula Boundaries)
 * Defined in [lat, lon] format. Impassable land obstacles for maritime navigation.
 */
export const ANTARCTIC_LAND_POLYGONS = [
  // Main Antarctic Continent Interior Mask [lat, lon]
  [
    [-65.0, -64.0], [-64.0, -60.0], [-66.0, -55.0], [-68.0, -62.0],
    [-72.0, -70.0], [-75.0, -110.0], [-74.0, -140.0], [-77.0, -170.0],
    [-78.0, 165.0], [-72.0, 170.0], [-68.0, 140.0], [-67.0, 100.0],
    [-68.0, 60.0], [-70.0, 20.0], [-72.0, -10.0], [-65.0, -64.0]
  ],
  // Antarctic Peninsula Spine [lat, lon]
  [
    [-63.2, -57.0], [-64.5, -62.0], [-66.0, -65.0], [-68.5, -67.0],
    [-70.0, -69.0], [-72.0, -72.0], [-73.0, -68.0], [-70.0, -64.0],
    [-67.0, -61.0], [-64.0, -56.5], [-63.2, -57.0]
  ]
];

/**
 * Global Continental Land Mask Polygons (Simplified Continental Outlines)
 * Defined in [lat, lon] format.
 */
export const GLOBAL_LAND_POLYGONS = [
  // North America
  [
    [71.5, -156.5], [65.0, -168.0], [60.0, -165.0], [55.0, -162.0],
    [54.0, -133.0], [48.0, -125.0], [38.0, -123.5], [34.0, -119.5],
    [30.0, -116.0], [23.0, -110.0], [16.0, -95.0], [8.0, -78.0],
    [9.0, -77.0], [15.0, -88.0], [25.0, -80.0], [30.0, -81.0],
    [35.0, -75.0], [44.0, -69.0], [48.0, -64.0], [60.0, -64.0],
    [70.0, -70.0], [75.0, -95.0], [72.0, -125.0], [71.5, -156.5]
  ],
  // South America
  [
    [12.0, -75.0], [12.0, -60.0], [-5.0, -35.0], [-35.0, -53.0],
    [-56.0, -67.0], [-56.0, -75.0], [-5.0, -81.0], [12.0, -75.0]
  ],
  // Eurasia (Europe + Asia)
  [
    [36.0, -10.0], [72.0, 10.0], [75.0, 100.0], [70.0, 175.0],
    [60.0, 163.0], [53.0, 157.0], [45.0, 143.0], [35.0, 140.0],
    [22.0, 114.0], [1.0, 104.0], [22.0, 69.0], [12.0, 43.0],
    [30.0, 32.0], [36.0, -10.0]
  ],
  // Africa
  [
    [37.0, -10.0], [37.0, 10.0], [30.0, 32.0], [12.0, 43.0],
    [12.0, 51.0], [-35.0, 20.0], [-35.0, 18.0], [5.0, 9.0],
    [15.0, -17.0], [37.0, -10.0]
  ],
  // Australia
  [
    [-10.0, 142.0], [-10.0, 130.0], [-22.0, 113.0], [-35.0, 115.0],
    [-39.0, 144.0], [-38.0, 150.0], [-10.0, 142.0]
  ],
  // Greenland
  [
    [60.0, -45.0], [83.0, -30.0], [83.0, -70.0], [75.0, -75.0], [60.0, -45.0]
  ]
];

/**
 * Check if point (lat, lon) is inside a ring formatted as [lat, lon].
 */
export function isPointInLatLonRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0]; // lat
    const xi = ring[i][1]; // lon
    const yj = ring[j][0];
    const xj = ring[j][1];

    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Check if point (lat, lon) is inside a GeoJSON ring formatted as [lon, lat].
 */
export function isPointInLonLatRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; // lon
    const yi = ring[i][1]; // lat
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Check if a point (lat, lon) is inside a polygon ring (auto-detects [lon, lat] vs [lat, lon]).
 */
export function isPointInPolygonRing(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  if (Math.abs(ring[0][0]) > 90) {
    return isPointInLonLatRing(lat, lon, ring);
  }
  if (Math.abs(ring[0][1]) > 90) {
    return isPointInLatLonRing(lat, lon, ring);
  }
  return isPointInLonLatRing(lat, lon, ring);
}

/**
 * Check if point (lat, lon) is on land.
 * @param {number} lat
 * @param {number} lon
/**
 * Check if coordinate is in a known ocean water body (prevents coarse land mask false positives).
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isWaterBody(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  // Gulf of Mexico & Caribbean & Panama approach
  if (latitude >= 18.0 && latitude <= 30.5 && longitude >= -97.5 && longitude <= -81.0 && !(latitude > 25.5 && longitude > -82.5)) return true;
  if (latitude >= 8.0 && latitude <= 26.0 && longitude >= -88.0 && longitude <= -60.0 && !(latitude >= 8.0 && latitude <= 16.0 && longitude >= -88.0 && longitude <= -83.0)) return true;
  // Persian Gulf
  if (latitude >= 23.0 && latitude <= 30.0 && longitude >= 48.0 && longitude <= 56.5) return true;
  // Red Sea & Suez approach
  if (latitude >= 12.0 && latitude <= 32.0 && longitude >= 32.0 && longitude <= 43.5) return true;
  // Baltic Sea & North Sea & English Channel
  if (latitude >= 48.0 && latitude <= 66.0 && longitude >= -6.0 && longitude <= 30.0) return true;
  return false;
}

/**
 * Check if point (lat, lon) is on land.
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isPointOnLand(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  if (isWaterBody(latitude, longitude)) return false;

  // Check Antarctic Land Polygons [lat, lon]
  for (const landPoly of ANTARCTIC_LAND_POLYGONS) {
    if (isPointInLatLonRing(latitude, longitude, landPoly)) return true;
  }
  // Check Global Land Polygons [lat, lon]
  for (const landPoly of GLOBAL_LAND_POLYGONS) {
    if (isPointInLatLonRing(latitude, longitude, landPoly)) return true;
  }
  return false;
}

/**
 * Find nearest ocean point along coastline by searching radial rings outward from a land coordinate.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxDistanceKm=500]
 * @returns {{lat: number, lon: number, distanceKm: number, isOriginal?: boolean}}
 */
export function findNearestOceanPoint(lat, lon, maxDistanceKm = 500) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!isPointOnLand(latitude, longitude)) {
    return { lat: latitude, lon: longitude, distanceKm: 0, isOriginal: true };
  }

  let bestCand = null;
  let minDist = Infinity;

  const distances = [5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 450];
  const angles = 36;

  for (const distKm of distances) {
    if (distKm > maxDistanceKm) break;
    const latOffset = distKm / 111.0;
    const cosLat = Math.max(0.1, Math.cos((latitude * Math.PI) / 180));
    const lonOffset = distKm / (111.0 * cosLat);

    for (let a = 0; a < angles; a++) {
      const rad = (a * 10 * Math.PI) / 180;
      const candLat = Math.max(-89.9, Math.min(89.9, latitude + Math.sin(rad) * latOffset));
      let candLon = longitude + Math.cos(rad) * lonOffset;

      if (candLon > 180) candLon -= 360;
      if (candLon < -180) candLon += 360;

      if (!isPointOnLand(candLat, candLon)) {
        const d = geodesicDistanceKm(latitude, longitude, candLat, candLon);
        if (d < minDist) {
          minDist = d;
          bestCand = {
            lat: Math.round(candLat * 10000) / 10000,
            lon: Math.round(candLon * 10000) / 10000,
            distanceKm: Math.round(d * 10) / 10,
          };
        }
      }
    }
    if (bestCand && bestCand.distanceKm <= distKm + 10) {
      break;
    }
  }

  return bestCand || { lat: latitude, lon: longitude, distanceKm: 999, isOriginal: true };
}

/**
 * Check if a 2D line segment (lon1, lat1) -> (lon2, lat2) intersects segment (lon3, lat3) -> (lon4, lat4).
 */
function lineSegmentsIntersect(lon1, lat1, lon2, lat2, lon3, lat3, lon4, lat4) {
  const ccw = (ax, ay, bx, by, cx, cy) => {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  };
  return (
    ccw(lon1, lat1, lon3, lat3, lon4, lat4) !== ccw(lon2, lat2, lon3, lat3, lon4, lat4) &&
    ccw(lon1, lat1, lon2, lat2, lon3, lat3) !== ccw(lon1, lat1, lon2, lat2, lon4, lat4)
  );
}

/**
 * Check if a route edge intersects land polygon boundaries.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {boolean}
 */
export function edgeIntersectsLand(lat1, lon1, lat2, lon2) {
  if (isPointOnLand(lat1, lon1) || isPointOnLand(lat2, lon2)) return true;

  // Handle Antimeridian (180° / -180°) wrapping
  if (Math.abs(lon2 - lon1) > 180) {
    let dLon = (lon2 - lon1) % 360;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;

    const edgeEnd = lon1 < 0 ? -180 : 180;
    const edgeStart = lon2 < 0 ? -180 : 180;
    const t = dLon !== 0 ? (edgeEnd - lon1) / dLon : 0.5;
    const latMid = lat1 + t * (lat2 - lat1);

    return edgeIntersectsLand(lat1, lon1, latMid, edgeEnd) || edgeIntersectsLand(latMid, edgeStart, lat2, lon2);
  }

  for (const landPoly of ANTARCTIC_LAND_POLYGONS) {
    for (let i = 0; i < landPoly.length - 1; i++) {
      if (lineSegmentsIntersect(lon1, lat1, lon2, lat2, landPoly[i][1], landPoly[i][0], landPoly[i + 1][1], landPoly[i + 1][0])) {
        return true;
      }
    }
  }

  for (const landPoly of GLOBAL_LAND_POLYGONS) {
    for (let i = 0; i < landPoly.length - 1; i++) {
      if (lineSegmentsIntersect(lon1, lat1, lon2, lat2, landPoly[i][1], landPoly[i][0], landPoly[i + 1][1], landPoly[i + 1][0])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a route edge (lat1, lon1) -> (lat2, lon2) intersects an iceberg polygon or enters its safety buffer.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {Array<object>} icebergs
 * @param {number} [safetyBufferKm=3.5]
 * @returns {{intersects: boolean, minDistanceKm: number, nearestIceberg: object|null}}
 */
export function checkEdgeIcebergObstacles(lat1, lon1, lat2, lon2, icebergs = [], safetyBufferKm = DEFAULT_ICEBERG_SAFETY_BUFFER_KM) {
  let minDistanceKm = Infinity;
  let nearestIceberg = null;
  let intersects = false;

  if (!Array.isArray(icebergs) || icebergs.length === 0) {
    return { intersects: false, minDistanceKm: 999.0, nearestIceberg: null };
  }

  const minLat = Math.min(lat1, lat2) - 2.0;
  const maxLat = Math.max(lat1, lat2) + 2.0;
  const minLon = Math.min(lon1, lon2) - 4.0;
  const maxLon = Math.max(lon1, lon2) + 4.0;

  for (let i = 0; i < icebergs.length; i++) {
    const berg = icebergs[i];
    const props = berg.properties || {};

    let bLat = props.Latitude ?? berg.lat ?? berg.latitude;
    let bLon = props.Longitude ?? berg.lon ?? berg.longitude;

    const ring = berg.geometry?.type === 'Polygon' && Array.isArray(berg.geometry.coordinates?.[0])
      ? berg.geometry.coordinates[0]
      : berg.polygonCoordinates;

    if (ring && (bLat === undefined || bLon === undefined)) {
      const firstPt = ring[0];
      bLat = Array.isArray(firstPt) ? firstPt[1] : (firstPt.lat ?? firstPt.latitude);
      bLon = Array.isArray(firstPt) ? firstPt[0] : (firstPt.lon ?? firstPt.longitude);
    }

    if (!Number.isFinite(bLat) || !Number.isFinite(bLon)) continue;
    if (bLat < minLat || bLat > maxLat || bLon < minLon || bLon > maxLon) continue;

    const centerDist = distPointToSegmentKm(bLat, bLon, lat1, lon1, lat2, lon2);
    if (centerDist < minDistanceKm) {
      minDistanceKm = centerDist;
      nearestIceberg = berg;
    }

    const radKm = Number(berg.safetyRadiusKm) || safetyBufferKm;
    if (centerDist <= radKm) {
      intersects = true;
    }

    if (ring && ring.length >= 3) {
      for (let j = 0; j < ring.length - 1; j++) {
        const p1 = ring[j];
        const p2 = ring[j + 1];
        const p1Lon = Array.isArray(p1) ? p1[0] : (p1.lon ?? p1.longitude);
        const p1Lat = Array.isArray(p1) ? p1[1] : (p1.lat ?? p1.latitude);
        const p2Lon = Array.isArray(p2) ? p2[0] : (p2.lon ?? p2.longitude);
        const p2Lat = Array.isArray(p2) ? p2[1] : (p2.lat ?? p2.latitude);

        if (lineSegmentsIntersect(lon1, lat1, lon2, lat2, p1Lon, p1Lat, p2Lon, p2Lat)) {
          intersects = true;
          minDistanceKm = 0;
          break;
        }

        const d1 = distPointToSegmentKm(p1Lat, p1Lon, lat1, lon1, lat2, lon2);
        const d2 = distPointToSegmentKm(p2Lat, p2Lon, lat1, lon1, lat2, lon2);
        const edgeDist = Math.min(d1, d2);

        if (edgeDist < minDistanceKm) {
          minDistanceKm = edgeDist;
          nearestIceberg = berg;
        }

        if (edgeDist <= radKm) {
          intersects = true;
        }
      }
    }
  }

  return {
    intersects,
    minDistanceKm: Number.isFinite(minDistanceKm) ? Math.round(minDistanceKm * 10) / 10 : 999.0,
    nearestIceberg,
  };
}

/**
 * Validate that a coordinate is in open ocean/water.
 * If coordinate is on Antarctic land or continent, returns nearest ocean coordinate.
 * @param {number} lat
 * @param {number} lon
 * @returns {{lat: number, lon: number, isLand: boolean, originalLat?: number, originalLon?: number}}
 */
export function validateOceanPosition(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const onLand = isPointOnLand(latitude, longitude);
  if (onLand) {
    const ocean = findNearestOceanPoint(latitude, longitude);
    return {
      lat: ocean.lat,
      lon: ocean.lon,
      isLand: true,
      originalLat: latitude,
      originalLon: longitude,
    };
  }
  return { lat: latitude, lon: longitude, isLand: false };
}

/**
 * Calculate Great-Circle / Haversine distance in kilometers between two coordinates.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in kilometers
 */
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  return geodesicDistanceKm(lat1, lon1, lat2, lon2);
}

/**
 * Calculate perpendicular distance from a point to a line segment in kilometers.
 * @param {number} pLat
 * @param {number} pLon
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number} Distance in kilometers
 */
export function distPointToSegmentKm(pLat, pLon, aLat, aLon, bLat, bLon) {
  const dTotal = geodesicDistanceKm(aLat, aLon, bLat, bLon);
  if (dTotal < 0.001) return geodesicDistanceKm(pLat, pLon, aLat, aLon);

  const d1 = geodesicDistanceKm(pLat, pLon, aLat, aLon);
  const d2 = geodesicDistanceKm(pLat, pLon, bLat, bLon);

  const t = (d1 * d1 - d2 * d2 + dTotal * dTotal) / (2 * dTotal * dTotal);

  if (t <= 0) return d1;
  if (t >= 1) return d2;

  const projLat = aLat + t * (bLat - aLat);
  const projLon = aLon + t * (bLon - aLon);
  return geodesicDistanceKm(pLat, pLon, projLat, projLon);
}

/**
 * Calculate dynamic hazard radius in kilometers for an iceberg feature.
 * @param {object} hazard
 * @param {number} [baseBufferKm=2.0]
 * @param {number} [minRadiusKm=3.5]
 * @returns {number}
 */
export function calculateIcebergHazardRadiusKm(hazard, baseBufferKm = 2.0, minRadiusKm = 3.5) {
  if (!hazard) return minRadiusKm;
  let physicalRadiusKm = 0;

  if (Array.isArray(hazard.polygonCoordinates) && hazard.polygonCoordinates.length > 0) {
    for (const pt of hazard.polygonCoordinates) {
      const vLon = Array.isArray(pt) ? pt[0] : (pt.lon ?? pt.longitude);
      const vLat = Array.isArray(pt) ? pt[1] : (pt.lat ?? pt.latitude);
      if (Number.isFinite(vLat) && Number.isFinite(vLon)) {
        const d = geodesicDistanceKm(hazard.lat, hazard.lon, vLat, vLon);
        if (d > physicalRadiusKm) physicalRadiusKm = d;
      }
    }
  }

  if (hazard.areaKm2 && hazard.areaKm2 > 0) {
    const equivalentCircleRadiusKm = Math.sqrt(hazard.areaKm2 / Math.PI);
    physicalRadiusKm = Math.max(physicalRadiusKm, equivalentCircleRadiusKm);
  }

  const totalRadiusKm = physicalRadiusKm + baseBufferKm;
  return Math.max(minRadiusKm, totalRadiusKm);
}

/**
 * Check if a straight geographic segment clears all hazard safety zones AND Antarctic land.
 * @param {{lat: number, lon: number}} p1
 * @param {{lat: number, lon: number}} p2
 * @param {Array<{lat: number, lon: number, safetyRadiusKm?: number}>} hazards
 * @param {number} [defaultSafetyRadiusKm=3.5]
 * @returns {boolean}
 */
export function segmentIsSafe(p1, p2, hazards, defaultSafetyRadiusKm = 3.5) {
  const p1Lat = Number(p1.lat ?? p1.latitude);
  const p1Lon = Number(p1.lon ?? p1.longitude);
  const p2Lat = Number(p2.lat ?? p2.latitude);
  const p2Lon = Number(p2.lon ?? p2.longitude);

  if (!Number.isFinite(p1Lat) || !Number.isFinite(p1Lon) || !Number.isFinite(p2Lat) || !Number.isFinite(p2Lon)) {
    return false;
  }

  // 1. HARD RULE: Check if endpoints land on continent or coast
  if (isPointOnLand(p1Lat, p1Lon) || isPointOnLand(p2Lat, p2Lon)) {
    return false;
  }

  // 2. HARD RULE: Check if segment crosses land boundaries
  if (edgeIntersectsLand(p1Lat, p1Lon, p2Lat, p2Lon)) {
    return false;
  }

  // 3. HARD RULE: Check if segment enters iceberg polygon or safety buffer
  const bergCheck = checkEdgeIcebergObstacles(p1Lat, p1Lon, p2Lat, p2Lon, hazards, defaultSafetyRadiusKm);
  if (bergCheck.intersects) {
    return false;
  }

  return true;
}

/**
 * Filter hazards to those lying within a transit corridor.
 * @param {Array<{lat: number, lon: number}>} icebergs
 * @param {{latitude: number, longitude: number}} start
 * @param {{latitude: number, longitude: number}} destination
 * @param {number} [paddingKm=30]
 * @returns {Array<{lat: number, lon: number}>}
 */
export function filterCorridorHazards(icebergs, start, destination, paddingKm = 30) {
  if (!Array.isArray(icebergs) || icebergs.length === 0) return [];
  const startLat = Number(start.latitude ?? start.lat);
  const startLon = Number(start.longitude ?? start.lon);
  const destLat = Number(destination.latitude ?? destination.lat);
  const destLon = Number(destination.longitude ?? destination.lon);

  const baseline = geodesicDistanceKm(startLat, startLon, destLat, destLon);
  const maxDistanceSum = baseline + paddingKm * 2;

  return icebergs.filter((iceberg) => {
    const dStart = geodesicDistanceKm(iceberg.lat, iceberg.lon, startLat, startLon);
    const dDest = geodesicDistanceKm(iceberg.lat, iceberg.lon, destLat, destLon);
    return dStart + dDest <= maxDistanceSum;
  });
}

/**
 * Priority queue item helper for A* search.
 */
class MinHeap {
  constructor() {
    this.data = [];
  }
  push(item) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }
  pop() {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const bottom = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this._sinkDown(0);
    }
    return top;
  }
  get size() {
    return this.data.length;
  }
  _bubbleUp(i) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.data[i].priority >= this.data[p].priority) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  _sinkDown(i) {
    const len = this.data.length;
    while (true) {
      let left = 2 * i + 1;
      let right = 2 * i + 2;
      let smallest = i;
      if (left < len && this.data[left].priority < this.data[smallest].priority) smallest = left;
      if (right < len && this.data[right].priority < this.data[smallest].priority) smallest = right;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

/**
 * Critical Safety Verification for Simulation Routes.
 * Verifies every waypoint is ocean, outside icebergs, and every segment avoids land/icebergs.
 * @param {object} route
 * @param {object} [options]
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateSimulationRoute(route, options = {}) {
  if (!route || !Array.isArray(route.waypoints) || route.waypoints.length < 2) {
    return { valid: false, reason: 'INVALID_WAYPOINTS' };
  }
  const hazards = options.hazards || [];
  const safetyBufferKm = options.safetyRadiusKm || 3.5;

  for (let i = 0; i < route.waypoints.length; i++) {
    const wp = route.waypoints[i];
    const wLat = Number(wp.lat ?? wp.latitude);
    const wLon = Number(wp.lon ?? wp.longitude);

    if (isPointOnLand(wLat, wLon)) {
      return { valid: false, reason: `WAYPOINT_${i}_ON_LAND` };
    }

    const bergCheck = checkEdgeIcebergObstacles(wLat, wLon, wLat, wLon, hazards, safetyBufferKm);
    if (bergCheck.intersects) {
      return { valid: false, reason: `WAYPOINT_${i}_INSIDE_ICEBERG_BUFFER` };
    }

    if (i > 0) {
      const prev = route.waypoints[i - 1];
      const pLat = Number(prev.lat ?? prev.latitude);
      const pLon = Number(prev.lon ?? prev.longitude);

      if (edgeIntersectsLand(pLat, pLon, wLat, wLon)) {
        return { valid: false, reason: `SEGMENT_${i - 1}_${i}_CROSSES_LAND` };
      }

      const segBergCheck = checkEdgeIcebergObstacles(pLat, pLon, wLat, wLon, hazards, safetyBufferKm);
      if (segBergCheck.intersects) {
        return { valid: false, reason: `SEGMENT_${i - 1}_${i}_CROSSES_ICEBERG_BUFFER` };
      }
    }
  }

  return { valid: true, reason: null };
}

/**
 * Normalize and validate geographic coordinate object.
 * @param {object} pt
 * @returns {{latitude: number, longitude: number, lat: number, lon: number, name: string} | null}
 */
export function normalizeCoordinate(pt) {
  if (!pt || typeof pt !== 'object') return null;
  const lat = pt.lat !== undefined ? Number(pt.lat) : (pt.latitude !== undefined ? Number(pt.latitude) : NaN);
  const lon = pt.lon !== undefined ? Number(pt.lon) : (pt.longitude !== undefined ? Number(pt.longitude) : NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const name = pt.name || pt.label || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  return {
    latitude: lat,
    longitude: lon,
    lat,
    lon,
    name,
  };
}

/**
 * Calculate the safest and shortest maritime route around Antarctic land and iceberg hazards.
 *
 * @param {object} params
 * @param {{latitude: number, longitude: number}|{lat: number, lon: number}} params.start
 * @param {{latitude: number, longitude: number}|{lat: number, lon: number}} params.destination
 * @param {Array<{lat: number, lon: number, areaKm2?: number, safetyRadiusKm?: number}>} params.hazards
 * @param {number} [params.safetyRadiusKm=3.5]
 * @param {number} [params.gridLatStepDeg=0.012]
 * @param {number} [params.gridLonStepDeg=0.028]
 * @param {number} [params.paddingDeg=0.20]
 * @param {number} [params.corridorPaddingDeg]
 * @returns {object} Result with ocean waypoints, distance, and safety metrics
 */
export function calculateSafeRoute({
  start,
  destination,
  hazards = [],
  safetyRadiusKm = 3.5,
  gridLatStepDeg = 0.012,
  gridLonStepDeg = 0.028,
  paddingDeg,
  corridorPaddingDeg,
}) {
  const padDeg = paddingDeg ?? corridorPaddingDeg ?? 0.25;

  const startNorm = normalizeCoordinate(start);
  const destNorm = normalizeCoordinate(destination);

  if (!startNorm || !destNorm) {
    return {
      ok: false,
      reason: 'INVALID COORDINATES',
      waypoints: [],
      totalDistanceKm: 0,
      hazardsAvoidedCount: 0,
      hazardsNearRoute: [],
    };
  }

  if (!hazards || !Array.isArray(hazards) || hazards.length === 0) {
    return {
      ok: false,
      reason: 'NO HAZARD DATA AVAILABLE',
      waypoints: [],
      totalDistanceKm: 0,
      hazardsAvoidedCount: 0,
      hazardsNearRoute: [],
    };
  }

  // Enforce Hard Rule 1: Ensure Start & Destination points are in open ocean
  let startPt = { lat: startNorm.lat, lon: startNorm.lon, name: startNorm.name };
  let destPt = { lat: destNorm.lat, lon: destNorm.lon, name: destNorm.name };

  if (isPointOnLand(startPt.lat, startPt.lon)) {
    const oceanStart = findNearestOceanPoint(startPt.lat, startPt.lon);
    startPt = { lat: oceanStart.lat, lon: oceanStart.lon, name: `${startNorm.name} (Ocean Point)` };
  }

  if (isPointOnLand(destPt.lat, destPt.lon)) {
    const oceanDest = findNearestOceanPoint(destPt.lat, destPt.lon);
    destPt = { lat: oceanDest.lat, lon: oceanDest.lon, name: `${destNorm.name} (Ocean Point)` };
  }

  const directDist = geodesicDistanceKm(startPt.lat, startPt.lon, destPt.lat, destPt.lon);

  const enrichedHazards = (hazards || [])
    .map((h, i) => {
      const hLat = Number(h.lat ?? h.latitude);
      const hLon = Number(h.lon ?? h.longitude);
      const rad = Number(h.safetyRadiusKm) || calculateIcebergHazardRadiusKm(h, 2.0, safetyRadiusKm);
      return {
        id: h.id || `iceberg-${i}`,
        lat: hLat,
        lon: hLon,
        areaKm2: Number(h.areaKm2) || 0,
        safetyRadiusKm: rad,
        depthM: h.depthM ?? null,
        polygonCoordinates: h.polygonCoordinates || null,
      };
    })
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));

  for (const h of enrichedHazards) {
    const dStart = geodesicDistanceKm(startPt.lat, startPt.lon, h.lat, h.lon);
    if (dStart <= h.safetyRadiusKm) {
      return {
        ok: false,
        reason: 'START POINT IS INSIDE ICEBERG HAZARD ZONE',
        waypoints: [],
        totalDistanceKm: 0,
        hazardsAvoidedCount: 0,
        hazardsNearRoute: [],
      };
    }
    const dDest = geodesicDistanceKm(destPt.lat, destPt.lon, h.lat, h.lon);
    if (dDest <= h.safetyRadiusKm) {
      return {
        ok: false,
        reason: 'DESTINATION POINT IS INSIDE ICEBERG HAZARD ZONE',
        waypoints: [],
        totalDistanceKm: 0,
        hazardsAvoidedCount: 0,
        hazardsNearRoute: [],
      };
    }
  }

  const minLat = Math.min(startPt.lat, destPt.lat) - padDeg;
  const maxLat = Math.max(startPt.lat, destPt.lat) + padDeg;
  const minLon = Math.min(startPt.lon, destPt.lon) - (padDeg * 2.0);
  const maxLon = Math.max(startPt.lon, destPt.lon) + (padDeg * 2.0);

  const corridorHazards = enrichedHazards.filter(
    (h) => h.lat >= minLat - 0.20 && h.lat <= maxLat + 0.20 && h.lon >= minLon - 0.20 && h.lon <= maxLon + 0.20,
  );

  const directIsSafe = segmentIsSafe(startPt, destPt, corridorHazards, safetyRadiusKm);
  if (directIsSafe) {
    const numSamples = Math.max(4, Math.min(32, Math.ceil(directDist / 20)));
    const rawPoints = [];
    for (let i = 0; i <= numSamples; i++) {
      const frac = i / numSamples;
      const lat = startPt.lat + (destPt.lat - startPt.lat) * frac;
      const lon = startPt.lon + (destPt.lon - startPt.lon) * frac;
      rawPoints.push({ lat, lon });
    }

    const validDirect = validateSimulationRoute({ waypoints: rawPoints }, { hazards: corridorHazards, safetyRadiusKm });
    if (validDirect.valid) {
      const waypoints = finalizeWaypoints(rawPoints, corridorHazards);
      return {
        ok: true,
        waypoints,
        totalDistanceKm: directDist,
        directDistanceKm: directDist,
        hazardsAvoidedCount: 0,
        hazardsNearRoute: [],
        whyThisRouteReason: 'Route remains within navigable ocean and avoids Antarctic land.',
      };
    }
  }

  // A* Search Grid around land and icebergs
  let latStep = gridLatStepDeg;
  let lonStep = gridLonStepDeg;
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  if (latSpan / latStep > 140) latStep = latSpan / 120;
  if (lonSpan / lonStep > 140) lonStep = lonSpan / 120;

  const rows = Math.ceil(latSpan / latStep) + 1;
  const cols = Math.ceil(lonSpan / lonStep) + 1;
  const totalNodes = rows * cols;

  const blocked = new Uint8Array(totalNodes);
  const costPenalty = new Float32Array(totalNodes);

  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * latStep;
    for (let c = 0; c < cols; c++) {
      const lon = minLon + c * lonStep;
      const idx = r * cols + c;

      if (isPointOnLand(lat, lon)) {
        blocked[idx] = 1;
        continue;
      }

      for (let h = 0; h < corridorHazards.length; h++) {
        const hazard = corridorHazards[h];
        const dist = geodesicDistanceKm(lat, lon, hazard.lat, hazard.lon);
        if (dist < hazard.safetyRadiusKm) {
          blocked[idx] = 1;
          break;
        } else if (dist < hazard.safetyRadiusKm * 2.5) {
          const proximity = 1.0 - (dist - hazard.safetyRadiusKm) / (hazard.safetyRadiusKm * 1.5);
          costPenalty[idx] = Math.max(costPenalty[idx], Math.pow(proximity, 2) * 8.0);
        }
      }
    }
  }

  const getCell = (lat, lon) => {
    const r = Math.max(0, Math.min(rows - 1, Math.round((lat - minLat) / latStep)));
    const c = Math.max(0, Math.min(cols - 1, Math.round((lon - minLon) / lonStep)));
    return { r, c, idx: r * cols + c };
  };

  const startCell = getCell(startPt.lat, startPt.lon);
  const destCell = getCell(destPt.lat, destPt.lon);

  blocked[startCell.idx] = 0;
  blocked[destCell.idx] = 0;

  const gScore = new Float32Array(totalNodes).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(totalNodes).fill(-1);
  const closed = new Uint8Array(totalNodes);

  gScore[startCell.idx] = 0;
  const heap = new MinHeap();
  heap.push({
    idx: startCell.idx,
    priority: geodesicDistanceKm(startPt.lat, startPt.lon, destPt.lat, destPt.lon),
  });

  let reached = false;

  while (heap.size > 0) {
    const current = heap.pop();
    if (!current) break;
    const u = current.idx;

    if (u === destCell.idx) {
      reached = true;
      break;
    }

    if (closed[u]) continue;
    closed[u] = 1;

    const r = Math.floor(u / cols);
    const c = u % cols;
    const curG = gScore[u];
    const curLat = minLat + r * latStep;
    const curLon = minLon + c * lonStep;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;

        const v = nr * cols + nc;
        if (blocked[v] || closed[v]) continue;

        const nLat = minLat + nr * latStep;
        const nLon = minLon + nc * lonStep;

        if (edgeIntersectsLand(curLat, curLon, nLat, nLon)) continue;

        const bergCheck = checkEdgeIcebergObstacles(curLat, curLon, nLat, nLon, corridorHazards, safetyRadiusKm);
        if (bergCheck.intersects) continue;

        const stepDist = geodesicDistanceKm(curLat, curLon, nLat, nLon);
        const stepCost = stepDist * (1.0 + costPenalty[v]);
        const tentativeG = curG + stepCost;

        if (tentativeG < gScore[v]) {
          gScore[v] = tentativeG;
          parent[v] = u;
          const h = geodesicDistanceKm(nLat, nLon, destPt.lat, destPt.lon);
          heap.push({ idx: v, priority: tentativeG + h });
        }
      }
    }
  }

  if (!reached && gScore[destCell.idx] === Number.POSITIVE_INFINITY) {
    return {
      ok: false,
      reason: 'NO SAFE OCEAN ROUTE FOUND',
      waypoints: [],
      totalDistanceKm: 0,
      directDistanceKm: directDist,
      hazardsAvoidedCount: 0,
      hazardsNearRoute: corridorHazards,
    };
  }

  const rawWaypoints = [];
  let curIdx = destCell.idx;
  let steps = 0;
  while (curIdx !== -1 && curIdx >= 0 && curIdx < totalNodes && steps < totalNodes) {
    steps++;
    const r = Math.floor(curIdx / cols);
    const c = curIdx % cols;
    rawWaypoints.push({
      lat: minLat + r * latStep,
      lon: minLon + c * lonStep,
    });
    if (curIdx === startCell.idx) break;
    curIdx = parent[curIdx];
  }
  rawWaypoints.reverse();

  const smoothed = [startPt];
  let anchor = startPt;
  let anchorIdx = 0;

  while (anchorIdx < rawWaypoints.length - 1) {
    let furthest = anchorIdx + 1;
    for (let i = rawWaypoints.length - 1; i > anchorIdx; i--) {
      if (segmentIsSafe(anchor, rawWaypoints[i], corridorHazards, safetyRadiusKm)) {
        furthest = i;
        break;
      }
    }
    anchor = rawWaypoints[furthest];
    anchorIdx = furthest;
    smoothed.push(anchor);
  }

  if (segmentIsSafe(smoothed[smoothed.length - 1], destPt, corridorHazards, safetyRadiusKm)) {
    smoothed.push(destPt);
  }

  const finalized = finalizeWaypoints(smoothed, corridorHazards);

  let hazardsAvoidedCount = 0;
  const hazardsNearRoute = [];
  for (let h = 0; h < corridorHazards.length; h++) {
    const hazard = corridorHazards[h];
    const directD = distPointToSegmentKm(hazard.lat, hazard.lon, startPt.lat, startPt.lon, destPt.lat, destPt.lon);
    if (directD < hazard.safetyRadiusKm) {
      hazardsAvoidedCount++;
    }
    hazardsNearRoute.push(hazard);
  }

  return {
    ok: true,
    waypoints: finalized,
    totalDistanceKm: finalized[finalized.length - 1]?.cumulativeDistanceKm || directDist,
    directDistanceKm: directDist,
    hazardsAvoidedCount,
    hazardsNearRoute,
    whyThisRouteReason: hazardsAvoidedCount > 0
      ? `Detour generated to maintain iceberg safety clearance (${safetyRadiusKm} km buffer) while avoiding Antarctic land.`
      : 'Route remains within navigable ocean and avoids Antarctic land.',
  };
}

/**
 * Enrich raw points into complete navigation waypoints with distances, bearings, compass, and clearance.
 * @private
 */
function finalizeWaypoints(points, hazards = []) {
  if (!Array.isArray(points) || points.length === 0) return [];

  const waypoints = [];
  let cumulativeDist = 0;

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const prev = i > 0 ? points[i - 1] : null;
    const next = i < points.length - 1 ? points[i + 1] : null;

    const cLat = Number(curr.lat ?? curr.latitude);
    const cLon = Number(curr.lon ?? curr.longitude);
    const legDist = prev ? geodesicDistanceKm(Number(prev.lat ?? prev.latitude), Number(prev.lon ?? prev.longitude), cLat, cLon) : 0;
    cumulativeDist += legDist;

    const bearingToNext = next ? calculateBearing(cLat, cLon, Number(next.lat ?? next.latitude), Number(next.lon ?? next.longitude)) : null;
    const compassDir = bearingToNext !== null ? bearingToCompassDirection(bearingToNext) : 'ARRIVED';

    let minBergDist = Infinity;
    for (const h of hazards) {
      const d = geodesicDistanceKm(cLat, cLon, h.lat, h.lon);
      if (d < minBergDist) minBergDist = d;
    }

    const isStart = i === 0;
    const isDest = i === points.length - 1;
    const wpType = isStart ? 'START' : isDest ? 'DESTINATION' : (curr.isDetour ? 'OBSTACLE DETOUR' : 'CHECKPOINT');

    waypoints.push({
      id: `WP-${String(i + 1).padStart(2, '0')}`,
      latitude: cLat,
      longitude: cLon,
      lat: cLat,
      lon: cLon,
      legDistanceKm: Math.round(legDist * 10) / 10,
      cumulativeDistanceKm: Math.round(cumulativeDist * 10) / 10,
      bearing_to_next: bearingToNext,
      bearingDegrees: bearingToNext,
      compass_direction: compassDir,
      compassDirection: compassDir,
      sea_ice_concentration: 0,
      iceberg_clearance: Number.isFinite(minBergDist) ? Math.round(minBergDist * 10) / 10 : 999,
      type: wpType,
      waypointType: wpType,
    });
  }

  return waypoints;
}

/**
 * Calculate compass bearing in degrees (0..360) between two coordinates.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Bearing in degrees
 */
export function calculateBearingDeg(lat1, lon1, lat2, lon2) {
  return calculateBearing(lat1, lon1, lat2, lon2);
}

/**
 * Interpolate current vessel position, heading, required bearing, compass direction, and heading error along route waypoints.
 * Enforces hard rule: Interpolated vessel position is ALWAYS validated against land.
 * @param {Array<object>} waypoints
 * @param {number} currentDistKm
 * @returns {object} { lat, lon, headingDeg, requiredBearing, compassDirection, headingError, progressRatio, completed }
 */
export function interpolatePositionAlongRoute(waypoints, currentDistKm) {
  if (!waypoints || waypoints.length === 0) {
    return { lat: 0, lon: 0, headingDeg: 0, requiredBearing: 0, compassDirection: 'N', headingError: 0, progressRatio: 0, completed: true };
  }

  const lastWp = waypoints[waypoints.length - 1];
  const totalDist = lastWp.cumulativeDistanceKm || 1;
  const clampedDist = Math.max(0, Math.min(totalDist, currentDistKm));
  const progressRatio = clampedDist / totalDist;

  if (clampedDist >= totalDist || waypoints.length === 1) {
    const last = lastWp;
    const prev = waypoints.length >= 2 ? waypoints[waypoints.length - 2] : last;
    const heading = calculateBearing(prev.lat, prev.lon, last.lat, last.lon);
    const validPos = validateOceanPosition(last.lat, last.lon);

    return {
      lat: validPos.lat,
      lon: validPos.lon,
      headingDeg: heading,
      requiredBearing: heading,
      compassDirection: bearingToCompassDirection(heading),
      headingError: 0,
      progressRatio: 1.0,
      completed: true,
    };
  }

  let segIdx = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    if (clampedDist <= waypoints[i + 1].cumulativeDistanceKm) {
      segIdx = i;
      break;
    }
  }

  const p1 = waypoints[segIdx];
  const p2 = waypoints[segIdx + 1];
  const legLen = p2.cumulativeDistanceKm - p1.cumulativeDistanceKm;
  const legOffset = clampedDist - p1.cumulativeDistanceKm;
  const t = legLen > 0 ? legOffset / legLen : 0;

  const rawLat = p1.lat + (p2.lat - p1.lat) * t;
  const rawLon = p1.lon + (p2.lon - p1.lon) * t;

  const validPos = validateOceanPosition(rawLat, rawLon);

  const reqBearing = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
  const compassDir = bearingToCompassDirection(reqBearing);

  return {
    lat: validPos.lat,
    lon: validPos.lon,
    headingDeg: reqBearing,
    requiredBearing: reqBearing,
    compassDirection: compassDir,
    headingError: 0,
    progressRatio,
    completed: false,
    isLandCorrected: validPos.isLand,
  };
}

/**
 * ANTARIS Live Voyage Guidance & Navigation Engine
 *
 * Calculates real-time navigational metrics for following planned maritime routes:
 * - Waypoint sequence progress & arrival radius detection
 * - True bearings (° TRUE) & 16-wind compass directions
 * - Smallest signed heading error correction [-180°, +180°]
 * - Cross-track perpendicular error distance & deviation status
 * - Distance remaining & speed-based ETA estimation
 */

import {
  geodesicDistanceKm,
  calculateBearing,
  bearingToCompassDirection,
  calculateHeadingDifference,
  calculateCrossTrackDistance,
  calculateETA,
} from './geoMath.mjs';
import { calculateFuelConsumption } from './fuelModel.mjs';

/** Default arrival radius in kilometers for automatically advancing to next waypoint (~2.7 NM) */
export const DEFAULT_WAYPOINT_ARRIVAL_RADIUS_KM = 5.0;

/**
 * Calculate comprehensive voyage guidance metrics for a planned route.
 * @param {object} routeData - Canonical route object from calculateMaritimeRoute
 * @param {object|null} vesselState - Optional vessel position { latitude, longitude, heading, speedKnots }
 * @param {object} [options]
 * @returns {object} Voyage guidance status & navigation parameters
 */
export function calculateVoyageGuidance(routeData, vesselState = null, options = {}) {
  const arrivalRadiusKm = options.arrivalRadiusKm || DEFAULT_WAYPOINT_ARRIVAL_RADIUS_KM;
  const plannedSpeedKnots = options.plannedSpeedKnots || 18.0; // 18 knots default cruising speed

  if (!routeData || !Array.isArray(routeData.waypoints) || routeData.waypoints.length === 0) {
    return {
      active: false,
      reason: 'No active maritime route available',
    };
  }

  const waypoints = routeData.waypoints;
  const segments = routeData.segments || [];

  // Determine current vessel position
  const hasVesselPosition = Boolean(
    vesselState &&
    Number.isFinite(Number(vesselState.latitude ?? vesselState.lat)) &&
    Number.isFinite(Number(vesselState.longitude ?? vesselState.lon))
  );

  const vesselLat = hasVesselPosition ? Number(vesselState.latitude ?? vesselState.lat) : waypoints[0].latitude;
  const vesselLon = hasVesselPosition ? Number(vesselState.longitude ?? vesselState.lon) : waypoints[0].longitude;

  const vesselHeading = (hasVesselPosition && Number.isFinite(Number(vesselState.heading ?? vesselState.headingDeg)))
    ? Number(vesselState.heading ?? vesselState.headingDeg)
    : null;

  const vesselSpeed = (hasVesselPosition && Number.isFinite(Number(vesselState.speedKnots ?? vesselState.speed)))
    ? Number(vesselState.speedKnots ?? vesselState.speed)
    : plannedSpeedKnots;

  // Compute total planned route length across all waypoints
  let totalRouteKm = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    totalRouteKm += geodesicDistanceKm(waypoints[i].latitude, waypoints[i].longitude, waypoints[i + 1].latitude, waypoints[i + 1].longitude);
  }
  totalRouteKm = Math.round((routeData.metrics?.distance_km || totalRouteKm) * 10) / 10;

  // 1. DETERMINE ACTIVE SEGMENT & NEXT WAYPOINT PROGRESSION
  let nextWpIdx = 1;
  const destWp = waypoints[waypoints.length - 1];
  const distToDest = geodesicDistanceKm(vesselLat, vesselLon, destWp.latitude, destWp.longitude);

  if (options.targetWaypointIndex !== undefined && options.targetWaypointIndex !== null && options.targetWaypointIndex >= 0 && options.targetWaypointIndex < waypoints.length) {
    nextWpIdx = options.targetWaypointIndex;
  } else if (!hasVesselPosition || geodesicDistanceKm(vesselLat, vesselLon, waypoints[0].latitude, waypoints[0].longitude) < 0.5) {
    // Vessel at start point
    nextWpIdx = Math.min(1, waypoints.length - 1);
  } else if (distToDest <= arrivalRadiusKm) {
    // Vessel arrived at destination
    nextWpIdx = waypoints.length - 1;
  } else {
    // Find active segment [i-1, i] that vessel is traversing by minimizing path excess
    let minPathExcess = Infinity;
    let bestSegmentIdx = 1;

    for (let i = 1; i < waypoints.length; i++) {
      const prevWp = waypoints[i - 1];
      const wp = waypoints[i];
      const distToPrev = geodesicDistanceKm(vesselLat, vesselLon, prevWp.latitude, prevWp.longitude);
      const distToNext = geodesicDistanceKm(vesselLat, vesselLon, wp.latitude, wp.longitude);
      const legDist = geodesicDistanceKm(prevWp.latitude, prevWp.longitude, wp.latitude, wp.longitude);

      const excess = (distToPrev + distToNext) - legDist;

      if (excess < minPathExcess) {
        minPathExcess = excess;
        bestSegmentIdx = i;
      }

      // If vessel is within arrival radius of waypoint i (and not at dest), advance target to i+1
      if (distToNext <= arrivalRadiusKm && i < waypoints.length - 1) {
        bestSegmentIdx = Math.min(waypoints.length - 1, i + 1);
      }
    }
    nextWpIdx = bestSegmentIdx;
  }

  const nextWaypoint = waypoints[nextWpIdx];
  const prevWaypoint = waypoints[Math.max(0, nextWpIdx - 1)];

  // 2. CALCULATE BEARING & COMPASS DIRECTION TO NEXT WAYPOINT
  const requiredBearing = calculateBearing(vesselLat, vesselLon, nextWaypoint.latitude, nextWaypoint.longitude);
  const compassDir = bearingToCompassDirection(requiredBearing);

  // 3. CALCULATE DISTANCES (Distance to next WP, Remaining Route Km, Completed Route Km, Progress %)
  const distanceToNextKm = Math.round(geodesicDistanceKm(vesselLat, vesselLon, nextWaypoint.latitude, nextWaypoint.longitude) * 10) / 10;

  let remainingRouteKm = distanceToNextKm;
  for (let i = nextWpIdx; i < waypoints.length - 1; i++) {
    remainingRouteKm += geodesicDistanceKm(waypoints[i].latitude, waypoints[i].longitude, waypoints[i + 1].latitude, waypoints[i + 1].longitude);
  }
  remainingRouteKm = Math.min(totalRouteKm, Math.round(remainingRouteKm * 10) / 10);

  let routeStatus = 'PLANNED';
  if (distToDest <= arrivalRadiusKm) {
    routeStatus = 'ARRIVED';
    remainingRouteKm = 0;
  } else if (!hasVesselPosition) {
    routeStatus = 'PLANNED';
  } else {
    routeStatus = 'NAVIGATING';
  }

  const completedRouteKm = Math.max(0, Math.round((totalRouteKm - remainingRouteKm) * 10) / 10);
  const progressPercent = totalRouteKm > 0 ? Math.min(100, Math.max(0, Math.round((completedRouteKm / totalRouteKm) * 100))) : 0;

  // 4. HEADING CORRECTION
  const headingCorrection = vesselHeading !== null
    ? calculateHeadingDifference(vesselHeading, requiredBearing)
    : null;

  // 5. CROSS-TRACK ERROR & STATUS
  let crossTrackErrorKm = null;
  let crossTrackStatus = 'ON_TRACK';

  if (hasVesselPosition && prevWaypoint && nextWaypoint && prevWaypoint.id !== nextWaypoint.id) {
    crossTrackErrorKm = Math.round(calculateCrossTrackDistance(
      vesselLat, vesselLon,
      prevWaypoint.latitude, prevWaypoint.longitude,
      nextWaypoint.latitude, nextWaypoint.longitude
    ) * 10) / 10;

    if (crossTrackErrorKm > 10.0) {
      crossTrackStatus = 'SIGNIFICANT_DEVIATION';
      if (routeStatus === 'NAVIGATING') routeStatus = 'OFF_ROUTE';
    } else if (crossTrackErrorKm > 3.0) {
      crossTrackStatus = 'SLIGHT_DEVIATION';
    } else {
      crossTrackStatus = 'ON_TRACK';
    }
  } else if (hasVesselPosition) {
    crossTrackErrorKm = 0.0;
  }

  // 6. ETA ESTIMATION
  let etaInfo;
  if (routeStatus === 'ARRIVED' || remainingRouteKm <= 0.1) {
    etaInfo = { hours: 0, minutes: 0, formattedDuration: 'ARRIVED' };
  } else {
    etaInfo = calculateETA(remainingRouteKm, vesselSpeed);
  }

  // 7. FUEL ESTIMATION BASED ON COMPLETED & REMAINING DISTANCE
  const avgIceConc = routeData.metrics?.average_ice_concentration || 0;
  const fuelRemainingCalc = calculateFuelConsumption(remainingRouteKm, vesselSpeed, null, { averageIceConcentration: avgIceConc });
  const fuelUsedCalc = calculateFuelConsumption(completedRouteKm, vesselSpeed, null, { averageIceConcentration: avgIceConc });
  const totalFuelCalc = calculateFuelConsumption(totalRouteKm, vesselSpeed, null, { averageIceConcentration: avgIceConc });

  const fuelInfo = {
    ...(fuelRemainingCalc.status === 'ESTIMATED' ? fuelRemainingCalc : (routeData.metrics?.fuel || routeData.fuel || {})),
    fuelUsedLiters: fuelUsedCalc.status === 'ESTIMATED' ? fuelUsedCalc.estimatedFuelLiters : 0,
    fuelUsedKg: fuelUsedCalc.status === 'ESTIMATED' ? fuelUsedCalc.totalFuelKg : 0,
    fuelRemainingLiters: fuelRemainingCalc.status === 'ESTIMATED' ? fuelRemainingCalc.estimatedFuelLiters : 0,
    fuelRemainingKg: fuelRemainingCalc.status === 'ESTIMATED' ? fuelRemainingCalc.totalFuelKg : 0,
    totalPlannedFuelLiters: totalFuelCalc.status === 'ESTIMATED' ? totalFuelCalc.estimatedFuelLiters : (routeData.metrics?.fuel?.estimatedFuelLiters || null),
  };

  // 8. ICEBERG CLEARANCE & SEA ICE CONCENTRATION
  let icebergClearanceKm = routeData.metrics?.minimum_iceberg_distance_km ?? null;
  const hazards = routeData.hazards || routeData.hazardsNearRoute || routeData.selectedOption?.hazardsNearRoute || [];
  if (Array.isArray(hazards) && hazards.length > 0) {
    let minD = Infinity;
    for (const h of hazards) {
      const hLat = h.latitude ?? h.lat;
      const hLon = h.longitude ?? h.lon;
      if (Number.isFinite(hLat) && Number.isFinite(hLon)) {
        const d = geodesicDistanceKm(vesselLat, vesselLon, hLat, hLon);
        if (d < minD) minD = d;
      }
    }
    if (Number.isFinite(minD)) {
      icebergClearanceKm = Math.round(minD * 10) / 10;
    }
  }

  const seaIceConcentration = nextWaypoint.sea_ice_concentration || routeData.metrics?.average_ice_concentration || 0;
  const maxSeaIceConcentration = routeData.metrics?.maximum_ice_concentration || seaIceConcentration;

  let riskScore = routeData.metrics?.risk_score || 0;
  if (crossTrackStatus === 'SIGNIFICANT_DEVIATION') {
    riskScore = Math.min(100, riskScore + 25);
  }

  return {
    active: true,
    hasVesselPosition,
    vesselPosition: { latitude: vesselLat, longitude: vesselLon },
    vesselHeading,
    vesselSpeedKnots: vesselSpeed,
    nextWaypointIndex: nextWpIdx,
    nextWaypoint: {
      id: nextWaypoint.id,
      sequence: nextWaypoint.sequence,
      latitude: nextWaypoint.latitude,
      longitude: nextWaypoint.longitude,
      sea_ice_concentration: nextWaypoint.sea_ice_concentration,
      type: nextWaypoint.type,
      routing_reason: nextWaypoint.routing_reason || 'Course waypoint',
    },
    requiredBearingDegrees: requiredBearing,
    compassDirection: compassDir,
    distanceToNextKm,
    distanceRemainingKm: remainingRouteKm,
    completedDistanceKm: completedRouteKm,
    progressPercent: progressPercent,
    totalDistanceKm: totalRouteKm,
    headingErrorDegrees: headingCorrection,
    crossTrackErrorKm,
    crossTrackStatus,
    icebergClearanceKm,
    seaIceConcentration,
    maxSeaIceConcentration,
    riskScore,
    eta: etaInfo,
    fuel: fuelInfo,
    routeStatus,
    whyThisRouteReason: routeData.metrics?.why_this_route_reason || routeData.whyThisRouteReason || '',
  };
}

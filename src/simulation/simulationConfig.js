/**
 * @file simulationConfig.js
 * Centralized scenario configuration for Simulation 1 and Simulation 2.
 * All coordinates are defined in navigable Southern Ocean waters around Antarctica.
 */

export const SIMULATION_1_CONFIG = Object.freeze({
  id: 'sim-1',
  name: 'Simulation 1: Safe Route Navigation',
  description: 'Antarctic maritime transit avoiding grounded iceberg hazard zones and Antarctic land',

  // Start point: Navigable open Southern Ocean (D'Urville Sea offshore approach)
  start: Object.freeze({
    latitude: -65.40,
    longitude: 135.25,
    name: "Outer D'Urville Sea Approach (NW)",
  }),

  // Destination: Offshore anchorage (Clear open waters)
  destination: Object.freeze({
    latitude: -65.65,
    longitude: 136.85,
    name: 'Adélie Coast Offshore Anchorage',
  }),

  // Safety buffer radius around every detected iceberg (in kilometers)
  icebergSafetyRadiusKm: 3.5,

  // Base physical ship cruising speed in knots (1 knot = 0.514444 m/s)
  baseSpeedKnots: 15,
  knotToMps: 0.514444,

  // Calibration duration in seconds for 1X playback across full route (~102 km)
  simulationDurationSeconds: 75,

  // Pathfinding grid settings
  gridLatStepDeg: 0.012,
  gridLonStepDeg: 0.028,
  corridorPaddingDeg: 0.25,
});

export const SIMULATION_2_CONFIG = Object.freeze({
  id: 'sim-2',
  name: 'Simulation 2: Iceberg Proximity Warning',
  description: 'Real-time iceberg hazard detection, proximity alert zones, and automatic route response in ocean waters',

  targetIceberg: Object.freeze({
    id: 620,
    latitude: -65.65,
    longitude: 135.83239956078376,
    areaKm2: 0.6248482650541312,
    bedDepthM: -450,
    name: 'Iceberg #1 (Primary)',
  }),

  iceberg2: Object.freeze({
    id: 621,
    latitude: -65.60,
    longitude: 135.80,
    areaKm2: 0.5,
    name: 'Iceberg #2',
  }),

  iceberg3: Object.freeze({
    id: 622,
    latitude: -65.70,
    longitude: 135.90,
    areaKm2: 0.5,
    name: 'Iceberg #3',
  }),

  movingIceberg: Object.freeze({
    id: 999,
    startLatitude: -65.58,
    startLongitude: 136.00,
    velocityLat: 0.0005, // degrees per second
    velocityLon: -0.001,
    areaKm2: 0.5,
    name: 'Moving Iceberg',
  }),

  fisheryHotspot: Object.freeze({
    latitude: -65.55,
    longitude: 135.60,
    name: 'Designated Fishery Hotspot',
    radiusKm: 6.0,
  }),

  // Extended Start point: Open ocean ~19.7 km Northwest of Iceberg 620
  start: Object.freeze({
    latitude: -65.5000,
    longitude: 135.4500,
    name: "Outer D'Urville Sea Approach (NW)",
  }),

  // Extended Destination: Eastern anchorage in clear ocean waters East-Northeast of Iceberg 620
  destination: Object.freeze({
    latitude: -65.5500,
    longitude: 136.2500, // Move destination further east to allow room for moving iceberg sequence
    name: 'Commonwealth Bay Offshore Anchorage',
  }),

  approachKeypoints: Object.freeze([
    Object.freeze({ lat: -65.5000, lon: 135.4500 }),
    Object.freeze({ lat: -65.55, lon: 135.60 }), // pass through fishery
    Object.freeze({ lat: -65.65, lon: 135.8324 }), // Aim at primary iceberg
    Object.freeze({ lat: -65.5500, lon: 136.2500 }),
  ]),

  // Critical detection thresholds
  warningDistanceKm: 12.0,   // Msg begins at 12 km
  sirenDistanceKm: 10.0,     // Siren rings at 10 km
  dangerDistanceKm: 8.0,     // Rerouting takes place at 8 km
  icebergSafetyRadiusKm: 4.0,// Safety clearance buffer around iceberg
  sirenPauseSeconds: 1.0,

  // Cruising physics
  baseSpeedKnots: 15,
  knotToMps: 0.514444,
  timeCompressionFactor: 65,

  // Pathfinding grid settings for rerouting
  gridLatStepDeg: 0.012,
  gridLonStepDeg: 0.028,
  corridorPaddingDeg: 0.25,

  presets: Object.freeze([]),
  fishingHotspotProfiles: Object.freeze([]),
});

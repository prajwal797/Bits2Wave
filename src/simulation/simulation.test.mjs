import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { createSimulationState } from './simulationState.js';
import { Simulation1 } from './simulation1.js';
import { Simulation2 } from './simulation2.js';
import { SimulationManager } from './simulationManager.js';
import {
  haversineDistanceKm,
  distPointToSegmentKm,
  segmentIsSafe,
  filterCorridorHazards,
  calculateIcebergHazardRadiusKm,
  calculateSafeRoute,
  interpolatePositionAlongRoute,
  calculateBearingDeg,
  normalizeCoordinate,
} from './routing.js';

test('haversineDistanceKm calculates accurate geographic distances', () => {
  // Distance from London (51.5074, -0.1278) to Paris (48.8566, 2.3522) is ~343.5 km
  const dist = haversineDistanceKm(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(Math.abs(dist - 343.5) < 3.0, `Expected ~343.5 km, got ${dist}`);

  // Zero distance
  assert.equal(haversineDistanceKm(10, 20, 10, 20), 0);
});

test('distPointToSegmentKm accurately detects hazard clearance', () => {
  // Segment along latitude line from (0, 0) to (0, 1) (~111 km)
  // Hazard at (0.05, 0.5): offset of 0.05 deg lat is ~5.5 km
  const d = distPointToSegmentKm(0.05, 0.5, 0, 0, 0, 1);
  assert.ok(Math.abs(d - 5.53) < 0.3, `Expected ~5.5 km, got ${d}`);

  // Point far beyond segment end
  const dFar = distPointToSegmentKm(0, 2, 0, 0, 0, 1);
  assert.ok(dFar > 100);
});

test('calculateSafeRoute navigates around hazard obstacle and respects safety radius', () => {
  const start = { latitude: -65.70, longitude: 135.25 };
  const destination = { latitude: -66.15, longitude: 136.85 };

  // Place a major hazard directly between start and destination
  const midLat = (-65.70 + -66.15) / 2;
  const midLon = (135.25 + 136.85) / 2;
  const hazards = [
    { lat: midLat, lon: midLon, id: 'obstacle-1' },
    { lat: midLat + 0.02, lon: midLon + 0.01, id: 'obstacle-2' },
  ];

  const safetyRadiusKm = 4.0;
  const result = calculateSafeRoute({
    start,
    destination,
    hazards,
    safetyRadiusKm,
    gridLatStepDeg: 0.02,
    gridLonStepDeg: 0.04,
  });

  assert.equal(result.ok, true);
  assert.ok(result.waypoints.length >= 2);
  assert.ok(result.totalDistanceKm > result.directDistanceKm);

  // Verify all waypoints and segments clear the hazard buffer
  for (let i = 0; i < result.waypoints.length - 1; i++) {
    const p1 = result.waypoints[i];
    const p2 = result.waypoints[i + 1];
    for (const h of hazards) {
      const clearance = distPointToSegmentKm(h.lat, h.lon, p1.lat, p1.lon, p2.lat, p2.lon);
      assert.ok(
        clearance >= safetyRadiusKm - 0.2, // tolerance for grid discretization
        `Hazard clearance violated: ${clearance.toFixed(2)} km < ${safetyRadiusKm} km`,
      );
    }
  }
});

test('calculateSafeRoute returns explicit failure when no hazard data is available', () => {
  const result = calculateSafeRoute({
    start: { latitude: 0, longitude: 0 },
    destination: { latitude: 1, longitude: 1 },
    hazards: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO HAZARD DATA AVAILABLE');
});

test('calculateIcebergHazardRadiusKm calculates dynamic safety radius from area and polygons', () => {
  // 1. From Area: Area 3.14159 km² gives r_eq = 1.0 km + buffer 2.0 km = 3.0 km -> clamped to min 3.5 km
  const rMin = calculateIcebergHazardRadiusKm({ areaKm2: 3.14159 }, 2.0, 3.5);
  assert.equal(rMin, 3.5);

  // 2. From Area: Area 50.0 km² gives r_eq = ~3.99 km + buffer 2.0 km = ~5.99 km
  const rLarge = calculateIcebergHazardRadiusKm({ areaKm2: 50.0 }, 2.0, 3.5);
  assert.ok(Math.abs(rLarge - 5.99) < 0.1, `Expected ~5.99 km, got ${rLarge}`);

  // 3. Fallback when no dimensions
  const rDefault = calculateIcebergHazardRadiusKm({}, 2.0, 3.5);
  assert.equal(rDefault, 3.5);
});

test('calculateSafeRoute rejects with explicit reason when start or destination is inside an iceberg', () => {
  const iceberg = { lat: -65.70, lon: 135.25, safetyRadiusKm: 5.0, id: 'blocking-berg' };

  // Start directly inside iceberg
  const resStartBlocked = calculateSafeRoute({
    start: { latitude: -65.701, longitude: 135.251 },
    destination: { latitude: -66.15, longitude: 136.85 },
    hazards: [iceberg],
  });
  assert.equal(resStartBlocked.ok, false);
  assert.equal(resStartBlocked.reason, 'START POINT IS INSIDE ICEBERG HAZARD ZONE');

  // Destination directly inside iceberg
  const resDestBlocked = calculateSafeRoute({
    start: { latitude: -65.00, longitude: 134.00 },
    destination: { latitude: -65.702, longitude: 135.252 },
    hazards: [iceberg],
  });
  assert.equal(resDestBlocked.ok, false);
  assert.equal(resDestBlocked.reason, 'DESTINATION POINT IS INSIDE ICEBERG HAZARD ZONE');
});

test('interpolatePositionAlongRoute smoothly calculates position, heading and progress', () => {
  const waypoints = [
    { lat: -65.0, lon: 135.0, legDistanceKm: 0, cumulativeDistanceKm: 0 },
    { lat: -65.5, lon: 135.5, legDistanceKm: 60, cumulativeDistanceKm: 60 },
    { lat: -66.0, lon: 136.0, legDistanceKm: 60, cumulativeDistanceKm: 120 },
  ];

  // At start
  const p0 = interpolatePositionAlongRoute(waypoints, 0);
  assert.equal(p0.lat, -65.0);
  assert.equal(p0.lon, 135.0);
  assert.equal(p0.progressRatio, 0);
  assert.equal(p0.completed, false);

  // Midway (60 km = waypoint 1)
  const pMid = interpolatePositionAlongRoute(waypoints, 60);
  assert.ok(Math.abs(pMid.lat - (-65.5)) < 0.001);
  assert.ok(Math.abs(pMid.lon - 135.5) < 0.001);
  assert.equal(pMid.progressRatio, 0.5);

  // At destination
  const pEnd = interpolatePositionAlongRoute(waypoints, 120);
  assert.equal(pEnd.lat, -66.0);
  assert.equal(pEnd.lon, 136.0);
  assert.equal(pEnd.progressRatio, 1.0);
  assert.equal(pEnd.completed, true);
});

test('Simulation1 lifecycle: prepare, start, pause, resume, reset', async () => {
  const sim = new Simulation1();
  assert.equal(sim.active, false);
  assert.equal(sim.running, false);

  // Manually mock hazards so tests run offline without network fetch
  sim.hazards = [
    { id: 1, lat: -65.9, lon: 136.0, areaKm2: 2.0 },
    { id: 2, lat: -65.95, lon: 136.1, areaKm2: 1.5 },
  ];

  const plan = await sim.prepareScenario();
  assert.equal(plan.ok, true);
  assert.ok(sim.route.waypoints.length >= 2);
  assert.equal(sim.distanceTraveledKm, 0);

  // Start
  await sim.start();
  assert.equal(sim.running, true);
  assert.equal(sim.paused, false);

  // Pause
  sim.pause();
  assert.equal(sim.paused, true);
  assert.equal(sim.running, true);

  // Resume
  sim.resume();
  assert.equal(sim.paused, false);

  // Speed change
  sim.setSpeed(4);
  assert.equal(sim.speedMultiplier, 4);

  // Reset
  sim.reset();
  assert.equal(sim.running, false);
  assert.equal(sim.paused, false);
  assert.equal(sim.distanceTraveledKm, 0);

  sim.destroy();
});

test('SimulationManager manages button states and real-time Simulation 1 coordination', async () => {
  // Minimal DOM mock
  class MockElement {
    constructor() {
      this.className = '';
      this.textContent = '';
      this.dataset = {};
      this.children = [];
      this.hidden = false;
      this.disabled = false;
      this.style = {};
      this._attrs = {};
      this._listeners = {};
    }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, val) { this._attrs[name] = String(val); }
    getAttribute(name) { return this._attrs[name] ?? null; }
    removeAttribute(name) { delete this._attrs[name]; }
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }
    click() { for (const fn of this._listeners.click || []) fn(); }
    querySelector() { return null; }
    remove() {}
  }

  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => new MockElement() };

  try {
    const container = new MockElement();
    const mgr = new SimulationManager();
    mgr.initialize({ container });

    // Inject mock hazards so plan succeeds synchronously
    mgr.sim1.hazards = [
      { id: 1, lat: -65.9, lon: 136.0, areaKm2: 2.0 },
    ];

    // Select Simulation 1
    await mgr.enableSimulation1();
    assert.equal(mgr.getActiveSimulation(), 'sim-1');

    // Initial state: START is ENABLED, Pause/Resume disabled, Reset enabled
    assert.equal(mgr._dom.btnStart.disabled, false);
    assert.equal(mgr._dom.btnPause.disabled, true);
    assert.equal(mgr._dom.btnResume.disabled, true);
    assert.equal(mgr._dom.btnReset.disabled, false);

    // Click START
    await mgr.start();
    assert.equal(mgr._dom.btnStart.disabled, true);
    assert.equal(mgr._dom.btnPause.disabled, false);
    assert.equal(mgr._dom.btnResume.disabled, true);
    assert.equal(mgr._dom.btnReset.disabled, false);

    // Click PAUSE
    mgr.pause();
    assert.equal(mgr._dom.btnStart.disabled, true);
    assert.equal(mgr._dom.btnPause.disabled, true);
    assert.equal(mgr._dom.btnResume.disabled, false);
    assert.equal(mgr._dom.btnReset.disabled, false);

    // Click RESUME
    mgr.resume();
    assert.equal(mgr._dom.btnStart.disabled, true);
    assert.equal(mgr._dom.btnPause.disabled, false);
    assert.equal(mgr._dom.btnResume.disabled, true);

    // Click RESET
    mgr.reset();
    assert.equal(mgr._dom.btnStart.disabled, false);
    assert.equal(mgr._dom.btnPause.disabled, true);
    assert.equal(mgr._dom.btnResume.disabled, true);
    assert.equal(mgr._dom.btnReset.disabled, false);

    mgr.destroy();
  } finally {
    globalThis.document = prevDoc;
  }
});

test('normalizeCoordinate validates and normalizes different coordinate input shapes', () => {
  // Lat/lon object
  const c1 = normalizeCoordinate({ lat: -65.5, lon: 135.2 });
  assert.equal(c1.latitude, -65.5);
  assert.equal(c1.longitude, 135.2);
  assert.equal(c1.lat, -65.5);
  assert.equal(c1.lon, 135.2);

  // Latitude/longitude object
  const c2 = normalizeCoordinate({ latitude: 35.68, longitude: 139.76, name: 'Tokyo' });
  assert.equal(c2.latitude, 35.68);
  assert.equal(c2.longitude, 139.76);
  assert.equal(c2.name, 'Tokyo');

  // Pin label object
  const c3 = normalizeCoordinate({ lat: -68.2, lon: -65.1, label: 'Pin: -68.2000°, -65.1000°' });
  assert.equal(c3.latitude, -68.2);
  assert.equal(c3.name, 'Pin: -68.2000°, -65.1000°');

  // Invalid inputs
  assert.equal(normalizeCoordinate(null), null);
  assert.equal(normalizeCoordinate({ lat: 100, lon: 0 }), null);
  assert.equal(normalizeCoordinate({ lat: NaN, lon: 10 }), null);
  assert.equal(normalizeCoordinate('not-an-obj'), null);
});

test('Simulation1 rebuildScenario creates fresh route, SampledPositionProperty, and resets to new coordinates', async () => {
  const sim1 = new Simulation1();
  sim1.hazards = [
    { id: 1, lat: -65.9, lon: 136.0, areaKm2: 2.0 },
  ];

  // 1. Initial scenario
  await sim1.prepareScenario();
  const initStart = sim1.getStart();
  assert.equal(initStart.latitude, sim1.config.start.latitude);
  assert.equal(sim1.currentPosition.lat, initStart.latitude);

  // 2. Rebuild with completely different coordinates (Antarctic location B)
  const newStart = { lat: -64.80, lon: 134.50, name: 'Custom Station Alpha' };
  const newDest = { lat: -65.40, lon: 136.20, name: 'Custom Station Beta' };

  const rebuildRes = await sim1.rebuildScenario(newStart, newDest);
  assert.equal(rebuildRes.ok, true);
  assert.equal(sim1.customStart.latitude, -64.80);
  assert.equal(sim1.customDestination.latitude, -65.40);
  assert.equal(sim1.currentPosition.lat, -64.80);
  assert.equal(sim1.currentPosition.lon, 134.50);
  assert.ok(sim1.sampledPosition !== null);
  assert.ok(sim1.route.waypoints.length >= 2);
  assert.equal(sim1.completed, false);
  assert.equal(sim1.running, false);

  // 3. Reset must reset to Custom Station Alpha (-64.80), NOT original config (-65.70)
  sim1.reset();
  assert.equal(sim1.currentPosition.lat, -64.80);
  assert.equal(sim1.currentPosition.lon, 134.50);

  // 4. Change only destination
  const newDest2 = { lat: -66.10, lon: 137.00, name: 'Custom Station Gamma' };
  const rebuildRes2 = await sim1.rebuildScenario(null, newDest2);
  assert.equal(rebuildRes2.ok, true);
  assert.equal(sim1.currentPosition.lat, -64.80); // Start stays Alpha
  assert.equal(sim1.customDestination.latitude, -66.10); // Dest becomes Gamma

  // 5. Change only start
  const newStart2 = { lat: -64.20, lon: 133.80, name: 'Custom Station Delta' };
  const rebuildRes3 = await sim1.rebuildScenario(newStart2, null);
  assert.equal(rebuildRes3.ok, true);
  assert.equal(sim1.currentPosition.lat, -64.20); // Start becomes Delta
  assert.equal(sim1.customDestination.latitude, -66.10); // Dest stays Gamma

  sim1.destroy();
});

test('Entity deduplication: exactly one route and one ship after repeated start, resets, and rebuilds', async () => {
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
    get values() {
      return Array.from(entityStore.values());
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const sim1 = new Simulation1({ viewer: mockViewer });
  sim1.hazards = [{ id: 1, lat: -65.9, lon: 136.0, areaKm2: 2.0 }];

  // 1. Initial prepare & start
  await sim1.prepareScenario();
  await sim1.start();

  // Verify only 1 route and 1 ship
  let routes = mockEntities.values.filter((e) => e.id === 'simulation1-route');
  let ships = mockEntities.values.filter((e) => e.id === 'simulation1-ship');
  assert.equal(routes.length, 1);
  assert.equal(ships.length, 1);

  // 2. Repeated START must NOT create duplicate route or ship
  await sim1.start();
  routes = mockEntities.values.filter((e) => e.id === 'simulation1-route');
  ships = mockEntities.values.filter((e) => e.id === 'simulation1-ship');
  assert.equal(routes.length, 1);
  assert.equal(ships.length, 1);

  // 3. Repeated rebuilds must NOT leak or create duplicate routes or ships
  await sim1.rebuildScenario({ lat: -64.8, lon: 134.5 }, { lat: -65.4, lon: 136.2 });
  routes = mockEntities.values.filter((e) => e.id === 'simulation1-route');
  ships = mockEntities.values.filter((e) => e.id === 'simulation1-ship');
  assert.equal(routes.length, 1);
  assert.equal(ships.length, 1);

  await sim1.rebuildScenario({ lat: -64.2, lon: 133.8 }, { lat: -66.1, lon: 137.0 });
  routes = mockEntities.values.filter((e) => e.id === 'simulation1-route');
  ships = mockEntities.values.filter((e) => e.id === 'simulation1-ship');
  assert.equal(routes.length, 1);
  assert.equal(ships.length, 1);

  // 4. Test Completion handler
  await sim1.start();
  assert.equal(sim1.running, true);
  sim1._onClockTick({ currentTime: sim1._stopTime });
  assert.equal(sim1.completed, true);
  assert.equal(sim1.running, false);

  sim1.destroy();
});

test('Simulation 2: Ingests real Sentinel-1 grounded iceberg #620 and sets up approach scenario', async () => {
  const sim2 = new Simulation2();
  sim2.hazards = [
    { id: 620, lat: -65.71600486484627, lon: 135.83239956078376, areaKm2: 0.6248482650541312 },
    { id: 567, lat: -65.8, lon: 136.0, areaKm2: 1.0 },
  ];

  await sim2.prepareScenario();

  assert.equal(sim2.targetIceberg.id, 620);
  assert.ok(sim2.initialRoute.ok);
  assert.ok(sim2.distanceToIcebergKm > 8.0, `Expected > 8 km, got ${sim2.distanceToIcebergKm}`);
  assert.equal(sim2.status, 'READY');
  assert.equal(sim2.warningActive, false);
  assert.equal(sim2.dangerActive, false);

  sim2.destroy();
});

test('Simulation 2: Proximity calculation and 5 km warning trigger with exact text', async () => {
  let warningCaptured = null;
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const sim2 = new Simulation2({ viewer: mockViewer });
  sim2.hazards = [
    { id: 620, lat: -65.71600486484627, lon: 135.83239956078376, areaKm2: 0.6248482650541312 },
  ];

  sim2.onStatusChange = (status, data) => {
    if (data?.warning) {
      warningCaptured = data.warning;
    }
  };

  await sim2.prepareScenario();
  await sim2.start();

  // Initially at >12 km: no warning
  assert.equal(sim2.warningActive, false);

  // Advance ship to simulated point 11.2 km from iceberg (#620 is at lon 135.8324)
  // Distance from -65.7160, 135.58 to -65.7160, 135.8324 is ~11.5 km <= 12.0 km
  const testJulianDate = sim2._startTime;
  // Mock sampledPosition to return 11.5 km coordinate
  sim2.sampledPosition = {
    getValue: () => ({
      // Cesium Cartesian3 mock representation
      x: 0,
      y: 0,
      z: 0,
    }),
  };

  // Mock Cesium.Cartographic.fromCartesian
  const origFromCartesian = Cesium.Cartographic.fromCartesian;
  Cesium.Cartographic.fromCartesian = () => ({
    latitude: Cesium.Math.toRadians(-65.7160),
    longitude: Cesium.Math.toRadians(135.5800),
    height: 10,
  });

  try {
    sim2._onClockTick({ currentTime: testJulianDate });
    assert.equal(sim2.warningActive, true);
    assert.equal(sim2.status, 'CAUTION');
    assert.equal(sim2.statusMessage, 'YOU ARE VERY CLOSE TO THE ICEBERG PLEASE CHANGE THE ROUTE');
    assert.equal(warningCaptured, 'YOU ARE VERY CLOSE TO THE ICEBERG PLEASE CHANGE THE ROUTE');
  } finally {
    Cesium.Cartographic.fromCartesian = origFromCartesian;
    sim2.destroy();
  }
});

test('Simulation 2: Danger state and autonomous obstacle-avoidance rerouting around Iceberg #620', async () => {
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
    get values() {
      return Array.from(entityStore.values());
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const sim2 = new Simulation2({ viewer: mockViewer });
  sim2.hazards = [
    { id: 620, lat: -65.71600486484627, lon: 135.83239956078376, areaKm2: 0.6248482650541312 },
  ];

  await sim2.prepareScenario();
  await sim2.start();

  // Verify exactly 1 route entity before reroute
  let routes = mockEntities.values.filter((e) => e.id === 'simulation2-route');
  assert.equal(routes.length, 1);

  // Position ship at danger threshold (7.8 km from Iceberg 620: lon ~135.66)
  sim2.currentPosition = {
    lat: -65.7160,
    lon: 135.6600,
    headingDeg: 90,
  };
  sim2.distanceToIcebergKm = 7.8;

  // Trigger autonomous hazard response
  await sim2._triggerAutomaticResponse();

  // Verify successful reroute
  assert.equal(sim2.isRerouted, true);
  assert.equal(sim2.isCalculatingReroute, false);
  assert.ok(sim2.activeRoute.waypoints.length >= 3);
  assert.ok(sim2.activeRoute.hazardsAvoidedCount >= 1);

  // Verify that NO DUPLICATE route entities exist: still exactly 1 route entity
  routes = mockEntities.values.filter((e) => e.id === 'simulation2-route');
  assert.equal(routes.length, 1);

  // Verify ship entity is still exactly 1
  const ships = mockEntities.values.filter((e) => e.id === 'simulation2-ship');
  assert.equal(ships.length, 1);

  sim2.destroy();
});

test('Simulation 2: Lifecycle controls (START, PAUSE, RESUME, RESET)', async () => {
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const sim2 = new Simulation2({ viewer: mockViewer });
  sim2.hazards = [
    { id: 620, lat: -65.71600486484627, lon: 135.83239956078376, areaKm2: 0.6248482650541312 },
  ];

  await sim2.prepareScenario();

  // 1. START
  await sim2.start();
  assert.equal(sim2.running, true);
  assert.equal(sim2.paused, false);
  assert.equal(mockViewer.clock.shouldAnimate, true);

  // 2. PAUSE
  sim2.pause();
  assert.equal(sim2.running, true);
  assert.equal(sim2.paused, true);
  assert.equal(mockViewer.clock.shouldAnimate, false);

  // 3. RESUME
  sim2.resume();
  assert.equal(sim2.running, true);
  assert.equal(sim2.paused, false);
  assert.equal(mockViewer.clock.shouldAnimate, true);

  // 4. RESET
  sim2.reset();
  assert.equal(sim2.running, false);
  assert.equal(sim2.paused, false);
  assert.equal(sim2.isRerouted, false);
  assert.equal(sim2.status, 'READY');
  assert.equal(mockViewer.clock.shouldAnimate, false);

  sim2.destroy();
});

test('SimulationManager: Mutual exclusivity between Simulation 1 and Simulation 2', async () => {
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
    get values() {
      return Array.from(entityStore.values());
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const manager = new SimulationManager({ viewer: mockViewer });
  manager.initialize({ viewer: mockViewer });

  // 1. Enable Simulation 1
  await manager.enableSimulation1();
  assert.equal(manager.getActiveSimulation(), 'sim-1');
  assert.equal(manager.sim1.active, true);
  assert.equal(manager.sim2.active, false);

  // 2. Switch to Simulation 2
  await manager.enableSimulation2();
  assert.equal(manager.getActiveSimulation(), 'sim-2');
  assert.equal(manager.sim1.active, false);
  assert.equal(manager.sim2.active, true);

  // 3. Switch back to Simulation 1
  await manager.enableSimulation1();
  assert.equal(manager.getActiveSimulation(), 'sim-1');
  assert.equal(manager.sim1.active, true);
  assert.equal(manager.sim2.active, false);

  manager.destroy();
});

test('Simulation 2: Dynamic corridor generation populates 2-3 icebergs and 1-2 fishing hotspots based on path length', async () => {
  const sim2 = new Simulation2();
  sim2.hazards = [];

  // Short route (< 40 km): 2 icebergs, 1 fishing hotspot
  const shortStart = { lat: -65.65, lon: 135.50, name: 'Short Bay Start' };
  const shortDest = { lat: -65.75, lon: 135.80, name: 'Short Bay Dest' };
  const shortRes = await sim2.rebuildScenario(shortStart, shortDest);

  assert.equal(shortRes.ok, true);
  assert.equal(sim2.corridorIcebergs.length, 2);
  assert.equal(sim2.fishingHotspots.length, 1);
  assert.equal(sim2.corridorIcebergs[0].role, 'primary');
  assert.equal(sim2.corridorIcebergs[1].role, 'secondary');
  assert.ok(sim2.fishingHotspots[0].species.includes('Krill') || sim2.fishingHotspots[0].name.includes('Krill'));

  // Longer route (>= 50 km): 3 icebergs, 2 fishing hotspots
  const longStart = { lat: -65.40, lon: 135.00, name: 'Long Shelf Start' };
  const longDest = { lat: -66.10, lon: 136.50, name: 'Long Shelf Dest' };
  const longRes = await sim2.rebuildScenario(longStart, longDest);

  assert.equal(longRes.ok, true);
  assert.equal(sim2.corridorIcebergs.length, 3);
  assert.equal(sim2.fishingHotspots.length, 2);
  assert.equal(sim2.corridorIcebergs[0].role, 'primary');
  assert.equal(sim2.corridorIcebergs[1].role, 'secondary');
  assert.equal(sim2.corridorIcebergs[2].role, 'tertiary');
  assert.ok(sim2.fishingHotspots[1].species.includes('Toothfish') || sim2.fishingHotspots[1].name.includes('Toothfish'));

  sim2.destroy();
});

test('Simulation 2: rebuildScenario dynamically creates route and updates custom coordinates', async () => {
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
    get values() {
      return Array.from(entityStore.values());
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const sim2 = new Simulation2({ viewer: mockViewer });
  sim2.hazards = [];

  const startA = { lat: -65.50, lon: 135.20, name: 'Custom Station 1' };
  const destA = { lat: -65.80, lon: 136.10, name: 'Custom Station 2' };

  const res = await sim2.rebuildScenario(startA, destA);
  assert.equal(res.ok, true);
  assert.equal(sim2.customStart.latitude, -65.50);
  assert.equal(sim2.customDestination.latitude, -65.80);
  assert.equal(sim2.currentPosition.lat, -65.50);
  assert.equal(sim2.currentPosition.lon, 135.20);
  assert.ok(sim2.activeRoute.waypoints.length > 2);

  // Verify entities rendered
  const route = mockEntities.getById('simulation2-route');
  assert.ok(route !== null);
  const ship = mockEntities.getById('simulation2-ship');
  assert.ok(ship !== null);
  const berg0 = mockEntities.getById('simulation2-iceberg');
  assert.ok(berg0 !== null);
  const hs0 = mockEntities.getById('simulation2-hotspot-0');
  assert.ok(hs0 !== null);

  sim2.destroy();
});

test('Simulation 2: 3-second siren pause and navigation continuation upon danger response', async () => {
  const entityStore = new Map();
  const mockEntities = {
    add(opts) {
      const id = opts.id || `entity-${Math.random()}`;
      const ent = { ...opts, id };
      entityStore.set(id, ent);
      return ent;
    },
    getById(id) {
      return entityStore.get(id) || null;
    },
    remove(ent) {
      if (!ent) return false;
      const id = typeof ent === 'string' ? ent : ent.id;
      return entityStore.delete(id);
    },
    get values() {
      return Array.from(entityStore.values());
    },
  };

  const mockViewer = {
    entities: mockEntities,
    clock: {
      startTime: null,
      stopTime: null,
      currentTime: null,
      multiplier: 1,
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    flyTo: async () => {},
  };

  const sim2 = new Simulation2({ viewer: mockViewer });
  sim2.hazards = [
    { id: 620, lat: -65.7160, lon: 135.8324, areaKm2: 0.62 },
  ];

  await sim2.prepareScenario();
  await sim2.start();

  assert.equal(mockViewer.clock.shouldAnimate, true);

  // Position ship at danger distance (7.8 km <= 8.0 km)
  sim2.currentPosition = {
    lat: -65.7160,
    lon: 135.6600,
    headingDeg: 90,
  };
  sim2.distanceToIcebergKm = 7.8;

  const responsePromise = sim2._triggerAutomaticResponse();

  // Clock should immediately be halted for the 3-second siren pause
  assert.equal(mockViewer.clock.shouldAnimate, false);
  assert.equal(sim2.isCalculatingReroute, true);
  assert.equal(sim2.status, 'DANGER');

  // Wait for 3-second pause + route calculation to finish
  await responsePromise;

  // After 3-second pause and safe route calculation:
  // Siren stops, status becomes REROUTED, and clock resumes navigating!
  assert.equal(sim2.isRerouted, true);
  assert.equal(sim2.isCalculatingReroute, false);
  assert.equal(mockViewer.clock.shouldAnimate, true);
  assert.equal(sim2.status, 'REROUTED');

  sim2.destroy();
});

test('Simulation 2: Three-tier alert progression (12 km msg, 10 km siren, 8 km rerouting)', async () => {
  const sim2 = new Simulation2();
  sim2.hazards = [
    { id: 620, lat: -65.7160, lon: 135.8324, areaKm2: 0.62 },
  ];

  await sim2.prepareScenario();
  await sim2.start();

  const testJulianDate = sim2._startTime;
  sim2.sampledPosition = {
    getValue: () => ({ x: 0, y: 0, z: 0 }),
  };

  const origFromCartesian = Cesium.Cartographic.fromCartesian;
  try {
    // 1. Point at 14 km (lon ~135.52) -> No warning, No siren, No danger
    Cesium.Cartographic.fromCartesian = () => ({
      latitude: Cesium.Math.toRadians(-65.7160),
      longitude: Cesium.Math.toRadians(135.5200),
      height: 10,
    });
    sim2._onClockTick({ currentTime: testJulianDate });
    assert.equal(sim2.warningActive, false);
    assert.equal(sim2.sirenActive, false);
    assert.equal(sim2.dangerActive, false);

    // 2. Point at 11.5 km (lon ~135.58) -> Tier 1: 12 km Warning message begins!
    Cesium.Cartographic.fromCartesian = () => ({
      latitude: Cesium.Math.toRadians(-65.7160),
      longitude: Cesium.Math.toRadians(135.5800),
      height: 10,
    });
    sim2._onClockTick({ currentTime: testJulianDate });
    assert.equal(sim2.warningActive, true);
    assert.equal(sim2.sirenActive, false);
    assert.equal(sim2.status, 'CAUTION');
    assert.equal(sim2.statusMessage, 'YOU ARE VERY CLOSE TO THE ICEBERG PLEASE CHANGE THE ROUTE');

    // 3. Point at 9.5 km (lon ~135.62) -> Tier 2: 10 km Siren begins ringing!
    Cesium.Cartographic.fromCartesian = () => ({
      latitude: Cesium.Math.toRadians(-65.7160),
      longitude: Cesium.Math.toRadians(135.6200),
      height: 10,
    });
    sim2._onClockTick({ currentTime: testJulianDate });
    assert.equal(sim2.warningActive, true);
    assert.equal(sim2.sirenActive, true);
    assert.equal(sim2.status, 'ALERT');

    // 4. Point at 7.8 km (lon ~135.66) -> Tier 3: 8 km Rerouting triggers!
    Cesium.Cartographic.fromCartesian = () => ({
      latitude: Cesium.Math.toRadians(-65.7160),
      longitude: Cesium.Math.toRadians(135.6600),
      height: 10,
    });
    sim2._onClockTick({ currentTime: testJulianDate });
    assert.equal(sim2.isCalculatingReroute, true);
    assert.equal(sim2.dangerActive, true);
    assert.equal(sim2.status, 'DANGER');
  } finally {
    Cesium.Cartographic.fromCartesian = origFromCartesian;
    sim2.destroy();
  }
});

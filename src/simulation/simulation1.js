/**
 * @file simulation1.js
 * Complete functional implementation of Simulation 1: Shortest & Safest Ship Route.
 * Ingests real Antarctic Sentinel-1 grounded iceberg data, computes A* obstacle-avoidance route
 * or consumes active calculated ANTARIS route, creates a Cesium.SampledPositionProperty with JulianDate timestamps,
 * attaches to the ship entity, and drives vessel movement via the Cesium Viewer Clock and SampledPositionProperty.
 */

import * as Cesium from 'cesium';
import { SIMULATION_1_CONFIG } from './simulationConfig.js';
import {
  calculateSafeRoute,
  calculateBearingDeg,
  haversineDistanceKm,
  normalizeCoordinate,
  validateOceanPosition,
  validateSimulationRoute,
} from './routing.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';

// Cross-environment asset resolution (works seamlessly in both Vite and Node test runner)
const DEFAULT_ICEBERGS_URL = new URL('../data/local_data/icebergs/icebergs.geojsonl', import.meta.url).href;

/** SVG Vessel Icon Data URL (sleek cyan nautical ship silhouette with directional bow). */
const SHIP_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <defs>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="%2300e5ff" flood-opacity="0.9"/>
    </filter>
  </defs>
  <g filter="url(%23glow)">
    <!-- Vessel Hull -->
    <path d="M 24 4 L 34 16 L 33 38 L 24 44 L 15 38 L 14 16 Z" fill="%23051a24" stroke="%2300e5ff" stroke-width="2.5" stroke-linejoin="round"/>
    <!-- Superstructure & Bridge -->
    <polygon points="24,12 30,22 24,20 18,22" fill="%2300e5ff" opacity="0.9"/>
    <rect x="21" y="24" width="6" height="10" rx="1.5" fill="%23ffffff" opacity="0.85"/>
    <!-- Bow Pointer -->
    <polygon points="24,4 27,11 24,9 21,11" fill="%23ffffff"/>
  </g>
</svg>`;

export class Simulation1 {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.id = 'sim-1';
    this.name = 'Simulation 1';
    this.title = 'Safe Route Navigation';
    this.description = 'Dynamic Antarctic ship route navigating safely around grounded icebergs';
    this.config = SIMULATION_1_CONFIG;

    this.viewer = options.viewer || null;
    this.icebergsUrl = options.icebergsUrl || null;
    this.initialized = false;
    this.active = false;
    this.running = false;
    this.paused = false;
    this.completed = false;

    // Dynamic start & destination locations
    this.customStart = null;
    this.customDestination = null;

    this.speedMultiplier = 1;
    this.distanceTraveledKm = 0;
    this.hazards = [];
    this.route = null;
    this.currentPosition = null;

    // Time-based Cesium movement properties
    this.sampledPosition = null;
    this._startTime = null;
    this._stopTime = null;
    this._durationSeconds = 75;
    this._currentHeadingDeg = 90;
    this._initialHeadingDeg = 90;
    this._wakePositions = [];
    this._clockTickRemover = null;
    this._lastLoggedSec = -1;

    // Entities
    this._entities = {
      routePolyline: null,
      startPin: null,
      destPin: null,
      ship: null,
      wakePolyline: null,
      hazardHalos: [],
    };

    this._hazardLoadPromise = null;

    // Callbacks
    this.onProgress = null;
    this.onStatusChange = null;
  }

  /**
   * Get active scenario start coordinates (custom or default).
   * @returns {{latitude: number, longitude: number, lat: number, lon: number, name: string}}
   */
  getStart() {
    let raw = null;
    if (this.customStart) raw = this.customStart;
    else if (typeof window !== 'undefined' && window.__activeMaritimeRoute?.initial) {
      raw = normalizeCoordinate(window.__activeMaritimeRoute.initial);
    } else if (typeof window !== 'undefined' && window.__godsEyeView?.routePlanner?.initialPinData) {
      raw = normalizeCoordinate(window.__godsEyeView.routePlanner.initialPinData);
    } else {
      raw = normalizeCoordinate(this.config.start);
    }

    if (!raw) raw = normalizeCoordinate(this.config.start);
    const valid = validateOceanPosition(raw.lat ?? raw.latitude, raw.lon ?? raw.longitude);
    return {
      latitude: valid.lat,
      longitude: valid.lon,
      lat: valid.lat,
      lon: valid.lon,
      name: raw.name || raw.label || `${valid.lat.toFixed(4)}°, ${valid.lon.toFixed(4)}°`,
    };
  }

  getDestination() {
    let raw = null;
    if (this.customDestination) raw = this.customDestination;
    else if (typeof window !== 'undefined' && window.__activeMaritimeRoute?.final) {
      raw = normalizeCoordinate(window.__activeMaritimeRoute.final);
    } else if (typeof window !== 'undefined' && window.__godsEyeView?.routePlanner?.finalPinData) {
      raw = normalizeCoordinate(window.__godsEyeView.routePlanner.finalPinData);
    } else {
      raw = normalizeCoordinate(this.config.destination);
    }

    if (!raw) raw = normalizeCoordinate(this.config.destination);
    const valid = validateOceanPosition(raw.lat ?? raw.latitude, raw.lon ?? raw.longitude);
    return {
      latitude: valid.lat,
      longitude: valid.lon,
      lat: valid.lat,
      lon: valid.lon,
      name: raw.name || raw.label || `${valid.lat.toFixed(4)}°, ${valid.lon.toFixed(4)}°`,
    };
  }

  /**
   * Initialize sub-simulation with the Cesium viewer instance.
   * @param {import('cesium').Viewer} viewer
   */
  initialize(viewer) {
    if (viewer) this.viewer = viewer;
    this.initialized = true;

    // Pre-fetch iceberg hazard data in background
    this._ensureHazardsLoaded().catch((err) => {
      console.warn('[Simulation1] Initial hazard pre-load error:', err);
    });

    console.info(`[Simulation1] Initialized with viewer: ${Boolean(this.viewer)}`);
  }

  /**
   * Load and cache the real Sentinel-1 grounded iceberg data.
   * @private
   */
  async _ensureHazardsLoaded() {
    if (this.hazards.length > 0) return this.hazards;
    if (this._hazardLoadPromise) return this._hazardLoadPromise;

    this._hazardLoadPromise = (async () => {
      try {
        const targetUrl = this.icebergsUrl || DEFAULT_ICEBERGS_URL;
        let text = '';
        if (targetUrl.startsWith('file:') && typeof process !== 'undefined' && process.versions?.node) {
          const fs = await import(/* @vite-ignore */ 'node:fs/promises');
          text = await fs.readFile(new URL(targetUrl), 'utf8');
        } else {
          const res = await fetch(targetUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = await res.text();
        }
        const lines = text.split('\n').filter((l) => l.trim().length > 0);

        const loaded = [];
        for (let i = 0; i < lines.length; i++) {
          try {
            const feat = JSON.parse(lines[i]);
            const p = feat.properties || {};
            const lat = Number(p.Latitude);
            const lon = Number(p.Longitude);
            const geom = feat.geometry;
            const polyCoords = geom && geom.type === 'Polygon' && Array.isArray(geom.coordinates) ? geom.coordinates[0] : null;
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              loaded.push({
                id: p.Global_UID || `iceberg-${i}`,
                lat,
                lon,
                areaKm2: Number(p.Area_Mean_km2) || 1.0,
                depthM: Number(p.Bed_Depth) || null,
                polygonCoordinates: polyCoords,
              });
            }
          } catch {
            // skip malformed line
          }
        }
        this.hazards = loaded;
        console.info(`[Simulation1] Loaded ${this.hazards.length} Antarctic icebergs from dataset.`);
        return this.hazards;
      } catch (err) {
        console.error('[Simulation1] Failed to load iceberg dataset:', err);
        this.hazards = [];
        return [];
      } finally {
        this._hazardLoadPromise = null;
      }
    })();

    return this._hazardLoadPromise;
  }

  /**
   * Prepare scenario and calculate safe route or consume active ANTARIS route.
   */
  async prepareScenario() {
    this.isCalculating = true;
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('CALCULATING ROUTE...');
    }

    // Check if an active calculated ANTARIS route exists
    if (typeof window !== 'undefined' && window.__activeMaritimeRoute?.selectedOption?.route) {
      const antarisRoutePoints = window.__activeMaritimeRoute.selectedOption.route;
      if (Array.isArray(antarisRoutePoints) && antarisRoutePoints.length >= 2) {
        const waypoints = antarisRoutePoints.map((pt, idx) => ({
          lat: pt.latitude ?? pt.lat,
          lon: pt.longitude ?? pt.lon,
          index: idx,
        }));
        let totalKm = 0;
        for (let i = 0; i < waypoints.length; i++) {
          const prev = i > 0 ? waypoints[i - 1] : null;
          const legDist = prev ? haversineDistanceKm(prev.lat, prev.lon, waypoints[i].lat, waypoints[i].lon) : 0;
          totalKm += legDist;
          waypoints[i].legDistanceKm = legDist;
          waypoints[i].cumulativeDistanceKm = totalKm;
        }
        this.route = {
          ok: true,
          waypoints,
          totalDistanceKm: totalKm,
          directDistanceKm: haversineDistanceKm(waypoints[0].lat, waypoints[0].lon, waypoints[waypoints.length - 1].lat, waypoints[waypoints.length - 1].lon),
          hazardsAvoidedCount: 0,
          hazardsNearRoute: [],
        };
        this.status = 'READY';
        this.statusReason = null;
        this.isCalculating = false;
        this._buildSampledPositions();
        this.currentPosition = {
          lat: waypoints[0].lat,
          lon: waypoints[0].lon,
          headingDeg: this._initialHeadingDeg,
        };
        if (this.viewer) {
          this._renderRouteEntities();
        }
        return this.route;
      }
    }

    await this._ensureHazardsLoaded();

    if (this.hazards.length === 0) {
      this.isCalculating = false;
      this.status = 'NO SAFE ROUTE FOUND';
      this.statusReason = 'NO HAZARD DATA AVAILABLE';
      console.warn('[Simulation1] HAZARD DATA UNAVAILABLE: Unable to calculate safe route without hazards.');
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('NO SAFE ROUTE FOUND', this.statusReason);
      }
      return {
        ok: false,
        reason: this.statusReason,
        waypoints: [],
        totalDistanceKm: 0,
      };
    }

    const startObj = this.getStart();
    const destObj = this.getDestination();

    const startPt = {
      lat: startObj.latitude,
      lon: startObj.longitude,
      name: startObj.name,
    };
    const destPt = {
      lat: destObj.latitude,
      lon: destObj.longitude,
      name: destObj.name,
    };

    console.log('[SIM1] SCENARIO BUILD');
    console.log(`[SIM1] START: ${startPt.name || `${startPt.lat.toFixed(4)}, ${startPt.lon.toFixed(4)}`}`);
    console.log(`[SIM1] DESTINATION: ${destPt.name || `${destPt.lat.toFixed(4)}, ${destPt.lon.toFixed(4)}`}`);

    console.info(`[Simulation1] Calculating safe path around ${this.hazards.length} corridor icebergs...`);
    const result = calculateSafeRoute({
      start: startPt,
      destination: destPt,
      hazards: this.hazards,
      safetyRadiusKm: this.config.icebergSafetyRadiusKm,
      gridLatStepDeg: this.config.gridLatStepDeg,
      gridLonStepDeg: this.config.gridLonStepDeg,
      corridorPaddingDeg: this.config.corridorPaddingDeg,
    });

    this.isCalculating = false;

    if (!result.ok) {
      console.error('[Simulation1] Route calculation failed:', result.reason || result.error);
      this.route = null;
      this.status = 'NO SAFE ROUTE FOUND';
      this.statusReason = result.reason || 'UNSAFE';
      this._clearEntities();
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('NO SAFE ROUTE FOUND', this.statusReason);
      }
      return result;
    }

    this.route = result;
    this.status = 'READY';
    this.statusReason = null;

    console.log('[SIM1] ROUTE READY');
    console.log(`[SIM1] WAYPOINTS: ${result.waypoints.length}`);
    console.log(`[SIM1] DISTANCE: ${result.totalDistanceKm.toFixed(2)} km`);
    console.log(`[SIM1] HAZARDS CONSIDERED: ${this.hazards.length}`);
    console.log(`[SIM1] HAZARDS AVOIDED: ${result.hazardsAvoidedCount}`);
    console.info(
      `[Simulation1] Safe route established: ${result.totalDistanceKm.toFixed(1)} km across ${result.waypoints.length} waypoints (${result.hazardsAvoidedCount} hazards avoided, Direct: ${result.directDistanceKm.toFixed(1)} km).`,
    );

    // Build the Cesium.SampledPositionProperty with JulianDate timestamps based on physical speed
    this._buildSampledPositions();

    // Initial position at Start
    this.currentPosition = {
      lat: startObj.latitude,
      lon: startObj.longitude,
      headingDeg: this._initialHeadingDeg,
    };

    // Render route and markers on Cesium globe
    if (this.viewer) {
      this._renderRouteEntities();
    }

    return result;
  }

  /**
   * Construct Cesium.SampledPositionProperty across waypoints based on segment geographic distance
   * and physical vessel cruising speed (15 knots).
   * @private
   */
  _buildSampledPositions() {
    const waypoints = this.route.waypoints;
    if (!waypoints || waypoints.length < 2) return;

    // Base physical ship cruising speed: 15 knots (1 knot = 0.514444 m/s)
    const baseKnots = Number(this.config.baseSpeedKnots) || 15;
    const knotToMps = Number(this.config.knotToMps) || 0.514444;
    const baseMps = baseKnots * knotToMps; // 7.71666 m/s

    // Time compression factor for interactive demonstration in Cesium globe (~175x)
    // Ensures a 100 km transit takes ~75 seconds at 1X playback
    const timeCompression = Number(this.config.timeCompressionFactor) || 175;
    const effectiveMps = baseMps * timeCompression;

    // Use Cesium JulianDate time system
    this._startTime = Cesium.JulianDate.now();
    let currentJulianDate = Cesium.JulianDate.clone(this._startTime);
    let totalElapsedSec = 0;

    // Create SampledPositionProperty
    this.sampledPosition = new Cesium.SampledPositionProperty();
    this.sampledPosition.setInterpolationOptions({
      interpolationDegree: 1,
      interpolationAlgorithm: Cesium.LinearApproximation,
    });
    this.sampledPosition.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    this.sampledPosition.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

    // Add Waypoint 0 (Start)
    const startWp = waypoints[0];
    this.sampledPosition.addSample(currentJulianDate, Cesium.Cartesian3.fromDegrees(startWp.lon, startWp.lat, 25));

    for (let i = 1; i < waypoints.length; i++) {
      const prev = waypoints[i - 1];
      const curr = waypoints[i];
      const legDistKm = haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);
      const legDistMeters = legDistKm * 1000;
      // Exact segment travel duration based on geographic distance and cruising speed
      const segDurationSec = legDistMeters / effectiveMps;
      totalElapsedSec += segDurationSec;
      currentJulianDate = Cesium.JulianDate.addSeconds(this._startTime, totalElapsedSec, new Cesium.JulianDate());
      this.sampledPosition.addSample(currentJulianDate, Cesium.Cartesian3.fromDegrees(curr.lon, curr.lat, 25));
    }

    this._durationSeconds = totalElapsedSec;
    this._stopTime = Cesium.JulianDate.clone(currentJulianDate);

    // Initial heading from Start to Waypoint 1
    this._initialHeadingDeg = calculateBearingDeg(
      waypoints[0].lat,
      waypoints[0].lon,
      waypoints[1].lat,
      waypoints[1].lon,
    );
    this._currentHeadingDeg = this._initialHeadingDeg;
  }

  /**
   * Render route polyline, start/destination pins, hazard halos, and ship on the Cesium globe.
   * @private
   */
  _renderRouteEntities() {
    if (!this.viewer || !this.route || !this.route.ok) return;

    this._clearEntities();

    const entities = this.viewer.entities;
    const waypoints = this.route.waypoints;

    // 1. Cartesian positions along route
    const positions = waypoints.map((wp) =>
      Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, 15),
    );

    // 2. Recommended safe route polyline
    const existingRoute = entities.getById('simulation1-route');
    if (existingRoute) {
      entities.remove(existingRoute);
      console.log('[SIM1] OLD ROUTE REMOVED');
    }

    this._entities.routePolyline = entities.add({
      id: 'simulation1-route',
      name: 'Safe Nautical Route (Simulation 1)',
      polyline: {
        positions,
        width: 6,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.28,
          color: Cesium.Color.fromCssColorString('#00e5ff'),
        }),
        clampToGround: false,
      },
    });
    console.log('[SIM1] NEW ROUTE CREATED');

    // 3. Start Pin Marker
    const startPt = this.getStart();
    this._entities.startPin = entities.add({
      name: `START: ${startPt.name || 'Start Point'}`,
      position: Cesium.Cartesian3.fromDegrees(startPt.longitude, startPt.latitude, 20),
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2.5,
      },
      label: {
        text: `⚓ START\n${startPt.name || `${startPt.latitude.toFixed(4)}°, ${startPt.longitude.toFixed(4)}°`}`,
        font: 'bold 11px monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000000),
      },
    });

    // 4. Destination Pin Marker
    const destPt = this.getDestination();
    this._entities.destPin = entities.add({
      name: `DESTINATION: ${destPt.name || 'Destination Point'}`,
      position: Cesium.Cartesian3.fromDegrees(destPt.longitude, destPt.latitude, 20),
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString('#ff007f'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2.5,
      },
      label: {
        text: `🏁 DESTINATION\n${destPt.name || `${destPt.latitude.toFixed(4)}°, ${destPt.longitude.toFixed(4)}°`}`,
        font: 'bold 11px monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000000),
      },
    });

    // 5. Hazard clearance halos around nearby icebergs
    if (Array.isArray(this.route.hazardsNearRoute)) {
      this._entities.hazardHalos = this.route.hazardsNearRoute.slice(0, 40).map((h) => {
        const radKm = Number(h.safetyRadiusKm) || this.config.icebergSafetyRadiusKm || 3.5;
        const radMeters = radKm * 1000;
        return entities.add({
          name: `Iceberg #${h.id} (${radKm.toFixed(1)}km Safety Buffer)`,
          position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, 5),
          ellipse: {
            semiMinorAxis: radMeters,
            semiMajorAxis: radMeters,
            material: Cesium.Color.fromCssColorString('rgba(0, 229, 255, 0.08)'),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('rgba(0, 229, 255, 0.45)'),
            outlineWidth: 1.5,
            height: 5,
          },
        });
      });
    }

    // 6. Traveled Wake Trail Polyline
    const startCart = Cesium.Cartesian3.fromDegrees(startPt.longitude, startPt.latitude, 15);
    this._wakePositions = [startCart, startCart];
    this._entities.wakePolyline = entities.add({
      name: 'Vessel Traveled Wake',
      polyline: {
        positions: new Cesium.CallbackProperty(() => this._wakePositions, false),
        width: 3.5,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.WHITE.withAlpha(0.85),
          dashLength: 16.0,
        }),
      },
    });

    // 7. Single Simulated Ship Entity attached to SampledPositionProperty
    const existingShip = entities.getById('simulation1-ship') || entities.getById('simulation-vessel-sim1');
    if (existingShip) {
      entities.remove(existingShip);
    }
    this._entities.ship = entities.add({
      id: 'simulation1-ship',
      name: 'SIMULATION VESSEL: RV POLAR EXPLORER',
      position: this.sampledPosition,
      billboard: {
        image: SHIP_SVG,
        width: 38,
        height: 38,
        rotation: new Cesium.CallbackProperty(
          () => -Cesium.Math.toRadians(this._currentHeadingDeg),
          false,
        ),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference: Cesium.HeightReference.NONE,
      },
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      label: {
        text: 'SIMULATION 1\nRV POLAR EXPLORER',
        font: 'bold 11px monospace',
        fillColor: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -24),
      },
    });

    console.log('[SIM1] SHIP CREATED');
    console.log('[SIM1] SHIP ID: simulation1-ship');

    // Request frame to render setup
    governorRequestRender('simulation-1:route-drawn');
  }

  /**
   * Smoothly frame the calculated Antarctic route in the Cesium camera.
   */
  frameRouteInCamera() {
    if (!this.viewer || !this._entities.routePolyline) return;

    try {
      this.viewer.flyTo(this._entities.routePolyline, {
        duration: 2.0,
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(0),
          Cesium.Math.toRadians(-55),
          0,
        ),
      }).catch(() => {});
    } catch {
      // ignore camera interrupt
    }
  }

  /**
   * Called when Simulation 1 is selected in the UI.
   */
  async activate() {
    this.active = true;
    console.info('[Simulation1] Activated');

    // Automatically prepare and draw the route so controls and scene are ready
    if (!this.route) {
      await this.prepareScenario();
    } else if (this.viewer && !this._entities.routePolyline) {
      this._renderRouteEntities();
    }
  }

  /**
   * Called when Simulation 1 is deselected or disabled.
   */
  deactivate() {
    this.stop();
    this._clearEntities();
    this.active = false;
    console.info('[Simulation1] Deactivated');
  }

  /**
   * Start simulation playback and vessel movement.
   */
  async start() {
    if (!this.active) await this.activate();

    if (!this.route || !this.sampledPosition) {
      const res = await this.prepareScenario();
      if (!res.ok) return;
    }

    if (!this._entities.routePolyline && this.viewer) {
      this._renderRouteEntities();
    }

    // Reset if previously completed
    if (this.completed) {
      this.reset();
    }

    this.running = true;
    this.paused = false;
    this.completed = false;
    this._lastLoggedSec = -1;

    // 1. Reset and configure Cesium Viewer Clock
    if (this.viewer?.clock && this._startTime && this._stopTime) {
      this.viewer.clock.startTime = this._startTime.clone();
      this.viewer.clock.stopTime = this._stopTime.clone();
      this.viewer.clock.currentTime = this._startTime.clone();
      this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
      this.viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
      this.viewer.clock.multiplier = Number(this.speedMultiplier) || 1;
      this.viewer.clock.shouldAnimate = true;
    }

    // 2. Attach Cesium clock tick listener
    this._attachClockTick();

    // 3. Hold continuous render for silky smooth 60fps rendering
    holdContinuousRender('simulation-1');
    this.viewer?.scene?.requestRender?.();

    // 4. Frame camera on first start
    if (this.distanceTraveledKm === 0) {
      this.frameRouteInCamera();
    }

    console.log('[SIM1] START');
    console.log(`[SIM1] START TIME: ${this._startTime ? Cesium.JulianDate.toIso8601(this._startTime) : 'N/A'}`);
    console.log(`[SIM1] STOP TIME: ${this._stopTime ? Cesium.JulianDate.toIso8601(this._stopTime) : 'N/A'}`);
    console.log(`[SIM1] CLOCK SHOULD ANIMATE: ${Boolean(this.viewer?.clock?.shouldAnimate)}`);
    console.log(`[SIM1] CLOCK MULTIPLIER: ${this.viewer?.clock?.multiplier ?? this.speedMultiplier}`);

    // 5. Output exact required debug telemetry
    const baseKnots = this.config.baseSpeedKnots || 15;
    const effectiveSpeedMps = ((this.route.totalDistanceKm * 1000) / this._durationSeconds) * (this.viewer?.clock?.multiplier || this.speedMultiplier);

    console.log('SIM START');
    console.log(`route points: ${this.route.waypoints.length}`);
    console.log(`route distance: ${this.route.totalDistanceKm.toFixed(2)} km`);
    console.log(`base speed: ${baseKnots} knots`);
    console.log(`effective speed: ${effectiveSpeedMps.toFixed(2)} m/s`);
    console.log(`simulation duration: ${this._durationSeconds.toFixed(1)} seconds`);
    console.log(`clock shouldAnimate: ${Boolean(this.viewer?.clock?.shouldAnimate)}`);
    console.log(`clock multiplier: ${this.viewer?.clock?.multiplier ?? this.speedMultiplier}`);
    console.log(`clock currentTime: ${this.viewer?.clock?.currentTime ? Cesium.JulianDate.toIso8601(this.viewer.clock.currentTime) : 'N/A'}`);
    console.log(`clock startTime: ${this.viewer?.clock?.startTime ? Cesium.JulianDate.toIso8601(this.viewer.clock.startTime) : 'N/A'}`);
    console.log(`clock stopTime: ${this.viewer?.clock?.stopTime ? Cesium.JulianDate.toIso8601(this.viewer.clock.stopTime) : 'N/A'}`);

    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('RUNNING');
    }

    console.info('[Simulation1] Playback started');
  }

  /**
   * Pause simulation playback.
   */
  pause() {
    if (!this.running || this.paused) return;

    this.paused = true;
    if (this.viewer?.clock) {
      this.viewer.clock.shouldAnimate = false;
    }
    releaseContinuousRender('simulation-1');
    governorRequestRender('simulation-1:paused');

    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('PAUSED');
    }

    console.log('[SIM1] PAUSED');
    console.info('[Simulation1] Playback paused');
  }

  /**
   * Resume simulation playback from exact frozen position.
   */
  resume() {
    if (!this.running || !this.paused) return;

    this.paused = false;
    if (this.viewer?.clock) {
      this.viewer.clock.multiplier = Number(this.speedMultiplier) || 1;
      this.viewer.clock.shouldAnimate = true;
    }
    holdContinuousRender('simulation-1');
    this.viewer?.scene?.requestRender?.();

    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('RUNNING');
    }

    console.log('[SIM1] RESUMED');
    console.info('[Simulation1] Playback resumed');
  }

  /**
   * Stop simulation playback.
   */
  stop() {
    this.running = false;
    this.paused = false;
    if (this.viewer?.clock) {
      this.viewer.clock.shouldAnimate = false;
    }
    this._detachClockTick();
    releaseContinuousRender('simulation-1');
    governorRequestRender('simulation-1:stopped');
  }

  /**
   * Dynamically rebuild Simulation 1 scenario for new start and/or destination coordinates.
   * Clears old state, computes new route, updates Cesium clock, places ship at new start, and sets READY.
   * @param {object} [newStart]
   * @param {object} [newDest]
   * @returns {Promise<object>}
   */
  async rebuildScenario(newStart, newDest) {
    const validatedStart = normalizeCoordinate(newStart) || this.getStart();
    const validatedDest = normalizeCoordinate(newDest) || this.getDestination();

    if (!validatedStart || !validatedDest) {
      console.warn('[Simulation1] Invalid start or destination coordinates provided for rebuild.');
      return { ok: false, error: 'Invalid coordinates' };
    }

    const currentStart = this.customStart || this.config.start;
    const currentDest = this.customDestination || this.config.destination;

    const startChanged = !currentStart ||
      (currentStart.latitude ?? currentStart.lat) !== validatedStart.latitude ||
      (currentStart.longitude ?? currentStart.lon) !== validatedStart.longitude;

    const destChanged = !currentDest ||
      (currentDest.latitude ?? currentDest.lat) !== validatedDest.latitude ||
      (currentDest.longitude ?? currentDest.lon) !== validatedDest.longitude;

    if (startChanged) {
      console.log(`[SIM1] Start changed:\nlatitude: ${validatedStart.latitude}\nlongitude: ${validatedStart.longitude}`);
    }
    if (destChanged) {
      console.log(`[SIM1] Destination changed:\nlatitude: ${validatedDest.latitude}\nlongitude: ${validatedDest.longitude}`);
    }
    console.log('[SIM1] Rebuilding scenario');

    // 1. Stop current simulation and clock
    this.stop();
    if (this.viewer?.clock) {
      this.viewer.clock.shouldAnimate = false;
    }
    releaseContinuousRender('simulation-1');

    // 2. Clear old simulation state
    this.route = null;
    this.sampledPosition = null;
    this._startTime = null;
    this._stopTime = null;
    this.currentPosition = null;
    this.distanceTraveledKm = 0;
    this.completed = false;
    this.running = false;
    this.paused = false;
    this._lastLoggedSec = -1;

    this._clearEntities();

    // 3. Assign new custom locations
    this.customStart = validatedStart;
    this.customDestination = validatedDest;

    // 4. Calculate new route, build SampledPositionProperty, place ship
    const res = await this.prepareScenario();
    if (!res || !res.ok) {
      const reason = res?.reason || res?.error || 'NO SAFE ROUTE FOUND';
      console.warn(`[SIM1] Failed to rebuild scenario: ${reason}`);
      this.status = 'NO SAFE ROUTE FOUND';
      this.statusReason = reason;
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('NO SAFE ROUTE FOUND', reason);
      }
      governorRequestRender('simulation-1:rebuild-failed');
      return { ok: false, reason };
    }

    // 5. Rebuild Cesium clock
    if (this.viewer?.clock && this._startTime && this._stopTime) {
      this.viewer.clock.startTime = this._startTime.clone();
      this.viewer.clock.stopTime = this._stopTime.clone();
      this.viewer.clock.currentTime = this._startTime.clone();
      this.viewer.clock.shouldAnimate = false;
      this.viewer.clock.multiplier = Number(this.speedMultiplier) || 1;
      this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
    }

    // 6. Output exact required debug logging
    console.log(`[SIM1] Route points:\n${this.route.waypoints.length}`);
    console.log(`[SIM1] Route distance:\n${this.route.totalDistanceKm.toFixed(2)} km`);
    console.log(`[SIM1] Simulation duration:\n${this._durationSeconds.toFixed(1)} seconds`);
    console.log(`[SIM1] New startTime:\n${this._startTime ? Cesium.JulianDate.toIso8601(this._startTime) : 'N/A'}`);
    console.log(`[SIM1] New stopTime:\n${this._stopTime ? Cesium.JulianDate.toIso8601(this._stopTime) : 'N/A'}`);
    console.log(`[SIM1] Ship reset to:\nlatitude: ${validatedStart.latitude}\nlongitude: ${validatedStart.longitude}`);
    console.log('[SIM1] State:\nREADY');

    // 7. Update status & progress
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('READY');
    }
    if (typeof this.onProgress === 'function' && this.route) {
      this.onProgress(this.currentPosition, 0, this.route.totalDistanceKm);
    }

    governorRequestRender('simulation-1:rebuild');
    return { ok: true, route: this.route };
  }

  /**
   * Reset simulation back to start position of CURRENT scenario and ready state.
   */
  reset() {
    this.stop();
    this.completed = false;
    this.distanceTraveledKm = 0;
    this._lastLoggedSec = -1;

    if (this.viewer?.clock && this._startTime) {
      this.viewer.clock.currentTime = this._startTime.clone();
      this.viewer.clock.shouldAnimate = false;
    }

    this._currentHeadingDeg = this._initialHeadingDeg || 90;
    const startPt = this.getStart();
    this.currentPosition = {
      lat: startPt.latitude,
      lon: startPt.longitude,
      headingDeg: this._currentHeadingDeg,
    };

    const startCart = Cesium.Cartesian3.fromDegrees(startPt.longitude, startPt.latitude, 15);
    this._wakePositions = [startCart, startCart];

    governorRequestRender('simulation-1:reset');

    if (this.route && this.route.ok) {
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('READY');
      }
      if (typeof this.onProgress === 'function') {
        this.onProgress(this.currentPosition, 0, this.route.totalDistanceKm);
      }
      console.log('[SIM1] RESET');
      console.log(`[SIM1] Ship reset to:\nlatitude: ${startPt.latitude}\nlongitude: ${startPt.longitude}`);
      console.log('[SIM1] State:\nREADY');
    }
    console.info('[Simulation1] Reset to start point');
  }

  /**
   * Set playback speed multiplier (1x, 2x, 4x).
   * @param {number} mult
   */
  setSpeed(mult) {
    this.speedMultiplier = Number(mult) || 1;
    if (this.viewer?.clock) {
      this.viewer.clock.multiplier = this.speedMultiplier;
    }
    console.info(`[Simulation1] Speed multiplier set to ${this.speedMultiplier}X (clock.multiplier = ${this.speedMultiplier})`);
  }

  /**
   * Clock tick handler called on every Cesium viewer clock advance.
   * @private
   */
  _onClockTick = (clock) => {
    if (!this.running || this.paused || !this.route || !this.sampledPosition) return;

    const curTime = clock.currentTime;

    // Destination arrival check
    if (this._stopTime && Cesium.JulianDate.compare(curTime, this._stopTime) >= 0) {
      this.completed = true;
      this.stop();
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('COMPLETED');
      }
      console.log('[SIM1] COMPLETED');
      console.info('[Simulation1] Destination reached! Transit completed.');
      return;
    }

    const currentCartesian = this.sampledPosition.getValue(curTime);
    if (!currentCartesian) return;

    // Convert Cartesian3 to geographic coordinates
    const carto = Cesium.Cartographic.fromCartesian(currentCartesian);
    let lat = Cesium.Math.toDegrees(carto.latitude);
    let lon = Cesium.Math.toDegrees(carto.longitude);

    // Hard safety check: ensure tick position is ocean
    const validPos = validateOceanPosition(lat, lon);
    if (validPos && validPos.isLand) {
      lat = validPos.lat;
      lon = validPos.lon;
    }

    // Calculate heading towards immediate upcoming position (0.4s ahead)
    const lookAheadTime = Cesium.JulianDate.addSeconds(curTime, 0.4, new Cesium.JulianDate());
    const aheadCartesian = this.sampledPosition.getValue(lookAheadTime);
    if (aheadCartesian) {
      const aheadCarto = Cesium.Cartographic.fromCartesian(aheadCartesian);
      const aheadLat = Cesium.Math.toDegrees(aheadCarto.latitude);
      const aheadLon = Cesium.Math.toDegrees(aheadCarto.longitude);
      this._currentHeadingDeg = calculateBearingDeg(lat, lon, aheadLat, aheadLon);
    }

    // Update wake trail
    if (this._wakePositions.length < 2) {
      this._wakePositions.push(currentCartesian);
    } else {
      this._wakePositions[this._wakePositions.length - 1] = currentCartesian;
      const lastAnchor = this._wakePositions[this._wakePositions.length - 2];
      if (Cesium.Cartesian3.distance(lastAnchor, currentCartesian) > 600) {
        this._wakePositions.push(currentCartesian);
      }
    }

    // Calculate elapsed time and route progress
    const elapsedSec = Math.max(0, Cesium.JulianDate.secondsDifference(curTime, this._startTime));
    const progressFrac = Math.min(1.0, Math.max(0, elapsedSec / this._durationSeconds));
    const traveledKm = progressFrac * this.route.totalDistanceKm;
    this.distanceTraveledKm = traveledKm;

    this.currentPosition = {
      lat,
      lon,
      headingDeg: this._currentHeadingDeg,
      speedKnots: (this.config.baseSpeedKnots || 15) * (this.speedMultiplier || 1),
    };

    // Broadcast progress to UI HUD
    if (typeof this.onProgress === 'function') {
      this.onProgress(this.currentPosition, this.distanceTraveledKm, this.route.totalDistanceKm);
    }

    // Periodic telemetry console logging (every ~1.0 simulation second)
    const secStep = Math.floor(elapsedSec);
    if (secStep !== this._lastLoggedSec) {
      this._lastLoggedSec = secStep;
      console.log('[SIM1] POSITION');
      console.log(`[SIM1] LAT: ${lat.toFixed(5)}`);
      console.log(`[SIM1] LON: ${lon.toFixed(5)}`);
      console.log('SIM SHIP POSITION');
      console.log(`latitude: ${lat.toFixed(5)}`);
      console.log(`longitude: ${lon.toFixed(5)}`);
      console.log(`simulation time: ${Cesium.JulianDate.toIso8601(curTime)}`);
    }
  };

  /**
   * Attach the clock tick listener.
   * @private
   */
  _attachClockTick() {
    if (this._clockTickRemover || !this.viewer?.clock) return;
    this._clockTickRemover = this.viewer.clock.onTick.addEventListener(this._onClockTick);
  }

  /**
   * Detach the clock tick listener.
   * @private
   */
  _detachClockTick() {
    if (this._clockTickRemover) {
      this._clockTickRemover();
      this._clockTickRemover = null;
    }
  }

  /**
   * Remove all simulation entities from the Cesium globe.
   * @private
   */
  _clearEntities() {
    if (!this.viewer) return;
    const entities = this.viewer.entities;

    if (this._entities.routePolyline) {
      entities.remove(this._entities.routePolyline);
      this._entities.routePolyline = null;
    }
    const routeById = entities.getById('simulation1-route');
    if (routeById) {
      entities.remove(routeById);
    }
    if (this._entities.startPin) {
      entities.remove(this._entities.startPin);
      this._entities.startPin = null;
    }
    if (this._entities.destPin) {
      entities.remove(this._entities.destPin);
      this._entities.destPin = null;
    }
    if (this._entities.ship) {
      entities.remove(this._entities.ship);
      this._entities.ship = null;
    }
    const shipById = entities.getById('simulation1-ship');
    if (shipById) {
      entities.remove(shipById);
    }
    const existingShip = entities.getById('simulation-vessel-sim1');
    if (existingShip) {
      entities.remove(existingShip);
    }
    if (this._entities.wakePolyline) {
      entities.remove(this._entities.wakePolyline);
      this._entities.wakePolyline = null;
    }
    if (Array.isArray(this._entities.hazardHalos)) {
      for (const halo of this._entities.hazardHalos) {
        entities.remove(halo);
      }
      this._entities.hazardHalos = [];
    }

    this._wakePositions = [];
    governorRequestRender('simulation-1:clear');
  }

  /**
   * Teardown and destroy all resources.
   */
  destroy() {
    this.stop();
    this._clearEntities();
    this.active = false;
    this.initialized = false;
    this.viewer = null;
    this.hazards = [];
    this.route = null;
    this.sampledPosition = null;
    console.info('[Simulation1] Destroyed');
  }
}

/**
 * @file simulation2.js
 * Complete functional implementation of Simulation 2: Real-Time Iceberg Hazard Response.
 * Demonstrates real-time proximity detection against an authentic Sentinel-1 grounded iceberg (#620),
 * 5 km operator warning, visual & audible danger alerts, and automatic obstacle-avoidance rerouting.
 */

import * as Cesium from 'cesium';
import { SIMULATION_2_CONFIG } from './simulationConfig.js';
import {
  calculateSafeRoute,
  calculateBearingDeg,
  haversineDistanceKm,
  normalizeCoordinate,
  validateOceanPosition,
  validateSimulationRoute,
  distPointToSegmentKm,
} from './routing.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';

// Cross-environment asset resolution (works in both Vite browser and Node.js test runner)
const DEFAULT_ICEBERGS_URL = new URL('../data/local_data/icebergs/icebergs.geojsonl', import.meta.url).href;

/** SVG Vessel Icon Data URL (reusing ANTARIS high-visibility cyan nautical ship silhouette). */
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

/**
 * Smooth a series of geographic waypoints into a natural curved nautical trajectory.
 * @param {Array<{lat: number, lon: number}>} points
 * @param {number} [samplesPerSegment=8]
 * @returns {Array<{lat: number, lon: number}>}
 */
export function catmullRomSpline(points, samplesPerSegment = 8) {
  if (!points || points.length < 2) return points || [];
  if (points.length === 2) {
    const p0 = points[0];
    const p1 = points[1];
    const out = [];
    for (let i = 0; i <= samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      out.push({
        lat: p0.lat + t * (p1.lat - p0.lat),
        lon: p0.lon + t * (p1.lon - p0.lon),
      });
    }
    return out;
  }

  const extended = [points[0], ...points, points[points.length - 1]];
  const curve = [];

  for (let i = 1; i < extended.length - 2; i++) {
    const p0 = extended[i - 1];
    const p1 = extended[i];
    const p2 = extended[i + 1];
    const p3 = extended[i + 2];

    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;

      const lat = 0.5 * (
        (2 * p1.lat) +
        (-p0.lat + p2.lat) * t +
        (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2 +
        (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3
      );

      const lon = 0.5 * (
        (2 * p1.lon) +
        (-p0.lon + p2.lon) * t +
        (2 * p0.lon - 5 * p1.lon + 4 * p2.lon - p3.lon) * t2 +
        (-p0.lon + 3 * p1.lon - 3 * p2.lon + p3.lon) * t3
      );

      curve.push({ lat, lon });
    }
  }
  curve.push(points[points.length - 1]);
  return curve;
}

/**
 * Calculate intermediate coordinate along segment from (lat1, lon1) to (lat2, lon2)
 * at fraction t with lateral perpendicular offset in kilometers.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} t Fraction [0.0 - 1.0]
 * @param {number} [offsetKm=0] Perpendicular offset in km (left-hand positive)
 * @returns {{lat: number, lon: number}}
 */
export function calculateOffsetCoordinate(lat1, lon1, lat2, lon2, t, offsetKm = 0) {
  const midLatRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const cosLat = Math.cos(midLatRad);
  const dx = (lon2 - lon1) * cosLat;
  const dy = lat2 - lat1;
  const len = Math.hypot(dx, dy);

  const baseLat = lat1 + t * (lat2 - lat1);
  const baseLon = lon1 + t * (lon2 - lon1);

  if (len === 0 || offsetKm === 0) {
    return { lat: baseLat, lon: baseLon };
  }

  // Perpendicular unit vector (left-hand positive)
  const nx = -dy / len;
  const ny = dx / len;

  const deltaLat = ny * (offsetKm / 111.0);
  const deltaLon = nx * (offsetKm / (111.0 * Math.max(0.1, Math.cos(baseLat * (Math.PI / 180)))));

  return {
    lat: baseLat + deltaLat,
    lon: baseLon + deltaLon,
  };
}

/**
 * Minimal Web Audio dual-tone hazard siren (browser-safe, zero external dependencies).
 */
class HazardAudioAlert {
  constructor() {
    this._audioCtx = null;
    this._interval = null;
    this._isPlaying = false;
  }

  /**
   * Initialize audio context upon user interaction.
   */
  init() {
    if (typeof window === 'undefined') return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!this._audioCtx && AudioContextClass) {
        this._audioCtx = new AudioContextClass();
      }
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
    } catch {
      // ignore audio context restrictions
    }
  }

  /**
   * Start alternating 2-tone hazard siren.
   */
  playHazardSiren() {
    this.init();
    if (!this._audioCtx || this._isPlaying) return;
    this._isPlaying = true;

    try {
      let highTone = true;
      const playTone = () => {
        if (!this._isPlaying || !this._audioCtx || this._audioCtx.state !== 'running') return;
        const now = this._audioCtx.currentTime;
        const osc = this._audioCtx.createOscillator();
        const gain = this._audioCtx.createGain();

        // Penetrating maritime klaxon waveform with harmonic overtones
        osc.type = 'triangle';
        const freq = highTone ? 960 : 640;
        osc.frequency.setValueAtTime(freq, now);

        // Boosted audible volume: 0.50 gain for unmistakable emergency alert
        gain.gain.setValueAtTime(0.50, now);
        gain.gain.exponentialRampToValueAtTime(0.02, now + 0.28);

        osc.connect(gain);
        gain.connect(this._audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.30);
        highTone = !highTone;
      };

      playTone();
      this._interval = setInterval(playTone, 320);
    } catch {
      // ignore audio errors
    }
  }

  /**
   * Stop audio siren immediately.
   */
  stop() {
    this._isPlaying = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }
}

export class Simulation2 {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.id = 'sim-2';
    this.name = 'Simulation 2';
    this.title = 'Iceberg Proximity Warning & Auto Response';
    this.description = 'Real-time iceberg detection, 5 km warning, danger siren, and autonomous rerouting';
    this.config = SIMULATION_2_CONFIG;

    this.viewer = options.viewer || null;
    this.icebergsUrl = options.icebergsUrl || null;
    this.initialized = false;
    this.active = false;
    this.running = false;
    this.paused = false;
    this.completed = false;

    this.speedMultiplier = 1;
    this.hazards = [];
    this.targetIceberg = this.config.targetIceberg;
    this.customStart = null;
    this.customDestination = null;
    this.corridorIcebergs = [];
    this.fishingHotspots = [];

    // Movement & Routing State
    this.initialRoute = null;
    this.activeRoute = null;
    this.isRerouted = false;
    this.isCalculatingReroute = false;
    this.currentPosition = null;
    this.distanceToIcebergKm = null;
    this.traveledKm = 0;

    // Hazard warning & danger status
    this.status = 'READY'; // READY | RUNNING | CAUTION | ALERT | DANGER | REROUTED | COMPLETED | STOPPED
    this.statusMessage = '';
    this.hotspotMessageShown = false;
    this.primaryWarned = false;
    this.primarySiren = false;
    this.primaryRerouted = false;
    
    this.movingIcebergActive = false;
    this.movingWarned = false;
    this.movingSiren = false;
    this.movingRerouted = false;

    this.warningActive = false;
    this.sirenActive = false;
    this.dangerActive = false;
    
    this._runId = 1;

    // Cesium clock timing
    this.sampledPosition = null;
    this._startTime = null;
    this._stopTime = null;
    this._durationSeconds = 60;
    this._currentHeadingDeg = 90;
    this._initialHeadingDeg = 90;
    this._clockTickRemover = null;
    this._lastLoggedSec = -1;

    // Entities
    this._entities = {
      ship: null,
      routePolyline: null,
      iceberg: null,
      icebergs: [],
      icebergBuffer: null,
      icebergBuffers: [],
      warningPerimeter: null,
      warningPerimeters: [],
      sirenPerimeter: null,
      sirenPerimeters: [],
      dangerPerimeter: null,
      dangerPerimeters: [],
      fishingHotspots: [],
      startPin: null,
      destPin: null,
    };

    // DOM warning banner
    this._domWarningBanner = null;

    // Web Audio siren
    this._audio = new HazardAudioAlert();

    this._hazardLoadPromise = null;

    // Callbacks for UI sync
    this.onProgress = null;
    this.onStatusChange = null;
    this.onHazardAlert = null;
  }

  /**
   * Get active Start coordinate object.
   * @returns {{latitude: number, longitude: number, name?: string}}
   */
  getStart() {
    const raw = this.customStart || this.config.start;
    const valid = validateOceanPosition(raw.latitude ?? raw.lat, raw.longitude ?? raw.lon);
    return {
      latitude: valid.lat,
      longitude: valid.lon,
      lat: valid.lat,
      lon: valid.lon,
      name: raw.name || raw.label || `${valid.lat.toFixed(4)}°, ${valid.lon.toFixed(4)}°`,
    };
  }

  getDestination() {
    const raw = this.customDestination || this.config.destination;
    const valid = validateOceanPosition(raw.latitude ?? raw.lat, raw.longitude ?? raw.lon);
    return {
      latitude: valid.lat,
      longitude: valid.lon,
      lat: valid.lat,
      lon: valid.lon,
      name: raw.name || raw.label || `${valid.lat.toFixed(4)}°, ${valid.lon.toFixed(4)}°`,
    };
  }

  /**
   * Initialize Simulation 2 with the existing Cesium viewer instance.
   * @param {import('cesium').Viewer} viewer
   */
  initialize(viewer) {
    if (viewer) this.viewer = viewer;
    this.initialized = true;

    // Pre-fetch iceberg hazards from real dataset
    this._ensureHazardsLoaded().catch((err) => {
      console.warn('[Simulation2] Initial hazard pre-load error:', err);
    });

    console.info(`[Simulation2] Initialized with viewer: ${Boolean(this.viewer)}`);
  }

  /**
   * Load real Sentinel-1 iceberg dataset from icebergs.geojsonl.
   * @private
   */
  async _ensureHazardsLoaded() {
    if (this.hazards.length === 0) {
      if (this._hazardLoadPromise) {
        await this._hazardLoadPromise;
      } else {
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
                // skip malformed lines
              }
            }
            this.hazards = loaded;
          } catch (err) {
            console.error('[Simulation2] Failed to load iceberg dataset:', err);
            this.hazards = [];
          } finally {
            this._hazardLoadPromise = null;
          }
        })();
        await this._hazardLoadPromise;
      }
    }

    // Locate designated authentic target iceberg #620
    const foundTarget = this.hazards.find((h) => Number(h.id) === Number(this.config.targetIceberg.id));
    if (foundTarget) {
      this.targetIceberg = {
        ...this.config.targetIceberg,
        latitude: foundTarget.lat ?? this.config.targetIceberg.latitude,
        longitude: foundTarget.lon ?? this.config.targetIceberg.longitude,
        areaKm2: foundTarget.areaKm2,
        polygonCoordinates: foundTarget.polygonCoordinates,
      };
    }

    return this.hazards;
  }

  /**
   * Build initial scenario confronting the real iceberg target,
   * dynamically populating 2-3 corridor icebergs and 1-2 CCAMLR fishing hotspots based on route distance.
   */
  async prepareScenario() {
    await this._ensureHazardsLoaded();

    const startCfg = this.getStart();
    const destCfg = this.getDestination();
    const startPt = {
      lat: Number(startCfg.latitude ?? startCfg.lat),
      lon: Number(startCfg.longitude ?? startCfg.lon),
      name: startCfg.name || startCfg.label || 'Vessel Departure Point',
    };
    const destPt = {
      lat: Number(destCfg.latitude ?? destCfg.lat),
      lon: Number(destCfg.longitude ?? destCfg.lon),
      name: destCfg.name || destCfg.label || 'Vessel Destination Port',
    };

    const directDistKm = haversineDistanceKm(startPt.lat, startPt.lon, destPt.lat, destPt.lon);
    const isDefaultCorridor = !this.customStart && !this.customDestination;

    // 1. Stationary Icebergs
    const ice1 = {
      id: this.targetIceberg.id,
      lat: this.targetIceberg.latitude,
      lon: this.targetIceberg.longitude,
      areaKm2: this.targetIceberg.areaKm2,
      role: 'primary',
      name: this.targetIceberg.name,
    };
    const ice2 = {
      id: this.config.iceberg2.id,
      lat: this.config.iceberg2.latitude,
      lon: this.config.iceberg2.longitude,
      areaKm2: this.config.iceberg2.areaKm2,
      role: 'secondary',
      name: this.config.iceberg2.name,
    };
    const ice3 = {
      id: this.config.iceberg3.id,
      lat: this.config.iceberg3.latitude,
      lon: this.config.iceberg3.longitude,
      areaKm2: this.config.iceberg3.areaKm2,
      role: 'tertiary',
      name: this.config.iceberg3.name,
    };

    if (directDistKm < 45) {
      this.corridorIcebergs = [ice1, ice2];
    } else {
      this.corridorIcebergs = [ice1, ice2, ice3];
    }

    // 2. Fishery Hotspots (CCAMLR)
    const hs1 = {
      id: 'fishery-hotspot-1',
      name: this.config.fisheryHotspot?.name || 'CCAMLR Krill Research Hotspot',
      species: 'Antarctic Krill (Euphausia superba)',
      lat: this.config.fisheryHotspot?.latitude ?? -65.68,
      lon: this.config.fisheryHotspot?.longitude ?? 135.60,
      radiusKm: this.config.fisheryHotspot?.radiusKm ?? 2.5,
    };
    const hs2 = {
      id: 'fishery-hotspot-2',
      name: 'CCAMLR Toothfish Sanctuary',
      species: 'Patagonian Toothfish (Dissostichus eleginoides)',
      lat: -65.90,
      lon: 136.10,
      radiusKm: 3.5,
    };

    if (directDistKm < 45) {
      this.fishingHotspots = [hs1];
    } else {
      this.fishingHotspots = [hs1, hs2];
    }

    // 3. Moving Iceberg (initial state)
    this.movingIcebergState = {
      id: this.config.movingIceberg.id,
      lat: this.config.movingIceberg.startLatitude,
      lon: this.config.movingIceberg.startLongitude,
      areaKm2: this.config.movingIceberg.areaKm2,
      name: this.config.movingIceberg.name,
      active: false,
    };

    // 3. Build extended, elegantly curved nautical approach route aimed at the primary iceberg
    let keypoints;
    if (isDefaultCorridor && Array.isArray(this.config.approachKeypoints) && this.config.approachKeypoints.length >= 2) {
      keypoints = this.config.approachKeypoints;
    } else {
      const kp0 = { lat: startPt.lat, lon: startPt.lon };
      const kp1 = calculateOffsetCoordinate(startPt.lat, startPt.lon, destPt.lat, destPt.lon, 0.20, 0.8);
      // Keypoint 2 aimed directly at the primary iceberg to confront hazard
      const kp2 = { lat: ice1.lat, lon: ice1.lon };
      const kp3 = calculateOffsetCoordinate(startPt.lat, startPt.lon, destPt.lat, destPt.lon, 0.75, -0.6);
      const kp4 = { lat: destPt.lat, lon: destPt.lon };
      keypoints = [kp0, kp1, kp2, kp3, kp4];
    }
    const curvedWaypoints = catmullRomSpline(keypoints, 8);

    let totalDistKm = 0;
    for (let i = 0; i < curvedWaypoints.length - 1; i++) {
      totalDistKm += haversineDistanceKm(
        curvedWaypoints[i].lat,
        curvedWaypoints[i].lon,
        curvedWaypoints[i + 1].lat,
        curvedWaypoints[i + 1].lon,
      );
    }

    const startToIcebergKm = haversineDistanceKm(
      startPt.lat,
      startPt.lon,
      this.targetIceberg.latitude,
      this.targetIceberg.longitude,
    );

    this.initialRoute = {
      ok: true,
      waypoints: curvedWaypoints,
      totalDistanceKm: totalDistKm,
      startToIcebergKm,
    };
    this.activeRoute = this.initialRoute;
    this.isRerouted = false;
    this.isCalculatingReroute = false;
    
    this.hotspotMessageShown = false;
    this.primaryWarned = false;
    this.primarySiren = false;
    this.primaryRerouted = false;
    
    this.movingIcebergActive = false;
    this.movingWarned = false;
    this.movingSiren = false;
    this.movingRerouted = false;

    this.warningActive = false;
    this.dangerActive = false;
    this.distanceToIcebergKm = startToIcebergKm;

    this.currentPosition = {
      lat: curvedWaypoints[0].lat,
      lon: curvedWaypoints[0].lon,
      headingDeg: calculateBearingDeg(
        curvedWaypoints[0].lat,
        curvedWaypoints[0].lon,
        curvedWaypoints[1].lat,
        curvedWaypoints[1].lon,
      ),
    };

    this._buildSampledPositions(this.activeRoute.waypoints);
    this._renderEntities();

    this.status = 'READY';
    this.statusMessage = 'READY';
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.status, {
        distanceKm: this.distanceToIcebergKm,
        icebergId: this.targetIceberg.id,
        icebergsCount: this.corridorIcebergs.length,
        hotspotsCount: this.fishingHotspots.length,
      });
    }

    console.info(`[Simulation2] Scenario ready: ${this.corridorIcebergs.length} icebergs, ${this.fishingHotspots.length} fishing hotspots. Target #${this.targetIceberg.id} at ${startToIcebergKm.toFixed(2)} km.`);
    return this.initialRoute;
  }

  /**
   * Rebuild scenario dynamically with custom Start and Destination coordinates.
   * @param {object} newStart
   * @param {object} newDest
   * @returns {Promise<object>}
   */
  async rebuildScenario(newStart, newDest) {
    this.stop();
    this.completed = false;
    this.isRerouted = false;
    this.isCalculatingReroute = false;
    this.warningActive = false;
    this.dangerActive = false;
    this._audio.stop();
    this._removeWarningBanner();

    if (newStart) {
      this.customStart = {
        latitude: Number(newStart.latitude ?? newStart.lat),
        longitude: Number(newStart.longitude ?? newStart.lon),
        name: newStart.name || newStart.label || 'Selected Departure Point',
      };
    }
    if (newDest) {
      this.customDestination = {
        latitude: Number(newDest.latitude ?? newDest.lat),
        longitude: Number(newDest.longitude ?? newDest.lon),
        name: newDest.name || newDest.label || 'Selected Destination Port',
      };
    }

    const route = await this.prepareScenario();
    this.frameRouteInCamera();
    governorRequestRender('simulation-2:rebuilt');
    return {
      ok: true,
      route,
      icebergs: this.corridorIcebergs,
      fishingHotspots: this.fishingHotspots,
    };
  }

  /**
   * Construct Cesium.SampledPositionProperty from given waypoints.
   * @private
   */
  _buildSampledPositions(waypoints) {
    if (!waypoints || waypoints.length < 2) return;

    const baseKnots = Number(this.config.baseSpeedKnots) || 15;
    const knotToMps = Number(this.config.knotToMps) || 0.514444;
    const baseMps = baseKnots * knotToMps; // 7.71666 m/s
    const timeCompression = Number(this.config.timeCompressionFactor) || 220;
    const effectiveMps = baseMps * timeCompression;

    this._startTime = Cesium.JulianDate.now();
    let currentJulianDate = Cesium.JulianDate.clone(this._startTime);
    let totalElapsedSec = 0;

    this.sampledPosition = new Cesium.SampledPositionProperty();
    this.sampledPosition.setInterpolationOptions({
      interpolationDegree: 1,
      interpolationAlgorithm: Cesium.LinearApproximation,
    });
    this.sampledPosition.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    this.sampledPosition.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

    // Add Waypoint 0
    const startWp = waypoints[0];
    this.sampledPosition.addSample(currentJulianDate, Cesium.Cartesian3.fromDegrees(startWp.lon, startWp.lat, 25));

    for (let i = 1; i < waypoints.length; i++) {
      const prev = waypoints[i - 1];
      const curr = waypoints[i];
      const legDistKm = haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);
      const legMeters = legDistKm * 1000;
      const segDurationSec = legMeters / effectiveMps;
      totalElapsedSec += segDurationSec;
      currentJulianDate = Cesium.JulianDate.addSeconds(this._startTime, totalElapsedSec, new Cesium.JulianDate());
      this.sampledPosition.addSample(currentJulianDate, Cesium.Cartesian3.fromDegrees(curr.lon, curr.lat, 25));
    }

    this._durationSeconds = totalElapsedSec;
    this._stopTime = Cesium.JulianDate.clone(currentJulianDate);
    this._initialHeadingDeg = calculateBearingDeg(waypoints[0].lat, waypoints[0].lon, waypoints[1].lat, waypoints[1].lon);
    this._currentHeadingDeg = this._initialHeadingDeg;
  }

  /**
   * Render Cesium entities for Simulation 2: Ship, Route, Multiple Icebergs with buffers, and CCAMLR Fishing Hotspots.
   * @private
   */
  _renderEntities() {
    if (!this.viewer || !this.activeRoute) return;

    this._clearEntities();
    const entities = this.viewer.entities;
    const waypoints = this.activeRoute.waypoints;

    // 1. Initial / Active Vessel Route Polyline (Stable ID: simulation2-route)
    const positions = waypoints.map((wp) => Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, 15));
    this._entities.routePolyline = entities.add({
      id: 'simulation2-route',
      name: 'Simulation 2 Active Corridor',
      polyline: {
        positions,
        width: 6,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.28,
          color: Cesium.Color.fromCssColorString(this.isRerouted ? '#00ff88' : '#ff9900'),
        }),
        clampToGround: false,
      },
    });

    // 2. Corridor Icebergs & Buffers (2-3 icebergs)
    this._entities.icebergs = [];
    this._entities.icebergBuffers = [];
    this._entities.warningPerimeters = [];
    this._entities.sirenPerimeters = [];
    this._entities.dangerPerimeters = [];

    const icebergsToRender = this.corridorIcebergs.length > 0
      ? this.corridorIcebergs
      : [{
          id: this.targetIceberg.id || 620,
          lat: this.targetIceberg.latitude,
          lon: this.targetIceberg.longitude,
          areaKm2: this.targetIceberg.areaKm2 || 1.85,
          role: 'primary',
          name: `Iceberg #${this.targetIceberg.id || 620}`,
        }];

    icebergsToRender.forEach((ice, idx) => {
      const isPrimary = idx === 0 || ice.role === 'primary';
      const iceId = ice.id;
      const iceLat = ice.lat;
      const iceLon = ice.lon;
      const iceArea = ice.areaKm2 ? Number(ice.areaKm2).toFixed(2) : '1.85';
      const entityId = isPrimary ? 'simulation2-iceberg' : `simulation2-iceberg-${idx}`;
      const bufferId = isPrimary ? 'simulation2-iceberg-buffer' : `simulation2-iceberg-buffer-${idx}`;

      // Iceberg Marker & Cylinder
      const bergEntity = entities.add({
        id: entityId,
        name: `Iceberg #${iceId}`,
        position: Cesium.Cartesian3.fromDegrees(iceLon, iceLat, 20),
        point: {
          pixelSize: isPrimary ? 16 : 13,
          color: Cesium.Color.fromCssColorString(isPrimary ? '#00e5ff' : '#66d9ff'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: isPrimary ? 3 : 2,
        },
        cylinder: {
          length: 80,
          topRadius: isPrimary ? 350 : 280,
          bottomRadius: isPrimary ? 450 : 360,
          material: Cesium.Color.fromCssColorString(isPrimary ? 'rgba(0, 229, 255, 0.75)' : 'rgba(0, 180, 255, 0.65)'),
          outline: true,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1.5,
        },
        label: {
          text: `🧊 ICEBERG #${iceId}\n(${isPrimary ? 'Primary Radar Hazard' : 'Flanking Grounded Berg'})\nArea: ${iceArea} km²`,
          font: 'bold 11px monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -22),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000000),
        },
      });
      this._entities.icebergs.push(bergEntity);
      if (isPrimary) this._entities.iceberg = bergEntity;

      // Iceberg Safety Clearance Buffer (6.0 km)
      const bufRadiusM = (this.config.icebergSafetyRadiusKm || 6.0) * 1000;
      const bufEntity = entities.add({
        id: bufferId,
        name: `Iceberg #${iceId} Safety Clearance Buffer`,
        position: Cesium.Cartesian3.fromDegrees(iceLon, iceLat, 5),
        ellipse: {
          semiMinorAxis: bufRadiusM,
          semiMajorAxis: bufRadiusM,
          material: Cesium.Color.fromCssColorString('rgba(255, 0, 0, 0.16)'),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('rgba(255, 0, 0, 0.9)'),
          outlineWidth: 2.2,
          height: 5,
        },
      });
      this._entities.icebergBuffers.push(bufEntity);
      if (isPrimary) this._entities.icebergBuffer = bufEntity;

      // Primary Iceberg 3-Tier Alert Rings: 12 km (Msg), 10 km (Siren), 8 km (Reroute)
      if (isPrimary) {
        // Tier 1: 12 km Warning Perimeter Ring (Message alert)
        const warnDistM = (this.config.warningDistanceKm || 12.0) * 1000;
        const warnEntity = entities.add({
          id: 'simulation2-warning-perimeter',
          name: `Iceberg #${iceId} 12km Warning Perimeter (Message Alert)`,
          position: Cesium.Cartesian3.fromDegrees(iceLon, iceLat, 5),
          ellipse: {
            semiMinorAxis: warnDistM,
            semiMajorAxis: warnDistM,
            material: Cesium.Color.fromCssColorString('rgba(255, 170, 0, 0.05)'),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('rgba(255, 170, 0, 0.55)'),
            outlineWidth: 1.5,
            height: 5,
          },
        });
        this._entities.warningPerimeters.push(warnEntity);
        this._entities.warningPerimeter = warnEntity;

        // Tier 2: 10 km Siren Perimeter Ring (Hazard siren alert)
        const sirenDistM = (this.config.sirenDistanceKm || 10.0) * 1000;
        const sirenEntity = entities.add({
          id: 'simulation2-siren-perimeter',
          name: `Iceberg #${iceId} 10km Siren Perimeter (Hazard Siren)`,
          position: Cesium.Cartesian3.fromDegrees(iceLon, iceLat, 5),
          ellipse: {
            semiMinorAxis: sirenDistM,
            semiMajorAxis: sirenDistM,
            material: Cesium.Color.fromCssColorString('rgba(255, 100, 0, 0.07)'),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('rgba(255, 100, 0, 0.75)'),
            outlineWidth: 1.8,
            height: 5,
          },
        });
        this._entities.sirenPerimeters.push(sirenEntity);
        this._entities.sirenPerimeter = sirenEntity;

        // Tier 3: 8 km Reroute Perimeter Ring (Autonomous obstacle avoidance)
        const dangerDistM = (this.config.dangerDistanceKm || 8.0) * 1000;
        const dangerEntity = entities.add({
          id: 'simulation2-danger-perimeter',
          name: `Iceberg #${iceId} 8km Reroute Zone (Autonomous Course Change)`,
          position: Cesium.Cartesian3.fromDegrees(iceLon, iceLat, 5),
          ellipse: {
            semiMinorAxis: dangerDistM,
            semiMajorAxis: dangerDistM,
            material: Cesium.Color.fromCssColorString('rgba(255, 30, 30, 0.10)'),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('rgba(255, 30, 30, 0.85)'),
            outlineWidth: 2.0,
            height: 5,
          },
        });
        this._entities.dangerPerimeters.push(dangerEntity);
        this._entities.dangerPerimeter = dangerEntity;
      }
    });

    // 3. CCAMLR Fishing Hotspots
    this._entities.fishingHotspots = [];
    this.fishingHotspots.forEach((hs, hIdx) => {
      const hsId = `simulation2-hotspot-${hIdx}`;
      const hsLat = hs.lat;
      const hsLon = hs.lon;
      const hsRadiusM = (hs.radiusKm || 2.5) * 1000;

      const hsEntity = entities.add({
        id: hsId,
        name: `Fishing Hotspot: ${hs.name}`,
        position: Cesium.Cartesian3.fromDegrees(hsLon, hsLat, 15),
        ellipse: {
          semiMinorAxis: hsRadiusM,
          semiMajorAxis: hsRadiusM,
          material: Cesium.Color.fromCssColorString('rgba(124, 255, 155, 0.14)'),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('rgba(124, 255, 155, 0.85)'),
          outlineWidth: 2.0,
          height: 4,
        },
        label: {
          text: `🐟 FISHING HOTSPOT`,
          font: 'bold 11px monospace',
          fillColor: Cesium.Color.fromCssColorString('#7cff9b'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -22),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000000),
        },
      });
      this._entities.fishingHotspots.push(hsEntity);
    });
    
    // 3.5 Moving Iceberg Entity (always render at its current position)
    if (false && this.movingIcebergState) {
       this._entities.movingIceberg = entities.add({
         id: 'simulation2-moving-iceberg',
         name: this.movingIcebergState.name,
         position: new Cesium.CallbackProperty(() => {
           return Cesium.Cartesian3.fromDegrees(this.movingIcebergState.lon, this.movingIcebergState.lat, 20);
         }, false),
         point: {
           pixelSize: 16,
           color: Cesium.Color.fromCssColorString('#ff4444'),
           outlineColor: Cesium.Color.WHITE,
           outlineWidth: 3,
         },
         cylinder: {
           length: 80,
           topRadius: 350,
           bottomRadius: 450,
           material: Cesium.Color.fromCssColorString('rgba(255, 68, 68, 0.75)'),
           outline: true,
           outlineColor: Cesium.Color.WHITE,
           outlineWidth: 1.5,
         },
         label: {
           text: `🧊 MOVING ICEBERG`,
           font: 'bold 11px monospace',
           fillColor: Cesium.Color.WHITE,
           outlineColor: Cesium.Color.BLACK,
           outlineWidth: 3,
           style: Cesium.LabelStyle.FILL_AND_OUTLINE,
           verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
           pixelOffset: new Cesium.Cartesian2(0, -22),
         },
       });
       
       this._entities.movingIcebergBuffer = entities.add({
         id: 'simulation2-moving-iceberg-buffer',
         name: 'Moving Iceberg Buffer',
         position: new Cesium.CallbackProperty(() => {
           return Cesium.Cartesian3.fromDegrees(this.movingIcebergState.lon, this.movingIcebergState.lat, 5);
         }, false),
         ellipse: {
           semiMinorAxis: 8.0 * 1000,
           semiMajorAxis: 8.0 * 1000,
           material: Cesium.Color.fromCssColorString('rgba(255, 0, 0, 0.16)'),
           outline: true,
           outlineColor: Cesium.Color.fromCssColorString('rgba(255, 0, 0, 0.9)'),
           outlineWidth: 2.2,
           height: 5,
         },
       });
    }

    // 4. Start and Destination Pins
    const startPt = this.getStart();
    const destPt = this.getDestination();
    const startLat = Number(startPt.latitude ?? startPt.lat);
    const startLon = Number(startPt.longitude ?? startPt.lon);
    const startName = startPt.name || startPt.label || 'Vessel Departure';
    const destLat = Number(destPt.latitude ?? destPt.lat);
    const destLon = Number(destPt.longitude ?? destPt.lon);
    const destName = destPt.name || destPt.label || 'Vessel Destination';

    this._entities.startPin = entities.add({
      id: 'simulation2-start-pin',
      name: `START: ${startName}`,
      position: Cesium.Cartesian3.fromDegrees(startLon, startLat, 20),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2.5,
      },
      label: {
        text: `⚓ START\n${startName}`,
        font: 'bold 11px monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -16),
      },
    });

    this._entities.destPin = entities.add({
      id: 'simulation2-dest-pin',
      name: `DESTINATION: ${destName}`,
      position: Cesium.Cartesian3.fromDegrees(destLon, destLat, 20),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#ff007f'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2.5,
      },
      label: {
        text: `🏁 DESTINATION\n${destName}`,
        font: 'bold 11px monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -16),
      },
    });

    // 5. Exactly ONE Simulated Ship Entity (Stable ID: simulation2-ship)
    this._entities.ship = entities.add({
      id: 'simulation2-ship',
      name: 'SIMULATION 2 VESSEL: RV POLAR EXPLORER',
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
        text: 'SIMULATION 2\nRV POLAR EXPLORER',
        font: 'bold 11px monospace',
        fillColor: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -24),
      },
    });

    governorRequestRender('simulation-2:entities-rendered');
  }

  /**
   * Smoothly frame route, icebergs, and hotspots in Cesium camera.
   */
  frameRouteInCamera() {
    if (!this.viewer) return;
    try {
      const startPt = this.getStart();
      const destPt = this.getDestination();
      const startLat = Number(startPt.latitude ?? startPt.lat);
      const startLon = Number(startPt.longitude ?? startPt.lon);
      const destLat = Number(destPt.latitude ?? destPt.lat);
      const destLon = Number(destPt.longitude ?? destPt.lon);

      const midLon = (startLon + destLon) / 2;
      const midLat = (startLat + destLat) / 2;
      const distKm = haversineDistanceKm(startLat, startLon, destLat, destLon);
      const camHeight = Math.max(55000, distKm * 1800);

      if (this.viewer.camera) {
        this.viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(midLon, midLat, camHeight),
          duration: 1.5,
        });
      }
    } catch {
      // ignore camera interrupt
    }
  }

  /**
   * Called when Simulation 2 is activated.
   */
  async activate() {
    this.active = true;
    console.info('[Simulation2] Activated');

    if (!this.initialRoute) {
      await this.prepareScenario();
    } else if (this.viewer && !this._entities.routePolyline) {
      this._renderEntities();
    }
    this.frameRouteInCamera();
  }

  /**
   * Called when Simulation 2 is deactivated.
   */
  deactivate() {
    this.stop();
    this._clearEntities();
    this._removeWarningBanner();
    this._audio.stop();
    this.active = false;
    console.info('[Simulation2] Deactivated');
  }

  /**
   * Start vessel movement along Simulation 2 route.
   */
  async start() {
    if (!this.active) await this.activate();

    if (!this.initialRoute || !this.sampledPosition) {
      await this.prepareScenario();
    }

    if (!this._entities.routePolyline && this.viewer) {
      this._renderEntities();
    }

    if (this.completed) {
      this.reset();
    }

    this.running = true;
    this.paused = false;
    this.completed = false;
    this._lastLoggedSec = -1;

    // Initialize audio context upon user START click to satisfy browser autoplay policy
    this._audio.init();

    // Configure existing Cesium Viewer Clock
    if (this.viewer?.clock && this._startTime && this._stopTime) {
      this.viewer.clock.startTime = this._startTime.clone();
      this.viewer.clock.stopTime = this._stopTime.clone();
      this.viewer.clock.currentTime = this._startTime.clone();
      this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
      this.viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
      this.viewer.clock.multiplier = Number(this.speedMultiplier) || 1;
      this.viewer.clock.shouldAnimate = true;
    }

    this._attachClockTick();
    holdContinuousRender('simulation-2');
    this.viewer?.scene?.requestRender?.();

    if (this.traveledKm === 0) {
      this.frameRouteInCamera();
    }

    this.status = 'RUNNING';
    this.statusMessage = 'APPROACHING ICEBERG CORRIDOR';
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.status, {
        distanceKm: this.distanceToIcebergKm,
        icebergId: this.targetIceberg.id,
      });
    }

    console.log('[SIM2] START');
    console.log(`[SIM2] Target Iceberg #${this.targetIceberg.id} distance: ${this.distanceToIcebergKm?.toFixed(2)} km`);
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
    this._audio.stop();
    releaseContinuousRender('simulation-2');
    governorRequestRender('simulation-2:paused');

    this.status = 'PAUSED';
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('PAUSED', {
        distanceKm: this.distanceToIcebergKm,
        icebergId: this.targetIceberg.id,
      });
    }

    console.log('[SIM2] PAUSED');
  }

  /**
   * Resume simulation playback.
   */
  resume() {
    if (!this.running || !this.paused) return;

    this.paused = false;
    if (this.viewer?.clock) {
      this.viewer.clock.multiplier = Number(this.speedMultiplier) || 1;
      this.viewer.clock.shouldAnimate = true;
    }
    if (this.dangerActive && !this.isRerouted) {
      this._audio.playHazardSiren();
    }
    holdContinuousRender('simulation-2');
    this.viewer?.scene?.requestRender?.();

    this.status = this.dangerActive ? 'DANGER' : this.warningActive ? 'CAUTION' : 'RUNNING';
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.status, {
        distanceKm: this.distanceToIcebergKm,
        icebergId: this.targetIceberg.id,
      });
    }

    console.log('[SIM2] RESUMED');
  }

  /**
   * Stop simulation playback.
   */
  stop() {
    this.running = false;
    this.paused = false;
    this.sirenActive = false;
    if (this.viewer?.clock) {
      this.viewer.clock.shouldAnimate = false;
    }
    this._detachClockTick();
    this._audio.stop();
    releaseContinuousRender('simulation-2');
    governorRequestRender('simulation-2:stopped');
  }

  /**
   * Reset simulation back to initial state and ready status.
   */
  reset() {
    this.stop();
    this.completed = false;
    this.traveledKm = 0;
    this._lastLoggedSec = -1;
    this.isRerouted = false;
    this.isCalculatingReroute = false;
    this.warningActive = false;
    this.sirenActive = false;
    this.dangerActive = false;
    this._audio.stop();
    this._removeWarningBanner();

    this.hotspotMessageShown = false;
    this.primaryWarned = false;
    this.primarySiren = false;
    this.primaryRerouted = false;
    
    this.movingIcebergActive = false;
    this.movingWarned = false;
    this.movingSiren = false;
    this.movingRerouted = false;

    if (this.movingIcebergState && this.config.movingIceberg) {
        this.movingIcebergState.lat = this.config.movingIceberg.startLatitude;
        this.movingIcebergState.lon = this.config.movingIceberg.startLongitude;
        this.movingIcebergState.active = false;
    }
    
    this._runId = (this._runId || 0) + 1;

    // Restore original route
    this.activeRoute = this.initialRoute;

    const startCfg = this.getStart();
    const destCfg = this.getDestination();
    const startPt = {
      latitude: Number(startCfg.latitude ?? startCfg.lat),
      longitude: Number(startCfg.longitude ?? startCfg.lon),
    };
    const destPt = {
      latitude: Number(destCfg.latitude ?? destCfg.lat),
      longitude: Number(destCfg.longitude ?? destCfg.lon),
    };

    this.distanceToIcebergKm = haversineDistanceKm(
      startPt.latitude,
      startPt.longitude,
      this.targetIceberg.latitude,
      this.targetIceberg.longitude,
    );

    this.currentPosition = {
      lat: startPt.latitude,
      lon: startPt.longitude,
      headingDeg: calculateBearingDeg(startPt.latitude, startPt.longitude, destPt.latitude, destPt.longitude),
    };

    if (this.activeRoute) {
      this._buildSampledPositions(this.activeRoute.waypoints);
    }

    if (this.viewer?.clock && this._startTime) {
      this.viewer.clock.currentTime = this._startTime.clone();
      this.viewer.clock.shouldAnimate = false;
    }

    // Re-render entities with original yellow/orange route
    if (this.viewer) {
      this._renderEntities();
    }

    this.status = 'READY';
    this.statusMessage = 'READY';
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('READY', {
        distanceKm: this.distanceToIcebergKm,
        icebergId: this.targetIceberg.id,
      });
    }
    if (typeof this.onProgress === 'function' && this.activeRoute) {
      this.onProgress(this.currentPosition, 0, this.activeRoute.totalDistanceKm, this.distanceToIcebergKm);
    }

    governorRequestRender('simulation-2:reset');
    console.log('[SIM2] RESET to initial state');
  }

  /**
   * Set simulation playback speed multiplier.
   * @param {number} mult
   */
  setSpeed(mult) {
    this.speedMultiplier = Number(mult) || 1;
    if (this.viewer?.clock) {
      this.viewer.clock.multiplier = this.speedMultiplier;
    }
    console.info(`[Simulation2] Speed multiplier set to ${this.speedMultiplier}X`);
  }

  /**
   * Clock tick listener called on every Cesium viewer clock advance.
   * @private
   */
  _onClockTick = (clock) => {
    if (!this.running || this.paused || this.isCalculatingReroute || !this.activeRoute || !this.sampledPosition) return;
    if (clock && clock.shouldAnimate === false) return;

    const curTime = clock.currentTime;

    // Destination arrival check
    if (this._stopTime && Cesium.JulianDate.compare(curTime, this._stopTime) >= 0) {
      this.completed = true;
      this.stop();
      this.status = 'COMPLETED';
      this.statusMessage = 'TRANSIT COMPLETED SAFELY';
      this._removeWarningBanner();
      this._audio.stop();
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('COMPLETED', {
          distanceKm: this.distanceToIcebergKm,
          icebergId: this.targetIceberg.id,
        });
      }
      console.log('[SIM2] COMPLETED');
      return;
    }

    const currentCartesian = this.sampledPosition.getValue(curTime);
    if (!currentCartesian) return;

    const carto = Cesium.Cartographic.fromCartesian(currentCartesian);
    let lat = Cesium.Math.toDegrees(carto.latitude);
    let lon = Cesium.Math.toDegrees(carto.longitude);

    // Hard safety check: ensure tick position is ocean
    const validPos = validateOceanPosition(lat, lon);
    if (validPos && validPos.isLand) {
      lat = validPos.lat;
      lon = validPos.lon;
    }

    // Compute heading towards next micro-step
    const lookAheadTime = Cesium.JulianDate.addSeconds(curTime, 0.4, new Cesium.JulianDate());
    const aheadCartesian = this.sampledPosition.getValue(lookAheadTime);
    if (aheadCartesian) {
      const aheadCarto = Cesium.Cartographic.fromCartesian(aheadCartesian);
      this._currentHeadingDeg = calculateBearingDeg(
        lat,
        lon,
        Cesium.Math.toDegrees(aheadCarto.latitude),
        Cesium.Math.toDegrees(aheadCarto.longitude),
      );
    }

    // Precise real-time geographic distance between ship and target iceberg
    const distKm = haversineDistanceKm(lat, lon, this.targetIceberg.latitude, this.targetIceberg.longitude);
    this.distanceToIcebergKm = distKm;

    this.currentPosition = {
      lat,
      lon,
      headingDeg: this._currentHeadingDeg,
      speedKnots: (this.config.baseSpeedKnots || 15) * (this.speedMultiplier || 1),
    };

    // Calculate elapsed time and route distance
    const elapsedSec = Math.max(0, Cesium.JulianDate.secondsDifference(curTime, this._startTime));
    const progressFrac = Math.min(1.0, Math.max(0, elapsedSec / this._durationSeconds));
    this.traveledKm = progressFrac * this.activeRoute.totalDistanceKm;

    // Notify UI
    if (typeof this.onProgress === 'function') {
      this.onProgress(this.currentPosition, this.traveledKm, this.activeRoute.totalDistanceKm, this.distanceToIcebergKm);
    }

    // Periodic telemetry log
    const secStep = Math.floor(elapsedSec);
    if (secStep !== this._lastLoggedSec) {
      this._lastLoggedSec = secStep;
      console.log(`[SIM2] DISTANCE TO ICEBERG #${this.targetIceberg.id}: ${distKm.toFixed(2)} km | SHIP: (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    }

    // Update moving iceberg if active
    if (false && this.movingIcebergState && this.movingIcebergState.active) {
       // dt is in seconds, multiplied by time compression and speed multiplier
       const dt = Math.max(0, Cesium.JulianDate.secondsDifference(curTime, this._lastClockTime || curTime)) * (this.config.timeCompressionFactor || 1);
       if (dt > 0) {
           this.movingIcebergState.lat += (this.movingIcebergState.velocityLat ?? this.config.movingIceberg.velocityLat) * dt;
           this.movingIcebergState.lon += (this.movingIcebergState.velocityLon ?? this.config.movingIceberg.velocityLon) * dt;
       }
    } else if (this.movingIcebergState && !this.movingIcebergState.active && this.primaryRerouted) {
       // Dynamic Intercept Logic: activate once vessel travels 5 km along the new rerouted path
       if (this.traveledKm >= 5.0) {
           let targetDist = this.traveledKm + 45.0; // aim further ahead so it travels visibly across the map
           if (targetDist > this.activeRoute.totalDistanceKm) {
               targetDist = this.traveledKm + (this.activeRoute.totalDistanceKm - this.traveledKm) * 0.7;
           }
           let cumDist = 0;
           let interceptWp = this.activeRoute.waypoints[this.activeRoute.waypoints.length - 1];
           for (let i = 0; i < this.activeRoute.waypoints.length - 1; i++) {
               const p1 = this.activeRoute.waypoints[i];
               const p2 = this.activeRoute.waypoints[i + 1];
               cumDist += haversineDistanceKm(p1.lat, p1.lon, p2.lat, p2.lon);
               if (cumDist >= targetDist) {
                   interceptWp = p2;
                   break;
               }
           }
           
           // Calculate time for vessel to reach the interception point
           const baseKnots = Number(this.config.baseSpeedKnots) || 15;
           const knotToMps = Number(this.config.knotToMps) || 0.514444;
           const baseMps = baseKnots * knotToMps; 
           
           const distMeters = (targetDist - this.traveledKm) * 1000;
           const simTimeSeconds = distMeters / baseMps; // Real time is this divided by timeCompression, but we need sim time
           
           // Calculate required velocity in degrees per simulated second to reach intercept point
           const latDiff = interceptWp.lat - this.movingIcebergState.lat;
           const lonDiff = interceptWp.lon - this.movingIcebergState.lon;
           
           // Make the iceberg arrive slightly before the ship (e.g. 95% of the time)
           const timeBuffer = simTimeSeconds * 0.95;
           
           this.movingIcebergState.velocityLat = latDiff / timeBuffer;
           this.movingIcebergState.velocityLon = lonDiff / timeBuffer;
           this.movingIcebergState.active = true;
           
           console.log(`[SIM2] Moving Iceberg intercept calculated. Target: (${interceptWp.lat.toFixed(4)}, ${interceptWp.lon.toFixed(4)}). SimTime: ${timeBuffer.toFixed(2)}s`);
       }
    }
    this._lastClockTime = curTime.clone();

    // Fishery Hotspot Check
    if (this.fishingHotspots.length > 0 && !this.hotspotMessageShown) {
      const distToHotspot = haversineDistanceKm(lat, lon, this.fishingHotspots[0].lat, this.fishingHotspots[0].lon);
      if (distToHotspot <= (this.fishingHotspots[0].radiusKm || 6.0)) {
        this.hotspotMessageShown = true;
        this._showWarningBanner("Ship is passing through fishery hotspot", "caution");
        setTimeout(() => this._removeWarningBanner(), 5000);
      }
    }

    // TIER 1: 12 km Warning Check
    const warningDist = Number(this.config.warningDistanceKm) || 12.0;
    const sirenDist = Number(this.config.sirenDistanceKm) || 10.0;
    const dangerDist = Number(this.config.dangerDistanceKm) || 8.0;

    // Active hazard logic
    if (!this.primaryRerouted) {
       if (distKm <= warningDist && !this.primaryWarned) {
         this.primaryWarned = true;
         this.warningActive = true;
         this.status = 'CAUTION';
         this.statusMessage = 'YOU ARE VERY CLOSE TO THE ICEBERG PLEASE CHANGE THE ROUTE';
         if (typeof this.onStatusChange === 'function') {
           this.onStatusChange('CAUTION', {
             warning: this.statusMessage,
             distanceKm: distKm,
             icebergId: this.targetIceberg.id,
           });
         }
         this._showWarningBanner('Ship is moving towards iceberg please change the route', 'caution');
       }
       if (distKm <= sirenDist && !this.primarySiren) {
         this.primarySiren = true;
         this.warningActive = true;
         this.sirenActive = true;
         this.status = 'ALERT';
         this.statusMessage = 'ICEBERG WARNING\n10 KM';
         if (typeof this.onStatusChange === 'function') {
           this.onStatusChange('ALERT', {
             warning: this.statusMessage,
             distanceKm: distKm,
             icebergId: this.targetIceberg.id,
           });
         }
         this._audio.playHazardSiren();
         this._showWarningBanner('ICEBERG WARNING\n10 KM', 'danger');
       }
       if (distKm <= dangerDist && !this.isCalculatingReroute) {
         this.primaryRerouted = true;
         this.dangerActive = true;
         this.status = 'DANGER';
         this.statusMessage = 'ICEBERG DANGER 8 KM';
         if (typeof this.onStatusChange === 'function') {
           this.onStatusChange('DANGER', {
             warning: this.statusMessage,
             distanceKm: distKm,
             icebergId: this.targetIceberg.id,
           });
         }
         this._triggerAutomaticResponse();
       }
    } else if (this.movingIcebergState && this.movingIcebergState.active && !this.movingRerouted) {
       // Moving iceberg phase
       const distToMoving = haversineDistanceKm(lat, lon, this.movingIcebergState.lat, this.movingIcebergState.lon);
       if (distToMoving <= warningDist && !this.movingWarned) {
         this.movingWarned = true;
         this.warningActive = true;
         this.status = 'CAUTION';
         this.statusMessage = 'YOU ARE VERY CLOSE TO THE ICEBERG PLEASE CHANGE THE ROUTE';
         if (typeof this.onStatusChange === 'function') {
           this.onStatusChange('CAUTION', {
             warning: this.statusMessage,
             distanceKm: distToMoving,
             icebergId: this.movingIcebergState.id,
           });
         }
         this._showWarningBanner('Ship is moving towards iceberg please change the route', 'caution');
       }
       if (distToMoving <= sirenDist && !this.movingSiren) {
         this.movingSiren = true;
         this.warningActive = true;
         this.sirenActive = true;
         this.status = 'ALERT';
         this.statusMessage = 'ICEBERG WARNING\n10 KM';
         if (typeof this.onStatusChange === 'function') {
           this.onStatusChange('ALERT', {
             warning: this.statusMessage,
             distanceKm: distToMoving,
             icebergId: this.movingIcebergState.id,
           });
         }
         this._audio.playHazardSiren();
         this._showWarningBanner('ICEBERG WARNING\n10 KM', 'danger');
       }
       if (distToMoving <= dangerDist && !this.isCalculatingReroute) {
         this.movingRerouted = true;
         this.dangerActive = true;
         this.status = 'DANGER';
         this.statusMessage = 'ICEBERG DANGER 8 KM';
         if (typeof this.onStatusChange === 'function') {
           this.onStatusChange('DANGER', {
             warning: this.statusMessage,
             distanceKm: distToMoving,
             icebergId: this.movingIcebergState.id,
           });
         }
         this._triggerAutomaticResponse(true);
       }
    }
  };

  async _triggerAutomaticResponse(isMovingPhase = false) {
    this.isCalculatingReroute = true;
    this.dangerActive = true;
    this.status = 'DANGER';
    this.statusMessage = 'ICEBERG DANGER 8 KM';
    
    const currentRunId = this._runId;

    // 1. Immediately halt forward movement on Cesium clock
    if (this.viewer?.clock) {
      this.viewer.clock.shouldAnimate = false;
    }

    this._showWarningBanner('AUTOMATIC REROUTING IN PROGRESS...', 'danger');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    if (this._runId !== currentRunId) return;

    // 4. Calculate safe route around ALL corridor icebergs from current position (~8 km) to destination
    const currentPt = {
      latitude: this.currentPosition.lat,
      longitude: this.currentPosition.lon,
    };
    const destCfg = this.getDestination();
    const destPt = {
      latitude: Number(destCfg.latitude ?? destCfg.lat),
      longitude: Number(destCfg.longitude ?? destCfg.lon),
    };

    // Ensure all corridor icebergs are in the hazards list passed to A*
    const combinedHazards = [];
    for (const ice of this.corridorIcebergs) {
       combinedHazards.push({
         id: ice.id,
         lat: ice.lat,
         lon: ice.lon,
         areaKm2: ice.areaKm2,
         safetyRadiusKm: this.config.icebergSafetyRadiusKm || 4.0,
       });
    }
    if (isMovingPhase && this.movingIcebergState) {
       // Freeze the moving iceberg to ensure the static A* path is never breached
       this.movingIcebergState.velocityLat = 0;
       this.movingIcebergState.velocityLon = 0;

       combinedHazards.push({
         id: this.movingIcebergState.id,
         lat: this.movingIcebergState.lat,
         lon: this.movingIcebergState.lon,
         areaKm2: this.movingIcebergState.areaKm2,
         // Enforce 8km clearance as requested
         safetyRadiusKm: 8.0,
       });
    }

    const effectiveSafetyRadiusKm = this.config.icebergSafetyRadiusKm || 4.0;

    const rerouteResult = calculateSafeRoute({
      start: currentPt,
      destination: destPt,
      hazards: combinedHazards,
      safetyRadiusKm: effectiveSafetyRadiusKm,
      gridLatStepDeg: this.config.gridLatStepDeg,
      gridLonStepDeg: this.config.gridLonStepDeg,
      corridorPaddingDeg: this.config.corridorPaddingDeg,
    });

    if (!rerouteResult.ok) {
      console.error('[SIM2] 🔴 NO SAFE ROUTE FOUND:', rerouteResult.reason);
      this.status = 'NO SAFE ROUTE FOUND';
      this.statusMessage = '✕ NO SAFE ROUTE FOUND — VESSEL STOPPED SAFELY';
      this._showWarningBanner('✕ NO SAFE ROUTE FOUND — VESSEL STOPPED SAFELY', 'danger');
      this._audio.stop();
      this.sirenActive = false;
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange('NO SAFE ROUTE FOUND', {
          distanceKm: this.distanceToIcebergKm,
          icebergId: this.targetIceberg.id,
          reason: rerouteResult.reason,
        });
      }
      this.stop();
      return;
    }

    // 5. Safe route found! Smooth into curved bypass corridor
    const smoothedReroute = catmullRomSpline(rerouteResult.waypoints, 8);
    let smoothedDistKm = 0;
    for (let i = 0; i < smoothedReroute.length - 1; i++) {
      smoothedDistKm += haversineDistanceKm(
        smoothedReroute[i].lat,
        smoothedReroute[i].lon,
        smoothedReroute[i + 1].lat,
        smoothedReroute[i + 1].lon,
      );
    }

    // Step 3/8: Validate every segment of the smoothed route
    const validationResult = validateSimulationRoute(
      { waypoints: smoothedReroute },
      { hazards: combinedHazards, safetyRadiusKm: effectiveSafetyRadiusKm }
    );

    let finalWaypoints = smoothedReroute;
    let finalDistKm = smoothedDistKm;

    if (!validationResult.valid) {
      console.warn(`[SIM2] ⚠️ ROUTE VALIDATION\n----------------\nIceberg ID: #${this.targetIceberg.id}\nRequired clearance: ${effectiveSafetyRadiusKm.toFixed(2)} km\nRoute collision: TRUE\nSegments checked: ${smoothedReroute.length - 1}\nRoute accepted: FALSE\nSIMULATION 2: ROUTE REJECTED — ICEBERG CLEARANCE VIOLATION (Smoothed route clipped exclusion zone: ${validationResult.reason})`);
      
      // Fallback to raw angular route
      const rawValidation = validateSimulationRoute(
        { waypoints: rerouteResult.waypoints },
        { hazards: combinedHazards, safetyRadiusKm: effectiveSafetyRadiusKm }
      );

      if (!rawValidation.valid) {
         console.error(`[SIM2] 🔴 ROUTE VALIDATION\n----------------\nIceberg ID: #${this.targetIceberg.id}\nRequired clearance: ${effectiveSafetyRadiusKm.toFixed(2)} km\nRoute collision: TRUE\nSegments checked: ${rerouteResult.waypoints.length - 1}\nRoute accepted: FALSE\nSIMULATION 2: ROUTE REJECTED — ICEBERG CLEARANCE VIOLATION (Raw route failed: ${rawValidation.reason})`);
         this.status = 'NO SAFE ROUTE FOUND';
         this.statusMessage = '✕ NO SAFE ROUTE FOUND — VESSEL STOPPED SAFELY';
         this._showWarningBanner('✕ NO SAFE ROUTE FOUND — VESSEL STOPPED SAFELY', 'danger');
         this._audio.stop();
         this.sirenActive = false;
         this.stop();
         return;
      }

      finalWaypoints = rerouteResult.waypoints;
      finalDistKm = rerouteResult.totalDistanceKm;
    }

    // Calculate actual minimum clearance for telemetry
    let minRouteClearance = Infinity;
    for (let i = 0; i < finalWaypoints.length - 1; i++) {
      for (const h of combinedHazards) {
        const d = distPointToSegmentKm(
          h.lat, h.lon,
          finalWaypoints[i].lat, finalWaypoints[i].lon,
          finalWaypoints[i+1].lat, finalWaypoints[i+1].lon
        );
        if (d < minRouteClearance) minRouteClearance = d;
      }
    }

    console.log(`[SIM2] 🟢 ROUTE VALIDATION\n----------------\nIceberg ID: #${this.targetIceberg.id}\nMinimum route clearance: ${minRouteClearance.toFixed(2)} km\nRequired clearance: ${effectiveSafetyRadiusKm.toFixed(2)} km\nRoute collision: FALSE\nSegments checked: ${finalWaypoints.length - 1}\nRoute accepted: TRUE\nSIMULATION 2: SAFE ROUTE ACCEPTED\nMinimum clearance: ${minRouteClearance.toFixed(2)} km`);

    this.isCalculatingReroute = false;
    this.isRerouted = true;
    this.dangerActive = false;
    this.sirenActive = false;
    this.warningActive = false;
    this.activeRoute = {
      ...rerouteResult,
      waypoints: finalWaypoints,
      totalDistanceKm: finalDistKm,
      hazardsAvoidedCount: Math.max(1, rerouteResult.hazardsAvoidedCount || 0),
    };

    // Turn off hazard siren now that the 3-second pause is complete and safe route is ready
    this._audio.stop();

    this.status = 'REROUTED';
    this._showWarningBanner('Safe route established', 'success');

    setTimeout(() => {
        this._removeWarningBanner();
    }, 4500);

    // The moving iceberg will be activated dynamically in _onClockTick
    // once the vessel travels 5km along the new safe route.

    // Update polyline entity without duplicate lines
    if (this._entities.routePolyline) {
      const newPositions = finalWaypoints.map((wp) =>
        Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, 15),
      );
      this._entities.routePolyline.polyline.positions = newPositions;
      this._entities.routePolyline.polyline.material = new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.35,
        color: Cesium.Color.fromCssColorString('#00ff88'),
      });
    }

    // Rebuild sampled positions along new safe route
    this._buildSampledPositions(finalWaypoints);

    // CRITICAL: Re-bind ship entity position property to the new sampled position
    const shipEntity = this._entities.ship || this.viewer?.entities?.getById('simulation2-ship');
    if (shipEntity) {
      shipEntity.position = this.sampledPosition;
    }

    this.currentPosition = {
      lat: finalWaypoints[0].lat,
      lon: finalWaypoints[0].lon,
      headingDeg: this._initialHeadingDeg,
    };

    // 6. Resume forward navigation along the safe route!
    if (this.viewer?.clock && this._startTime && this._stopTime) {
      this.viewer.clock.startTime = this._startTime.clone();
      this.viewer.clock.stopTime = this._stopTime.clone();
      this.viewer.clock.currentTime = this._startTime.clone();
      this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
      this.viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
      this.viewer.clock.multiplier = Number(this.speedMultiplier) || 1;
      this.viewer.clock.shouldAnimate = true;
    }

    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange('RUNNING', {
        distanceKm: this.distanceToIcebergKm,
        icebergId: this.targetIceberg.id,
        rerouted: true,
        message: 'VESSEL ON SAFE BYPASS ROUTE',
      });
    }

    governorRequestRender('simulation-2:rerouted');
  }

  /**
   * Display floating heads-up warning banner on the globe.
   * @private
   */
  _showWarningBanner(text, type = 'caution') {
    if (typeof document === 'undefined') return;

    if (!this._domWarningBanner) {
      this._domWarningBanner = document.createElement('div');
      this._domWarningBanner.id = 'simulation2-warning-banner';
      this._domWarningBanner.className = 'simulation2-warning-banner';

      // Attach to Cesium container or body
      const target = document.getElementById('cesium-container') || document.body;
      target.appendChild(this._domWarningBanner);
    }

    this._domWarningBanner.textContent = text;
    this._domWarningBanner.className = `simulation2-warning-banner simulation2-banner-${type}`;
    this._domWarningBanner.style.display = 'block';
  }

  /**
   * Remove floating heads-up warning banner.
   * @private
   */
  _removeWarningBanner() {
    if (this._domWarningBanner) {
      this._domWarningBanner.style.display = 'none';
    }
  }

  /**
   * Attach clock tick listener.
   * @private
   */
  _attachClockTick() {
    if (this._clockTickRemover || !this.viewer?.clock) return;
    this._clockTickRemover = this.viewer.clock.onTick.addEventListener(this._onClockTick);
  }

  /**
   * Detach clock tick listener.
   * @private
   */
  _detachClockTick() {
    if (this._clockTickRemover) {
      this._clockTickRemover();
      this._clockTickRemover = null;
    }
  }

  /**
   * Clear all Cesium entities associated with Simulation 2.
   * @private
   */
  _clearEntities() {
    if (!this.viewer) return;
    const entities = this.viewer.entities;

    if (this._entities.routePolyline) {
      entities.remove(this._entities.routePolyline);
      this._entities.routePolyline = null;
    }
    const routeById = entities.getById('simulation2-route');
    if (routeById) entities.remove(routeById);

    if (this._entities.ship) {
      entities.remove(this._entities.ship);
      this._entities.ship = null;
    }
    const shipById = entities.getById('simulation2-ship');
    if (shipById) entities.remove(shipById);

    if (this._entities.iceberg) {
      entities.remove(this._entities.iceberg);
      this._entities.iceberg = null;
    }
    const icebergById = entities.getById('simulation2-iceberg');
    if (icebergById) entities.remove(icebergById);

    if (this._entities.icebergBuffer) {
      entities.remove(this._entities.icebergBuffer);
      this._entities.icebergBuffer = null;
    }
    const bufferById = entities.getById('simulation2-iceberg-buffer');
    if (bufferById) entities.remove(bufferById);

    if (this._entities.warningPerimeter) {
      entities.remove(this._entities.warningPerimeter);
      this._entities.warningPerimeter = null;
    }
    const warnById = entities.getById('simulation2-warning-perimeter');
    if (warnById) entities.remove(warnById);

    if (this._entities.sirenPerimeter) {
      entities.remove(this._entities.sirenPerimeter);
      this._entities.sirenPerimeter = null;
    }
    const sirenById = entities.getById('simulation2-siren-perimeter');
    if (sirenById) entities.remove(sirenById);

    if (this._entities.dangerPerimeter) {
      entities.remove(this._entities.dangerPerimeter);
      this._entities.dangerPerimeter = null;
    }
    const dangerById = entities.getById('simulation2-danger-perimeter');
    if (dangerById) entities.remove(dangerById);

    // Clean up all corridor icebergs array & buffers
    if (Array.isArray(this._entities.icebergs)) {
      this._entities.icebergs.forEach((ent) => entities.remove(ent));
      this._entities.icebergs = [];
    }
    if (Array.isArray(this._entities.icebergBuffers)) {
      this._entities.icebergBuffers.forEach((ent) => entities.remove(ent));
      this._entities.icebergBuffers = [];
    }
    if (Array.isArray(this._entities.warningPerimeters)) {
      this._entities.warningPerimeters.forEach((ent) => entities.remove(ent));
      this._entities.warningPerimeters = [];
    }
    if (Array.isArray(this._entities.sirenPerimeters)) {
      this._entities.sirenPerimeters.forEach((ent) => entities.remove(ent));
      this._entities.sirenPerimeters = [];
    }
    if (Array.isArray(this._entities.dangerPerimeters)) {
      this._entities.dangerPerimeters.forEach((ent) => entities.remove(ent));
      this._entities.dangerPerimeters = [];
    }

    // Clean up all fishing hotspots
    if (Array.isArray(this._entities.fishingHotspots)) {
      this._entities.fishingHotspots.forEach((ent) => entities.remove(ent));
      this._entities.fishingHotspots = [];
    }

    // Clean up indexed entities if any
    for (let i = 0; i < 10; i++) {
      const b = entities.getById(`simulation2-iceberg-${i}`);
      if (b) entities.remove(b);
      const bb = entities.getById(`simulation2-iceberg-buffer-${i}`);
      if (bb) entities.remove(bb);
      const hs = entities.getById(`simulation2-hotspot-${i}`);
      if (hs) entities.remove(hs);
    }
    
    if (this._entities.movingIceberg) {
        entities.remove(this._entities.movingIceberg);
        this._entities.movingIceberg = null;
    }
    if (this._entities.movingIcebergBuffer) {
        entities.remove(this._entities.movingIcebergBuffer);
        this._entities.movingIcebergBuffer = null;
    }

    if (this._entities.startPin) {
      entities.remove(this._entities.startPin);
      this._entities.startPin = null;
    }
    const startPinById = entities.getById('simulation2-start-pin');
    if (startPinById) entities.remove(startPinById);

    if (this._entities.destPin) {
      entities.remove(this._entities.destPin);
      this._entities.destPin = null;
    }
    const destPinById = entities.getById('simulation2-dest-pin');
    if (destPinById) entities.remove(destPinById);

    governorRequestRender('simulation-2:clear');
  }

  /**
   * Teardown and destroy all resources.
   */
  destroy() {
    this.stop();
    this._clearEntities();
    this._removeWarningBanner();
    if (this._domWarningBanner) {
      this._domWarningBanner.remove();
      this._domWarningBanner = null;
    }
    this._audio.stop();
    this.active = false;
    this.initialized = false;
    this.viewer = null;
    this.hazards = [];
    this.initialRoute = null;
    this.activeRoute = null;
    this.sampledPosition = null;
    console.info('[Simulation2] Destroyed');
  }
}

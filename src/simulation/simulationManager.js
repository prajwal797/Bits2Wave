/**
 * @file simulationManager.js
 * Central Simulation Manager orchestrating Simulation 1 & 2,
 * enforcing mutual exclusivity, managing centralized state,
 * and binding to the DATA LAYERS panel.
 */

import * as Cesium from 'cesium';
import { SIMULATION_2_CONFIG } from './simulationConfig.js';
import { createSimulationState } from './simulationState.js';
import { Simulation1 } from './simulation1.js';
import { Simulation2 } from './simulation2.js';

export class SimulationManager {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.viewer = options.viewer || null;
    this.dataManager = options.dataManager || null;
    this.state = createSimulationState();

    this.sim1 = new Simulation1({ viewer: this.viewer });
    this.sim2 = new Simulation2({ viewer: this.viewer });

    this.traveledKm = 0;
    this.totalKm = 0;
    this.progressPct = 0;

    this._dom = {
      container: null,
      row: null,
      toggleBtn: null,
      countBadge: null,
      metaText: null,
      controlsContainer: null,
      chipSim1: null,
      chipSim2: null,
      controlArea: null,
      statusReadout: null,
      btnStart: null,
      btnPause: null,
      btnResume: null,
      btnReset: null,
      speedChips: [],
      sim2CorridorRow: null,
      sim2PresetSelect: null,
      btnPickCorridor: null,
    };

    this._pickHandler = null;
    this._unsubscribeState = null;
    this.initialized = false;
  }

  /**
   * Initialize the Simulation Manager and attach to the UI container.
   * @param {object} params
   * @param {import('cesium').Viewer} [params.viewer]
   * @param {object} [params.dataManager]
   * @param {HTMLElement} [params.container] The #data-toggles container
   */
  initialize({ viewer, dataManager, container } = {}) {
    if (viewer) this.viewer = viewer;
    if (dataManager) this.dataManager = dataManager;

    this.sim1.initialize(this.viewer);
    this.sim2.initialize(this.viewer);

    // Bind real-time callbacks from Simulation 1
    this.sim1.onProgress = (pos, traveledKm, totalKm) => {
      this.traveledKm = traveledKm;
      this.totalKm = totalKm;
      const rawPct = totalKm > 0 ? (traveledKm / totalKm) * 100 : 0;
      this.progressPct = rawPct >= 10 || rawPct === 0 ? Math.round(rawPct) : rawPct.toFixed(1);
      this._syncUI(this.state.get());
      if (typeof window !== 'undefined' && typeof window.__updateLiveVoyageTelemetry === 'function') {
        window.__updateLiveVoyageTelemetry(pos);
      }
    };

    this.sim1.onStatusChange = (status) => {
      if (status === 'RUNNING') {
        this.state.update({ simulationRunning: true, simulationPaused: false });
      } else if (status === 'PAUSED') {
        this.state.update({ simulationRunning: true, simulationPaused: true });
      } else if (status === 'COMPLETED') {
        this.state.update({ simulationRunning: false, simulationPaused: false });
      } else if (status === 'READY') {
        this.traveledKm = 0;
        this.progressPct = 0;
        this.state.update({ simulationRunning: false, simulationPaused: false });
      } else if (status === 'NO SAFE ROUTE FOUND' || status === 'CALCULATING ROUTE...') {
        this.traveledKm = 0;
        this.progressPct = 0;
        this.state.update({ simulationRunning: false, simulationPaused: false });
      }
    };

    // Bind real-time callbacks from Simulation 2
    this.sim2.onProgress = (pos, traveledKm, totalKm, distToIcebergKm) => {
      this.traveledKm = traveledKm;
      this.totalKm = totalKm;
      const rawPct = totalKm > 0 ? (traveledKm / totalKm) * 100 : 0;
      this.progressPct = rawPct >= 10 || rawPct === 0 ? Math.round(rawPct) : rawPct.toFixed(1);
      this._syncUI(this.state.get());
      if (typeof window !== 'undefined' && typeof window.__updateLiveVoyageTelemetry === 'function') {
        window.__updateLiveVoyageTelemetry(pos);
      }
    };

    this.sim2.onStatusChange = (status) => {
      if (status === 'RUNNING' || status === 'CAUTION' || status === 'DANGER' || status === 'REROUTED') {
        this.state.update({ simulationRunning: true, simulationPaused: false });
      } else if (status === 'PAUSED') {
        this.state.update({ simulationRunning: true, simulationPaused: true });
      } else if (status === 'COMPLETED') {
        this.state.update({ simulationRunning: false, simulationPaused: false });
      } else if (status === 'READY') {
        this.traveledKm = 0;
        this.progressPct = 0;
        this.state.update({ simulationRunning: false, simulationPaused: false });
      } else if (status === 'NO SAFE ROUTE FOUND') {
        this.state.update({ simulationRunning: false, simulationPaused: false });
      }
      this._syncUI(this.state.get());
    };

    this._unsubscribeState = this.state.subscribe((newState, prev) => {
      this._syncUI(newState, prev);
    });

    if (container) {
      this.mount(container);
    }

    if (typeof window !== 'undefined') {
      window.rebuildSimulation1Scenario = (start, dest) => this.rebuildSimulation1Scenario(start, dest);
      window.rebuildSimulation2Scenario = (start, dest) => this.rebuildSimulation2Scenario(start, dest);
    }

    this.initialized = true;
    console.info('[SimulationManager] Initialized successfully');
    return this;
  }

  /**
   * Rebuild Simulation 1 scenario dynamically with new start and destination coordinates.
   * @param {object} start
   * @param {object} destination
   * @returns {Promise<object>}
   */
  async rebuildSimulation1Scenario(start, destination) {
    if (!this.state.get().enabled) {
      this.enable();
    }
    if (this.state.get().activeSimulation !== 'sim-1') {
      this.state.update({ activeSimulation: 'sim-1' });
      this.sim2.deactivate();
      this.sim1.active = true;
    }

    const res = await this.sim1.rebuildScenario(start, destination);
    if (res && res.ok && this.sim1.route) {
      this.totalKm = this.sim1.route.totalDistanceKm;
      this.traveledKm = 0;
      this.progressPct = 0;
      this.state.update({
        simulationRunning: false,
        simulationPaused: false,
      });
      this._syncUI(this.state.get());
    }
    return res;
  }

  /**
   * Rebuild Simulation 2 scenario dynamically with new start and destination coordinates.
   * @param {object} start
   * @param {object} destination
   * @returns {Promise<object>}
   */
  async rebuildSimulation2Scenario(start, destination) {
    if (!this.state.get().enabled) {
      this.enable();
    }
    if (this.state.get().activeSimulation !== 'sim-2') {
      this.state.update({ activeSimulation: 'sim-2' });
      this.sim1.deactivate();
      this.sim2.active = true;
    }

    const res = await this.sim2.rebuildScenario(start, destination);
    if (res && res.ok && this.sim2.activeRoute) {
      this.totalKm = this.sim2.activeRoute.totalDistanceKm;
      this.traveledKm = 0;
      this.progressPct = 0;
      this.state.update({
        simulationRunning: false,
        simulationPaused: false,
      });
      this._syncUI(this.state.get());
    }
    return res;
  }

  /**
   * Interactive globe coordinate picker for custom Simulation 2 departure and destination.
   * @private
   */
  _startGlobePicking() {
    if (!this.viewer || typeof window === 'undefined') return;

    if (this._pickHandler) {
      this._pickHandler.destroy();
      this._pickHandler = null;
    }

    const canvas = this.viewer.scene?.canvas;
    if (!canvas) return;

    this._pickHandler = new Cesium.ScreenSpaceEventHandler(canvas);
    let stage = 0;
    let pickedStart = null;

    if (this._dom.btnPickCorridor) {
      this._dom.btnPickCorridor.textContent = '📍 CLICK START ON GLOBE...';
      this._dom.btnPickCorridor.classList.add('active');
    }

    this._pickHandler.setInputAction(async (click) => {
      const ray = this.viewer.camera.getPickRay(click.position);
      let position = this.viewer.scene.globe.pick(ray, this.viewer.scene);
      if (!position) {
        position = this.viewer.camera.pickEllipsoid(click.position, this.viewer.scene.globe.ellipsoid);
      }
      if (!position) return;

      const cartographic = Cesium.Cartographic.fromCartesian(position);
      const lat = Cesium.Math.toDegrees(cartographic.latitude);
      const lon = Cesium.Math.toDegrees(cartographic.longitude);

      if (stage === 0) {
        pickedStart = {
          lat,
          lon,
          name: `Custom Departure (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`,
        };
        stage = 1;
        if (this._dom.btnPickCorridor) {
          this._dom.btnPickCorridor.textContent = '🏁 CLICK DEST ON GLOBE...';
        }
      } else {
        const pickedDest = {
          lat,
          lon,
          name: `Custom Destination (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`,
        };

        if (this._pickHandler) {
          this._pickHandler.destroy();
          this._pickHandler = null;
        }

        if (this._dom.btnPickCorridor) {
          this._dom.btnPickCorridor.textContent = '📍 PICK ON GLOBE';
          this._dom.btnPickCorridor.classList.remove('active');
        }

        await this.rebuildSimulation2Scenario(pickedStart, pickedDest);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  /**
   * Enable the Simulation feature layer.
   */
  enable() {
    this.state.update({ enabled: true });
    return this;
  }

  /**
   * Disable the Simulation feature, stopping and clearing active simulations.
   */
  disable() {
    this.sim1.deactivate();
    this.sim2.deactivate();
    this.traveledKm = 0;
    this.progressPct = 0;
    this.state.update({
      enabled: false,
      activeSimulation: null,
      simulationRunning: false,
      simulationPaused: false,
    });
    return this;
  }

  /**
   * Select and activate Simulation 1 (mutually exclusive with Simulation 2).
   */
  async enableSimulation1() {
    if (!this.state.get().enabled) {
      this.enable();
    }
    this.sim2.deactivate();
    this.state.update({
      activeSimulation: 'sim-1',
      simulationRunning: false,
      simulationPaused: false,
    });
    await this.sim1.activate();
    if (this.sim1.route?.totalDistanceKm) {
      this.totalKm = this.sim1.route.totalDistanceKm;
    }
    this._syncUI(this.state.get());
    return this;
  }

  /**
   * Select and activate Simulation 2 (mutually exclusive with Simulation 1).
   */
  async enableSimulation2() {
    if (!this.state.get().enabled) {
      this.enable();
    }
    this.sim1.deactivate();
    this.state.update({
      activeSimulation: 'sim-2',
      simulationRunning: false,
      simulationPaused: false,
    });
    await this.sim2.activate();
    if (this.sim2.activeRoute?.totalDistanceKm) {
      this.totalKm = this.sim2.activeRoute.totalDistanceKm;
    }
    this._syncUI(this.state.get());
    return this;
  }

  /**
   * Deactivate currently active simulation and return to standby.
   */
  deactivateSimulation() {
    this.sim1.deactivate();
    this.sim2.deactivate();
    this.traveledKm = 0;
    this.progressPct = 0;
    this.state.update({
      activeSimulation: null,
      simulationRunning: false,
      simulationPaused: false,
    });
    return this;
  }

  /**
   * Get the active simulation identifier ('sim-1', 'sim-2', or null).
   * @returns {'sim-1' | 'sim-2' | null}
   */
  getActiveSimulation() {
    return this.state.get().activeSimulation;
  }

  /**
   * Start execution for the currently active simulation.
   */
  async start() {
    const { activeSimulation, enabled } = this.state.get();
    if (!enabled || !activeSimulation) return;

    if (activeSimulation === 'sim-1') {
      await this.sim1.start();
    } else if (activeSimulation === 'sim-2') {
      this.sim2.start();
      this.state.update({ simulationRunning: true, simulationPaused: false });
    }
  }

  /**
   * Pause the currently active simulation.
   */
  pause() {
    const { activeSimulation, simulationRunning } = this.state.get();
    if (!simulationRunning) return;

    if (activeSimulation === 'sim-1') {
      this.sim1.pause();
    } else if (activeSimulation === 'sim-2') {
      this.sim2.pause();
      this.state.update({ simulationPaused: true });
    }
  }

  /**
   * Resume the currently active simulation.
   */
  resume() {
    const { activeSimulation, simulationRunning, simulationPaused } = this.state.get();
    if (!simulationRunning || !simulationPaused) return;

    if (activeSimulation === 'sim-1') {
      this.sim1.resume();
    } else if (activeSimulation === 'sim-2') {
      this.sim2.resume();
      this.state.update({ simulationPaused: false });
    }
  }

  /**
   * Reset the simulation back to initial state.
   */
  reset() {
    const { activeSimulation } = this.state.get();
    if (activeSimulation === 'sim-1') {
      this.sim1.reset();
    } else if (activeSimulation === 'sim-2') {
      this.sim2.reset();
    }

    this.traveledKm = 0;
    this.progressPct = 0;
    this.state.update({
      simulationRunning: false,
      simulationPaused: false,
    });
    this._syncUI(this.state.get());
  }

  /**
   * Set the simulation playback speed multiplier.
   * @param {number} speed
   */
  setSpeed(speed) {
    const spd = Number(speed) || 1;
    this.state.update({ simulationSpeed: spd });
    this.sim1.setSpeed(spd);
    if (typeof this.sim2?.setSpeed === 'function') {
      this.sim2.setSpeed(spd);
    }
  }

  /**
   * Mount the simulation row into the DATA LAYERS panel (#data-toggles).
   * @param {HTMLElement} container
   */
  mount(container) {
    if (!container) return;
    this._dom.container = container;

    // Check if an existing row exists to avoid duplicates
    const existing = container.querySelector('[data-layer-id="simulation"]');
    if (existing) existing.remove();

    const row = document.createElement('div');
    row.className = 'data-toggle-row simulation-toggle-row';
    row.dataset.layerId = 'simulation';

    // Top row
    const topRow = document.createElement('div');
    topRow.className = 'data-toggle-top';

    const left = document.createElement('div');
    left.className = 'data-toggle-left';
    left.innerHTML = '<span class="data-icon">🧭</span><span class="data-name">Simulation</span>';

    const right = document.createElement('div');
    right.className = 'data-toggle-right';

    const count = document.createElement('span');
    count.className = 'data-count simulation-status-count';
    count.textContent = '—';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'data-toggle-btn';
    toggle.textContent = 'OFF';
    toggle.setAttribute('aria-label', 'Toggle Simulation layer');
    toggle.addEventListener('click', () => {
      if (this.state.get().enabled) {
        this.disable();
      } else {
        this.enable();
      }
    });

    right.appendChild(count);
    right.appendChild(toggle);
    topRow.appendChild(left);
    topRow.appendChild(right);

    // Meta text row
    const meta = document.createElement('div');
    meta.className = 'data-toggle-meta';
    meta.textContent = 'Maritime Route & Proximity Simulation';

    // Sub-controls container
    const controls = document.createElement('div');
    controls.className = 'data-toggle-controls simulation-toggle-controls';
    controls.hidden = true;

    // Mode chips container
    const chipsWrapper = document.createElement('div');
    chipsWrapper.className = 'simulation-chips-wrapper';

    const chip1 = document.createElement('button');
    chip1.type = 'button';
    chip1.className = 'data-toggle-chip simulation-chip';
    chip1.dataset.simId = 'sim-1';
    chip1.textContent = 'SIMULATION 1';
    chip1.title = 'Simulation 1: Safe Route Navigation';
    chip1.addEventListener('click', () => {
      const current = this.getActiveSimulation();
      if (current === 'sim-1') {
        this.deactivateSimulation();
      } else {
        this.enableSimulation1();
      }
    });

    const chip2 = document.createElement('button');
    chip2.type = 'button';
    chip2.className = 'data-toggle-chip simulation-chip';
    chip2.dataset.simId = 'sim-2';
    chip2.textContent = 'SIMULATION 2';
    chip2.title = 'Simulation 2: Iceberg Proximity Warning';
    chip2.addEventListener('click', () => {
      const current = this.getActiveSimulation();
      if (current === 'sim-2') {
        this.deactivateSimulation();
      } else {
        this.enableSimulation2();
      }
    });

    chipsWrapper.appendChild(chip1);
    chipsWrapper.appendChild(chip2);
    controls.appendChild(chipsWrapper);

    // Simulation Control Area
    const controlArea = document.createElement('div');
    controlArea.className = 'simulation-control-area';

    const statusReadout = document.createElement('div');
    statusReadout.className = 'simulation-status-readout';
    statusReadout.textContent = 'SELECT SIMULATION 1 OR 2';

    const transportRow = document.createElement('div');
    transportRow.className = 'simulation-transport-row';

    const btnStart = document.createElement('button');
    btnStart.type = 'button';
    btnStart.className = 'simulation-btn simulation-btn-start';
    btnStart.textContent = '▶ START';
    btnStart.title = 'Start vessel movement along calculated safe route';
    btnStart.addEventListener('click', () => this.start());

    const btnPause = document.createElement('button');
    btnPause.type = 'button';
    btnPause.className = 'simulation-btn simulation-btn-pause';
    btnPause.textContent = '⏸ PAUSE';
    btnPause.title = 'Pause vessel movement at current position';
    btnPause.addEventListener('click', () => this.pause());

    const btnResume = document.createElement('button');
    btnResume.type = 'button';
    btnResume.className = 'simulation-btn simulation-btn-resume';
    btnResume.textContent = '⏯ RESUME';
    btnResume.title = 'Resume vessel movement';
    btnResume.addEventListener('click', () => this.resume());

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'simulation-btn simulation-btn-reset';
    btnReset.textContent = '↺ RESET';
    btnReset.title = 'Reset vessel back to start point';
    btnReset.addEventListener('click', () => this.reset());

    transportRow.append(btnStart, btnPause, btnResume, btnReset);

    // Simulation 2 Route Corridor Presets and Map Picker Row
    const sim2CorridorRow = document.createElement('div');
    sim2CorridorRow.className = 'simulation-corridor-row';
    sim2CorridorRow.hidden = true;
    if (sim2CorridorRow.style) {
      sim2CorridorRow.style.display = 'none';
    }

    const corridorLabel = document.createElement('span');
    corridorLabel.className = 'simulation-corridor-label';
    corridorLabel.textContent = 'CORRIDOR:';
    sim2CorridorRow.appendChild(corridorLabel);

    const presetSelect = document.createElement('select');
    presetSelect.className = 'simulation-preset-select';
    presetSelect.title = 'Select route corridor preset';
    const presets = SIMULATION_2_CONFIG.presets || [];
    presets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    });

    presetSelect.addEventListener('change', async (e) => {
      const val = e.target.value;
      const found = presets.find((p) => p.id === val);
      if (found) {
        await this.rebuildSimulation2Scenario(found.start, found.destination);
      }
    });
    sim2CorridorRow.appendChild(presetSelect);

    const btnPickCorridor = document.createElement('button');
    btnPickCorridor.type = 'button';
    btnPickCorridor.className = 'data-toggle-chip simulation-pick-chip';
    btnPickCorridor.textContent = '📍 PICK ON GLOBE';
    btnPickCorridor.title = 'Click two locations on the globe to set custom departure & destination';
    btnPickCorridor.addEventListener('click', () => this._startGlobePicking());
    sim2CorridorRow.appendChild(btnPickCorridor);

    // Speed options row
    const speedRow = document.createElement('div');
    speedRow.className = 'simulation-speed-row';

    const speedLabel = document.createElement('span');
    speedLabel.className = 'simulation-speed-label';
    speedLabel.textContent = 'SPEED:';
    speedRow.appendChild(speedLabel);

    const speeds = [1, 2, 4];
    const speedChips = [];
    for (const spd of speeds) {
      const spdChip = document.createElement('button');
      spdChip.type = 'button';
      spdChip.className = `data-toggle-chip simulation-speed-chip${spd === 1 ? ' active' : ''}`;
      spdChip.dataset.speed = String(spd);
      spdChip.textContent = `${spd}X`;
      spdChip.title = `Set simulation playback speed to ${spd}x`;
      spdChip.addEventListener('click', () => this.setSpeed(spd));
      speedRow.appendChild(spdChip);
      speedChips.push({ speed: spd, element: spdChip });
    }

    controlArea.append(statusReadout, transportRow, sim2CorridorRow, speedRow);
    controls.appendChild(controlArea);

    row.appendChild(topRow);
    row.appendChild(meta);
    row.appendChild(controls);

    container.appendChild(row);

    this._dom = {
      container,
      row,
      toggleBtn: toggle,
      countBadge: count,
      metaText: meta,
      controlsContainer: controls,
      chipSim1: chip1,
      chipSim2: chip2,
      controlArea,
      statusReadout,
      btnStart,
      btnPause,
      btnResume,
      btnReset,
      speedChips,
      sim2CorridorRow,
      sim2PresetSelect: presetSelect,
      btnPickCorridor,
    };

    // Initial render sync
    this._syncUI(this.state.get());
  }

  /**
   * Synchronize DOM representation with state snapshot.
   * @private
   */
  _syncUI(state) {
    const {
      toggleBtn,
      countBadge,
      metaText,
      controlsContainer,
      chipSim1,
      chipSim2,
      statusReadout,
      btnStart,
      btnPause,
      btnResume,
      btnReset,
      speedChips,
    } = this._dom;

    if (!toggleBtn) return;

    // Main Toggle Button & Container Visibility
    if (state.enabled) {
      toggleBtn.className = 'data-toggle-btn active';
      toggleBtn.textContent = 'ON';
      controlsContainer.hidden = false;
    } else {
      toggleBtn.className = 'data-toggle-btn';
      toggleBtn.textContent = 'OFF';
      controlsContainer.hidden = true;
    }

    // Sub-Simulation Chips Active State
    if (chipSim1) {
      const isSim1 = state.activeSimulation === 'sim-1';
      chipSim1.className = `data-toggle-chip simulation-chip${isSim1 ? ' active' : ''}`;
      chipSim1.setAttribute('aria-pressed', isSim1 ? 'true' : 'false');
    }

    if (chipSim2) {
      const isSim2 = state.activeSimulation === 'sim-2';
      chipSim2.className = `data-toggle-chip simulation-chip${isSim2 ? ' active' : ''}`;
      chipSim2.setAttribute('aria-pressed', isSim2 ? 'true' : 'false');
    }

    // Derived states
    const hasActiveSim = Boolean(state.enabled && state.activeSimulation);
    const isSim1 = state.activeSimulation === 'sim-1';
    const isSim2 = state.activeSimulation === 'sim-2';
    const isRunning = Boolean(state.simulationRunning && !state.simulationPaused);
    const isPaused = Boolean(state.simulationRunning && state.simulationPaused);
    const isCompleted = isSim1 ? Boolean(this.sim1.completed) : isSim2 ? Boolean(this.sim2.completed) : false;
    const isSim1Safe = Boolean(this.sim1.route && this.sim1.route.ok);
    const isSim1Calculating = Boolean(this.sim1.isCalculating);
    const isSim1NoSafeRoute = Boolean(this.sim1.status === 'NO SAFE ROUTE FOUND' || (!isSim1Safe && !isSim1Calculating));

    // Status label resolution
    let runStatus = 'READY';
    if (isSim1) {
      if (isCompleted) runStatus = 'COMPLETED';
      else if (isRunning) runStatus = 'RUNNING';
      else if (isPaused) runStatus = 'PAUSED';
      else if (isSim1Calculating) runStatus = 'CALCULATING ROUTE...';
      else if (isSim1NoSafeRoute) runStatus = 'NO SAFE ROUTE FOUND';
    } else if (isSim2) {
      if (this.sim2.completed) runStatus = 'COMPLETED';
      else if (this.sim2.status === 'REROUTED') runStatus = 'REROUTED';
      else if (this.sim2.dangerActive || this.sim2.status === 'DANGER') runStatus = 'DANGER (8 KM)';
      else if (this.sim2.sirenActive || this.sim2.status === 'ALERT') runStatus = 'SIREN (10 KM)';
      else if (this.sim2.warningActive || this.sim2.status === 'CAUTION') runStatus = 'CAUTION (12 KM)';
      else if (this.sim2.status === 'NO SAFE ROUTE FOUND') runStatus = 'NO SAFE ROUTE FOUND';
      else if (isRunning) runStatus = 'RUNNING';
      else if (isPaused) runStatus = 'PAUSED';
      else runStatus = 'READY';
    }

    // Badge & Readout Text Sync
    if (!state.enabled) {
      countBadge.textContent = '—';
      metaText.textContent = 'Maritime Route & Proximity Simulation';
      if (statusReadout) statusReadout.textContent = 'SIMULATION DISABLED';
    } else if (!state.activeSimulation) {
      countBadge.textContent = 'STANDBY';
      metaText.textContent = 'Simulation Enabled · Select Simulation 1 or 2';
      if (statusReadout) statusReadout.textContent = 'SELECT SIMULATION 1 OR 2';
    } else if (isSim1) {
      countBadge.textContent = 'SIM 1';
      if (isSim1Calculating) {
        metaText.textContent = 'Simulation 1: Safe Route Navigation · CALCULATING ROUTE...';
        if (statusReadout) statusReadout.textContent = 'SIM 1: CALCULATING ROUTE...';
      } else if (isSim1NoSafeRoute) {
        metaText.textContent = 'Simulation 1: Safe Route Navigation · NO SAFE ROUTE FOUND';
        if (statusReadout) {
          const reason = this.sim1.statusReason ? ` (${this.sim1.statusReason})` : '';
          statusReadout.textContent = `SIM 1: NO SAFE ROUTE FOUND${reason} | START DISABLED`;
        }
      } else {
        metaText.textContent = `Simulation 1: Safe Route Navigation · ${runStatus}`;
        if (statusReadout) {
          const total = this.totalKm || this.sim1.route?.totalDistanceKm || 0;
          const curDistFormatted = this.traveledKm < 10 ? this.traveledKm.toFixed(2) : this.traveledKm.toFixed(1);
          const distStr = total > 0 ? `${curDistFormatted} / ${total.toFixed(1)} km` : '0.0 km';
          const wpCount = this.sim1.route?.waypoints?.length || 0;
          const avoided = this.sim1.route?.hazardsAvoidedCount ?? 0;
          statusReadout.textContent = `SIM 1: ${runStatus} | DIST: ${distStr} | WP: ${wpCount} | BASE: 15 kts | AVOIDED: ${avoided} | SPEED: ${state.simulationSpeed}X`;
        }
      }
    } else if (isSim2) {
      countBadge.textContent = 'SIM 2';
      const iceId = this.sim2.targetIceberg?.id || 620;
      const dKm = this.sim2.distanceToIcebergKm != null ? `${this.sim2.distanceToIcebergKm.toFixed(2)} km` : '—';
      const iceCount = this.sim2.corridorIcebergs?.length || (this.sim2.targetIceberg ? 1 : 0);
      const hsCount = this.sim2.fishingHotspots?.length || 0;
      let extraMsg = '';
      if (this.sim2.status === 'NO SAFE ROUTE FOUND') {
        extraMsg = ' | ✕ NO SAFE ROUTE FOUND';
      } else if (this.sim2.status === 'REROUTED') {
        extraMsg = ' | ✓ SAFE ROUTE FOUND — CHANGING COURSE';
      } else if (this.sim2.dangerActive || this.sim2.isCalculatingReroute) {
        extraMsg = ' | 🔄 REROUTING AT 8 KM (3s PAUSE)...';
      } else if (this.sim2.sirenActive) {
        extraMsg = ' | 🚨 HAZARD SIREN ACTIVE (10 KM)';
      } else if (this.sim2.warningActive) {
        extraMsg = ' | ⚠ 12 KM: YOU ARE VERY CLOSE TO THE ICEBERG PLEASE CHANGE THE ROUTE';
      }

      metaText.textContent = `Simulation 2: Iceberg Proximity Warning · ${runStatus} · Iceberg #${iceId}`;
      if (statusReadout) {
        statusReadout.textContent = `SIM 2: ${runStatus} | 🧊 ${iceCount} BERGS | 🎣 ${hsCount} FISHING | DIST: ${dKm}${extraMsg} | SPEED: ${state.simulationSpeed}X`;
      }
    }

    // Toggle Simulation 2 Corridor Row visibility
    if (this._dom.sim2CorridorRow) {
      this._dom.sim2CorridorRow.hidden = !isSim2;
      if (this._dom.sim2CorridorRow.style) {
        this._dom.sim2CorridorRow.style.display = isSim2 ? 'flex' : 'none';
      }
    }

    // Precise Transport Buttons State Matrix
    if (btnStart) {
      btnStart.disabled =
        !hasActiveSim ||
        isRunning ||
        isPaused ||
        isCompleted ||
        (isSim1 && (!isSim1Safe || isSim1NoSafeRoute || isSim1Calculating)) ||
        (isSim2 && (this.sim2.completed || this.sim2.status === 'NO SAFE ROUTE FOUND'));
    }
    if (btnPause) {
      btnPause.disabled = !hasActiveSim || !isRunning;
    }
    if (btnResume) {
      btnResume.disabled = !hasActiveSim || !isPaused;
    }
    if (btnReset) {
      btnReset.disabled = !hasActiveSim;
    }

    // Speed Chips Active State
    if (speedChips) {
      for (const item of speedChips) {
        if (item.speed === state.simulationSpeed) {
          item.element.className = 'data-toggle-chip simulation-speed-chip active';
        } else {
          item.element.className = 'data-toggle-chip simulation-speed-chip';
        }
      }
    }
  }

  /**
   * Cleanup and teardown.
   */
  destroy() {
    if (this._unsubscribeState) {
      this._unsubscribeState();
      this._unsubscribeState = null;
    }
    if (this._pickHandler) {
      this._pickHandler.destroy();
      this._pickHandler = null;
    }
    this.sim1.destroy();
    this.sim2.destroy();
    if (this._dom.row) {
      this._dom.row.remove();
    }
    this.initialized = false;
  }
}

/**
 * Singleton instance of SimulationManager.
 */
export const simulationManager = new SimulationManager();

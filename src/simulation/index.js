/**
 * @file index.js
 * Public API for the God's Eye View Simulation subsystem.
 */

import { simulationManager, SimulationManager } from './simulationManager.js';
import { Simulation1 } from './simulation1.js';
import { Simulation2 } from './simulation2.js';
import { createSimulationState, INITIAL_SIMULATION_STATE } from './simulationState.js';

/**
 * Initialize the simulation subsystem and mount into the Data Layers panel.
 * @param {object} options
 * @param {import('cesium').Viewer} [options.viewer]
 * @param {object} [options.dataManager]
 * @param {HTMLElement} [options.container]
 * @returns {SimulationManager}
 */
export function initSimulation({ viewer, dataManager, container } = {}) {
  const targetContainer = container || document.getElementById('data-toggles');
  const mgr = simulationManager.initialize({
    viewer,
    dataManager,
    container: targetContainer,
  });
  if (typeof window !== 'undefined') {
    window.__gevSimulationManager = mgr;
  }
  return mgr;
}

export {
  simulationManager,
  SimulationManager,
  Simulation1,
  Simulation2,
  createSimulationState,
  INITIAL_SIMULATION_STATE,
};

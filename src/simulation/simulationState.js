/**
 * @file simulationState.js
 * Centralized simulation state store with reactive subscriptions.
 */

export const INITIAL_SIMULATION_STATE = Object.freeze({
  enabled: false,
  activeSimulation: null, // null | 'sim-1' | 'sim-2'
  simulationRunning: false,
  simulationPaused: false,
  simulationSpeed: 1, // 1x, 2x, 4x, etc.
});

/**
 * Factory for a centralized, observable simulation state store.
 * @param {Partial<typeof INITIAL_SIMULATION_STATE>} [initial]
 * @returns {object}
 */
export function createSimulationState(initial = {}) {
  let _state = {
    ...INITIAL_SIMULATION_STATE,
    ...initial,
  };
  const _listeners = new Set();

  return {
    /**
     * Get a snapshot copy of the current state.
     */
    get() {
      return { ..._state };
    },

    /**
     * Update state properties and notify subscribers.
     * @param {Partial<typeof INITIAL_SIMULATION_STATE>} patch
     * @returns {object} Updated state snapshot
     */
    update(patch) {
      const prev = _state;
      _state = { ..._state, ...patch };
      for (const listener of _listeners) {
        try {
          listener(_state, prev);
        } catch (err) {
          console.error('[SimulationState] Listener notification error:', err);
        }
      }
      return { ..._state };
    },

    /**
     * Subscribe to state mutations.
     * @param {(state: object, prev: object) => void} listener
     * @returns {() => void} Unsubscribe callback
     */
    subscribe(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },

    /**
     * Reset runtime playback state while preserving or specifying enabled flag.
     * @param {boolean} [retainEnabled=false]
     */
    reset(retainEnabled = false) {
      return this.update({
        enabled: retainEnabled ? _state.enabled : false,
        activeSimulation: null,
        simulationRunning: false,
        simulationPaused: false,
        simulationSpeed: 1,
      });
    },
  };
}

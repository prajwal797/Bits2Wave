<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { initRoutePlanner } from '../../../routePlanner.js';
import { t } from '../../../i18n/index.js';

const isPlacingPins = ref(false);
const statusBadge = ref('READY');

const presets = [
  { id: 'scott', name: 'Scott Base', label: 'SCOTT BASE' },
  { id: 'mcmurdo', name: 'McMurdo Station', label: 'MCMURDO' },
  { id: 'casey', name: 'Casey Station', label: 'CASEY' },
  { id: 'hobart', name: 'Hobart', label: 'HOBART' },
  { id: 'punta', name: 'Punta Arenas', label: 'PUNTA ARENAS' },
  { id: 'christchurch', name: 'Christchurch', label: 'CHRISTCHURCH' },
  { id: 'sydney', name: 'Sydney', label: 'SYDNEY' },
  { id: 'davis', name: 'Davis Station', label: 'DAVIS' },
  { id: 'rothera', name: 'Rothera Station', label: 'ROTHERA' },
];

let observer = null;
let retryTimer = null;

function connectPlanner() {
  const viewer = window.__cryonis?.viewer || window.viewer;
  const planner = window.__cryonis?.routePlanner || window.routePlanner;

  if (viewer || planner) {
    initRoutePlanner({ viewer, planner });

    const placeBtn = document.getElementById('route-place-pins-btn');
    if (placeBtn && !observer) {
      observer = new MutationObserver(() => {
        const active = placeBtn.classList.contains('active');
        isPlacingPins.value = active;
        if (active) {
          statusBadge.value = placeBtn.textContent.includes('Final')
            ? t('CLICK GLOBE (DEST)')
            : t('CLICK GLOBE (START)');
        } else {
          statusBadge.value = t('READY');
        }
      });
      observer.observe(placeBtn, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    return true;
  }
  return false;
}

onMounted(() => {
  if (!connectPlanner()) {
    retryTimer = setInterval(() => {
      if (connectPlanner()) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 250);
    setTimeout(() => {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 6000);
  }
});

onUnmounted(() => {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
});
</script>

<template>
  <div id="route-planner-container" class="route-planner-container" aria-label="Maritime Route Planner">
    <!-- Header -->
    <div class="route-planner-header">
      <div class="route-planner-title-row">
        <span class="route-planner-icon" aria-hidden="true">🧭</span>
        <span class="route-planner-title">{{ t('MARITIME ROUTE PLANNER') }}</span>
      </div>
      <span class="route-planner-badge" :class="{ active: isPlacingPins }">
        {{ statusBadge }}
      </span>
    </div>

    <!-- Location Search & Quick Presets -->
    <div class="route-search-section">
      <div class="route-search-input-wrap">
        <span class="route-search-icon" aria-hidden="true">🔍</span>
        <input
          type="text"
          id="route-location-search"
          class="route-search-input"
          :placeholder="t('Search Antarctic station or port (e.g. McMurdo, Hobart)...')"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="route-preset-pills" role="group" :aria-label="t('Antarctic route presets')">
        <button
          v-for="preset in presets"
          :key="preset.id"
          type="button"
          class="route-preset-pill"
          :data-location="preset.name"
        >
          {{ preset.label }}
        </button>
      </div>
    </div>

    <!-- Inputs Row (Start & Destination Coordinates) -->
    <div class="route-planner-row">
      <div class="route-field-wrap">
        <label class="route-field-label" for="route-initial-location">
          <span class="pin-indicator pin-start" aria-hidden="true">●</span> {{ t('START LOCATION (CYAN PIN)') }}
        </label>
        <input
          type="text"
          id="route-initial-location"
          class="route-input"
          :placeholder="t('Click Place Pins or type station...')"
          autocomplete="off"
          spellcheck="false"
          :aria-label="t('Start Pin Location')"
        />
        <div id="route-initial-autocomplete" class="route-autocomplete-list" hidden></div>
      </div>
      <div class="route-field-wrap">
        <label class="route-field-label" for="route-final-location">
          <span class="pin-indicator pin-dest" aria-hidden="true">●</span> {{ t('DESTINATION (MAGENTA PIN)') }}
        </label>
        <input
          type="text"
          id="route-final-location"
          class="route-input"
          :placeholder="t('Click Place Pins or type destination...')"
          autocomplete="off"
          spellcheck="false"
          :aria-label="t('Destination Pin Location')"
        />
        <div id="route-final-autocomplete" class="route-autocomplete-list" hidden></div>
      </div>
    </div>

    <!-- Action Buttons Bar -->
    <div class="route-planner-actions">
      <button
        id="route-place-pins-btn"
        type="button"
        class="route-btn route-btn-pins"
        :class="{ active: isPlacingPins }"
        :title="t('Click globe to place Start (Cyan) and Destination (Magenta) pins')"
      >
        📍 {{ t('PLACE PINS') }}
      </button>
      <button
        id="route-calculate-btn"
        type="button"
        class="route-btn route-btn-calc"
        :title="t('Calculate maritime optimal route')"
      >
        {{ t('CALCULATE ROUTE') }}
      </button>
      <button
        id="route-clear-btn"
        type="button"
        class="route-btn route-btn-clear"
        :title="t('Clear pins and calculated route')"
      >
        {{ t('CLEAR PINS / ROUTE') }}
      </button>
    </div>

    <!-- Route Results & Guidance Display -->
    <div id="route-result-display" class="route-result-display" aria-live="polite"></div>
  </div>
</template>

<style scoped>
.route-planner-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(6, 16, 26, 0.95);
  border: 1px solid rgba(0, 229, 255, 0.3);
  border-radius: 6px;
  padding: 10px;
  margin-top: 10px;
  font-family: inherit;
  color: #fff;
  box-sizing: border-box;
}

.route-planner-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(0, 229, 255, 0.2);
  padding-bottom: 6px;
}

.route-planner-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.route-planner-icon {
  font-size: 14px;
}

.route-planner-title {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: #00e5ff;
}

.route-planner-badge {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.6);
  letter-spacing: 0.5px;
  transition: all 0.2s ease;
}

.route-planner-badge.active {
  background: rgba(0, 229, 255, 0.25);
  color: #00e5ff;
  border: 1px solid rgba(0, 229, 255, 0.5);
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.4);
}

.route-search-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.route-search-input-wrap {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(0, 229, 255, 0.25);
  border-radius: 20px;
  padding: 4px 10px;
  gap: 6px;
}

.route-search-icon {
  font-size: 12px;
  color: #00e5ff;
}

.route-search-input {
  background: none;
  border: none;
  outline: none;
  color: #fff;
  font-size: 11px;
  width: 100%;
}

.route-search-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
}

.route-preset-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.route-preset-pill {
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid rgba(0, 229, 255, 0.2);
  color: rgba(255, 255, 255, 0.8);
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 600;
  padding: 3px 7px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.route-preset-pill:hover {
  background: rgba(0, 229, 255, 0.22);
  border-color: #00e5ff;
  color: #fff;
}

.route-planner-row {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}

.route-field-wrap {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.route-field-label {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.65);
  display: flex;
  align-items: center;
  gap: 4px;
}

.pin-indicator {
  font-size: 10px;
  line-height: 1;
}

.pin-start {
  color: #00e5ff;
}

.pin-dest {
  color: #ff00ff;
}

.route-input {
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(0, 229, 255, 0.3);
  border-radius: 4px;
  color: #fff;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.route-input:focus {
  border-color: #00e5ff;
  box-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
}

.route-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.route-autocomplete-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 9999;
  background: rgba(8, 16, 28, 0.98);
  border: 1px solid rgba(0, 229, 255, 0.4);
  border-radius: 4px;
  max-height: 160px;
  overflow-y: auto;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.7);
}

.route-planner-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.route-btn {
  flex: 1;
  padding: 7px 10px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  box-sizing: border-box;
}

.route-btn-pins {
  background: rgba(0, 229, 255, 0.15);
  border: 1px solid rgba(0, 229, 255, 0.4);
  color: #00e5ff;
}

.route-btn-pins:hover {
  background: rgba(0, 229, 255, 0.28);
  border-color: #00e5ff;
}

.route-btn-pins.active {
  background: #00e5ff;
  border-color: #00e5ff;
  color: #000;
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.6);
}

.route-btn-calc {
  background: #00e5ff;
  border: 1px solid #00e5ff;
  color: #000;
}

.route-btn-calc:hover {
  background: #66f4ff;
  border-color: #66f4ff;
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.5);
}

.route-btn-clear {
  background: rgba(255, 51, 102, 0.15);
  border: 1px solid rgba(255, 51, 102, 0.35);
  color: #ff3366;
}

.route-btn-clear:hover {
  background: rgba(255, 51, 102, 0.3);
  border-color: #ff3366;
}

.route-result-display {
  margin-top: 6px;
}
</style>

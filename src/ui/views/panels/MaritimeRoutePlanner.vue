<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useMaritimeRoutePlannerStore } from '../../stores/maritimeRoutePlanner.js';
import { fetchLocationSuggestions } from '../../../locations.js';
import {
  initRoutePlanner,
  resolveLocationAsync,
  calculateGeodesicDistanceKm,
} from '../../../routePlanner.js';
import { t } from '../../../i18n/index.js';

const plannerStore = useMaritimeRoutePlannerStore();

const searchInput = ref('');
const searchSuggestions = ref([]);
const showSearchSuggestions = ref(false);
const activeSearchIndex = ref(-1);

const startInput = ref('');
const destInput = ref('');
const startSuggestions = ref([]);
const showStartSuggestions = ref(false);
const destSuggestions = ref([]);
const showDestSuggestions = ref(false);

const isPlacingPins = ref(false);
const pinStage = ref(0); // 0 = start (cyan), 1 = dest (magenta)
const statusBadge = ref('READY');

const presets = [
  { id: 'scott', name: 'Scott Base', label: 'SCOTT BASE' },
  { id: 'mcmurdo', name: 'McMurdo Station', label: 'MCMURDO' },
  { id: 'casey', name: 'Casey Station', label: 'CASEY' },
  { id: 'hobart', name: 'Hobart', label: 'HOBART' },
  { id: 'punta', name: 'Punta Arenas', label: 'PUNTA ARENAS' },
  { id: 'christchurch', name: 'Christchurch', label: 'CHRISTCHURCH' },
  { id: 'sydney', name: 'Sydney', label: 'SYDNEY' },
  { id: 'newyork', name: 'New York', label: 'NEW YORK' },
  { id: 'london', name: 'London', label: 'LONDON' },
  { id: 'tokyo', name: 'Tokyo', label: 'TOKYO' },
];

let searchDebounceTimer = null;
let startDebounceTimer = null;
let destDebounceTimer = null;
let syncObserver = null;
let retryInitTimer = null;

function getPlanner() {
  return window.__cryonis?.routePlanner || window.routePlanner || null;
}

function getViewer() {
  return window.__cryonis?.viewer || window.viewer || window.__gevViewer || null;
}

const formatPinLabel = (lat, lon) => `Pin: ${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;

function syncInputsFromPlanner() {
  const planner = getPlanner();
  if (!planner) return;

  if (planner.initialPinData && !startInput.value) {
    startInput.value = planner.initialPinData.label || formatPinLabel(planner.initialPinData.lat, planner.initialPinData.lon);
  }
  if (planner.finalPinData && !destInput.value) {
    destInput.value = planner.finalPinData.label || formatPinLabel(planner.finalPinData.lat, planner.finalPinData.lon);
  }
}

function connectRoutePlanner() {
  const viewer = getViewer();
  const planner = getPlanner();

  if (viewer || planner) {
    initRoutePlanner({ viewer, planner });
    syncInputsFromPlanner();
    return true;
  }
  return false;
}

// Watch store isOpen to connect and handle lifecycle
watch(() => plannerStore.isOpen, (newVal) => {
  if (newVal) {
    nextTick(() => {
      connectRoutePlanner();
    });
  } else {
    handleStopPlacement();
  }
});

// Location Search autocomplete
async function onSearchInput() {
  clearTimeout(searchDebounceTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchSuggestions.value = [];
    showSearchSuggestions.value = false;
    activeSearchIndex.value = -1;
    return;
  }
  searchDebounceTimer = setTimeout(async () => {
    const results = await fetchLocationSuggestions(q);
    searchSuggestions.value = results || [];
    showSearchSuggestions.value = (results && results.length > 0);
    activeSearchIndex.value = -1;
  }, 220);
}

function onSearchKeydown(e) {
  if (!showSearchSuggestions.value || searchSuggestions.value.length === 0) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLocationSelect(searchInput.value.trim());
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSearchIndex.value = (activeSearchIndex.value + 1) % searchSuggestions.value.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSearchIndex.value = (activeSearchIndex.value - 1 + searchSuggestions.value.length) % searchSuggestions.value.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeSearchIndex.value >= 0 && searchSuggestions.value[activeSearchIndex.value]) {
      selectSearchSuggestion(searchSuggestions.value[activeSearchIndex.value]);
    } else {
      selectSearchSuggestion(searchSuggestions.value[0]);
    }
  } else if (e.key === 'Escape') {
    showSearchSuggestions.value = false;
  }
}

async function selectSearchSuggestion(item) {
  showSearchSuggestions.value = false;
  searchInput.value = '';
  await handleLocationSelect(item.label || item);
}

// Direct Start / Destination autocomplete
async function onStartInput() {
  clearTimeout(startDebounceTimer);
  const q = startInput.value.trim();
  if (q.length < 2) {
    startSuggestions.value = [];
    showStartSuggestions.value = false;
    return;
  }
  startDebounceTimer = setTimeout(async () => {
    const results = await fetchLocationSuggestions(q);
    startSuggestions.value = results || [];
    showStartSuggestions.value = (results && results.length > 0);
  }, 220);
}

async function selectStartSuggestion(item) {
  showStartSuggestions.value = false;
  startInput.value = item.label;
  await assignPinLocation('initial', item.label || item);
}

async function onDestInput() {
  clearTimeout(destDebounceTimer);
  const q = destInput.value.trim();
  if (q.length < 2) {
    destSuggestions.value = [];
    showDestSuggestions.value = false;
    return;
  }
  destDebounceTimer = setTimeout(async () => {
    const results = await fetchLocationSuggestions(q);
    destSuggestions.value = results || [];
    showDestSuggestions.value = (results && results.length > 0);
  }, 220);
}

async function selectDestSuggestion(item) {
  showDestSuggestions.value = false;
  destInput.value = item.label;
  await assignPinLocation('final', item.label || item);
}

// Selection of quick chips or search items
async function handleLocationSelect(query) {
  if (!query) return;

  // Determine whether to fill start or destination
  if (!startInput.value.trim()) {
    await assignPinLocation('initial', query);
  } else {
    await assignPinLocation('final', query);
  }
}

async function assignPinLocation(type, query) {
  const planner = getPlanner();
  const locState = await resolveLocationAsync(query);

  if (!locState.resolved) {
    const resultDisplay = document.getElementById('route-result-display');
    if (resultDisplay) {
      resultDisplay.innerHTML = `
        <div class="route-result-error" style="background:rgba(255,51,102,0.12);border:1px solid rgba(255,51,102,0.4);padding:10px;border-radius:6px;font-size:11px;color:#fff;">
          <div style="font-weight:bold;margin-bottom:6px;color:#ff3366;">LOCATION NOT FOUND</div>
          <div>${locState.error || `Unable to resolve location "${query}"`}</div>
        </div>
      `;
    }
    return;
  }

  const pinData = {
    lat: locState.latitude,
    lon: locState.longitude,
    label: locState.name,
    isLand: locState.isLand,
    rawLat: locState.rawLat,
    rawLon: locState.rawLon,
    resolved: true,
  };

  if (type === 'initial') {
    startInput.value = locState.name;
    if (planner) {
      planner.initialPinData = pinData;
      planner.createPinEntity('initial', pinData);
    }
  } else {
    destInput.value = locState.name;
    if (planner) {
      planner.finalPinData = pinData;
      planner.createPinEntity('final', pinData);
    }
  }

  const viewer = getViewer();
  if (viewer) {
    import('cesium').then((Cesium) => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(locState.longitude, locState.latitude, 350000),
        duration: 1.8,
      });
    }).catch(() => {});
  }

  // If both are filled, trigger calculation
  if (startInput.value && destInput.value) {
    handleCalculateShortestPath();
  }
}

// Action Button 1: PLACE PINS
function handleTogglePins() {
  let planner = getPlanner();
  const viewer = getViewer();

  if (!planner && viewer) {
    planner = initRoutePlanner({ viewer });
    if (typeof window !== 'undefined') {
      window.__cryonis = window.__cryonis || {};
      window.__cryonis.routePlanner = planner;
      window.routePlanner = planner;
    }
  }

  if (planner && viewer && !planner.viewer) {
    planner.setViewer(viewer);
  }

  if (!planner) return;

  if (isPlacingPins.value) {
    handleStopPlacement();
  } else {
    isPlacingPins.value = true;
    pinStage.value = 0;
    statusBadge.value = t('CLICK GLOBE (INITIAL PIN)...');

    planner.startPinPlacement((type, pinData) => {
      if (type === 'initial') {
        const label = formatPinLabel(pinData.lat, pinData.lon);
        startInput.value = label;
        pinStage.value = 1;
        statusBadge.value = t('CLICK GLOBE (DESTINATION PIN)...');
      } else if (type === 'final') {
        const label = formatPinLabel(pinData.lat, pinData.lon);
        destInput.value = label;
        isPlacingPins.value = false;
        pinStage.value = 0;
        statusBadge.value = t('READY');
        handleCalculateShortestPath();
      }
    });
  }
}

function handleStopPlacement() {
  isPlacingPins.value = false;
  pinStage.value = 0;
  statusBadge.value = t('READY');
  const planner = getPlanner();
  if (planner && typeof planner.stopPinPlacement === 'function') {
    planner.stopPinPlacement();
  }
}

// Action Button 2: CALCULATE SHORTEST PATH
async function handleCalculateShortestPath() {
  const planner = getPlanner();
  if (!planner) return;

  handleStopPlacement();

  const startVal = startInput.value.trim() || planner.initialPinData;
  const destVal = destInput.value.trim() || planner.finalPinData;

  const resultDisplay = document.getElementById('route-result-display');
  if (resultDisplay) {
    resultDisplay.innerHTML = `
      <div style="padding:10px;text-align:center;color:#00e5ff;font-family:monospace;font-size:11px;background:rgba(0,229,255,0.08);border:1px solid rgba(0,229,255,0.25);border-radius:6px;">
        <span style="display:inline-block;animation:spin 1s linear infinite;margin-right:6px;">⚙</span>
        CALCULATING OPTIMAL MARITIME ROUTE...
      </div>
    `;
  }

  const res = await planner.calculateRoute(startVal, destVal, 'SHORTEST');

  if (typeof planner.updateResultUI === 'function') {
    planner.updateResultUI(res);
  }
}

// Action Button 3: CLEAR PINS / ROUTE
function handleClear() {
  handleStopPlacement();

  const planner = getPlanner();
  if (planner) {
    planner.clearAll();
  }

  startInput.value = '';
  destInput.value = '';
  searchInput.value = '';
  searchSuggestions.value = [];
  showSearchSuggestions.value = false;
  startSuggestions.value = [];
  showStartSuggestions.value = false;
  destSuggestions.value = [];
  showDestSuggestions.value = false;

  const resultDisplay = document.getElementById('route-result-display');
  if (resultDisplay) {
    resultDisplay.innerHTML = '';
  }
}

function closePanel() {
  plannerStore.close();
}

onMounted(() => {
  if (!connectRoutePlanner()) {
    retryInitTimer = setInterval(() => {
      if (connectRoutePlanner()) {
        clearInterval(retryInitTimer);
        retryInitTimer = null;
      }
    }, 300);
    setTimeout(() => {
      if (retryInitTimer) {
        clearInterval(retryInitTimer);
        retryInitTimer = null;
      }
    }, 6000);
  }
});

onUnmounted(() => {
  handleStopPlacement();
  if (retryInitTimer) {
    clearInterval(retryInitTimer);
    retryInitTimer = null;
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="plannerStore.isOpen"
      id="maritime-location-panel"
      class="maritime-floating-panel ui-scroll"
      role="dialog"
      aria-label="Maritime Location and Shortest Route Planner"
    >
      <!-- Panel Header with Title, Status & Close Button -->
      <div class="panel-header-bar">
        <div class="panel-title-group">
          <span class="panel-title-icon" aria-hidden="true">🧭</span>
          <span class="panel-title-text">{{ t('MARITIME ROUTE PLANNER') }}</span>
          <span class="panel-status-tag" :class="{ placing: isPlacingPins }">
            {{ statusBadge }}
          </span>
        </div>
        <button
          type="button"
          class="panel-close-btn"
          :title="t('Close Maritime Route Planner (Esc)')"
          aria-label="Close"
          @click="closePanel"
        >
          ✕
        </button>
      </div>

      <!-- SECTION A: Location Search Bar -->
      <div class="location-search-wrap">
        <div class="search-input-pill">
          <span class="search-icon" aria-hidden="true">🔍</span>
          <input
            type="text"
            id="route-location-search"
            class="search-input"
            v-model="searchInput"
            :placeholder="t('Search any location...')"
            autocomplete="off"
            spellcheck="false"
            @input="onSearchInput"
            @keydown="onSearchKeydown"
            @blur="setTimeout(() => showSearchSuggestions = false, 250)"
            @focus="onSearchInput"
          />
        </div>
        <!-- Autocomplete Suggestions Dropdown -->
        <div
          v-if="showSearchSuggestions && searchSuggestions.length > 0"
          class="search-suggestions-dropdown ui-scroll"
        >
          <div
            v-for="(item, idx) in searchSuggestions"
            :key="idx"
            class="suggestion-item"
            :class="{ active: idx === activeSearchIndex }"
            @mousedown.prevent="selectSearchSuggestion(item)"
          >
            <div class="suggestion-name">📍 {{ item.label }}</div>
            <div class="suggestion-coords">{{ item.lat.toFixed(4) }}°, {{ item.lon.toFixed(4) }}°</div>
          </div>
        </div>
      </div>

      <!-- Quick-Select Location Chips -->
      <div class="preset-chips-row" role="group" :aria-label="t('Antarctic and world gateway presets')">
        <button
          v-for="preset in presets"
          :key="preset.id"
          type="button"
          class="preset-chip route-preset-pill"
          :data-location="preset.name"
          @click="handleLocationSelect(preset.name)"
        >
          {{ preset.label }}
        </button>
      </div>

      <!-- SECTION B: SHORTEST ROUTE PLANNER -->
      <div class="route-planner-box">
        <div class="route-planner-title">
          {{ t('SHORTEST ROUTE PLANNER') }}
        </div>

        <div class="route-inputs-grid">
          <!-- Start Location Input -->
          <div class="route-input-col">
            <input
              type="text"
              id="route-initial-location"
              class="route-field-input"
              v-model="startInput"
              :placeholder="t('Start Location (e.g. Scott Base)')"
              autocomplete="off"
              spellcheck="false"
              @input="onStartInput"
              @keydown.enter.prevent="handleCalculateShortestPath"
              @blur="setTimeout(() => showStartSuggestions = false, 250)"
            />
            <div
              v-if="showStartSuggestions && startSuggestions.length > 0"
              class="input-autocomplete-dropdown ui-scroll"
            >
              <div
                v-for="(item, idx) in startSuggestions"
                :key="idx"
                class="suggestion-item"
                @mousedown.prevent="selectStartSuggestion(item)"
              >
                <div class="suggestion-name">📍 {{ item.label }}</div>
                <div class="suggestion-coords">{{ item.lat.toFixed(4) }}°, {{ item.lon.toFixed(4) }}°</div>
              </div>
            </div>
            <div id="route-initial-autocomplete" class="route-autocomplete-list" hidden></div>
          </div>

          <!-- Destination Input -->
          <div class="route-input-col">
            <input
              type="text"
              id="route-final-location"
              class="route-field-input"
              v-model="destInput"
              :placeholder="t('Destination (e.g. Hobart)')"
              autocomplete="off"
              spellcheck="false"
              @input="onDestInput"
              @keydown.enter.prevent="handleCalculateShortestPath"
              @blur="setTimeout(() => showDestSuggestions = false, 250)"
            />
            <div
              v-if="showDestSuggestions && destSuggestions.length > 0"
              class="input-autocomplete-dropdown ui-scroll"
            >
              <div
                v-for="(item, idx) in destSuggestions"
                :key="idx"
                class="suggestion-item"
                @mousedown.prevent="selectDestSuggestion(item)"
              >
                <div class="suggestion-name">📍 {{ item.label }}</div>
                <div class="suggestion-coords">{{ item.lat.toFixed(4) }}°, {{ item.lon.toFixed(4) }}°</div>
              </div>
            </div>
            <div id="route-final-autocomplete" class="route-autocomplete-list" hidden></div>
          </div>
        </div>

        <!-- SECTION C: Three Horizontally Aligned Action Buttons -->
        <div class="route-actions-row">
          <!-- Button 1: PLACE PINS -->
          <button
            id="route-place-pins-btn"
            type="button"
            class="action-btn btn-place-pins"
            data-vue-managed="true"
            :class="{ active: isPlacingPins }"
            :title="t('Click Cesium globe to place Cyan (Start) and Magenta (Destination) pins')"
            @click="handleTogglePins"
          >
            <span>📍 {{ isPlacingPins ? (pinStage === 0 ? t('CLICK GLOBE (INITIAL PIN)...') : t('CLICK GLOBE (DESTINATION PIN)...')) : t('PLACE PINS') }}</span>
          </button>

          <!-- Button 2: CALCULATE SHORTEST PATH -->
          <button
            id="route-calculate-btn"
            type="button"
            class="action-btn btn-calculate"
            data-vue-managed="true"
            :title="t('Calculate shortest maritime route with sea-ice obstacle avoidance')"
            @click="handleCalculateShortestPath"
          >
            {{ t('CALCULATE SHORTEST PATH') }}
          </button>

          <!-- Button 3: CLEAR PINS / ROUTE -->
          <button
            id="route-clear-btn"
            type="button"
            class="action-btn btn-clear"
            data-vue-managed="true"
            :title="t('Remove placed pins, route paths, and clear inputs')"
            @click="handleClear"
          >
            {{ t('CLEAR PINS / ROUTE') }}
          </button>
        </div>
      </div>

      <!-- Route Calculation Results & Tactical Navigation HUD Display -->
      <div id="route-result-display" class="route-result-display" aria-live="polite"></div>
    </div>
  </Teleport>
</template>

<style scoped>
.maritime-floating-panel {
  position: fixed;
  bottom: 84px;
  left: 50%;
  transform: translateX(-50%);
  width: min(860px, calc(100vw - 36px));
  max-height: calc(100vh - 110px);
  overflow-y: auto;
  z-index: 1040;
  background: rgba(6, 16, 28, 0.94);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(0, 229, 255, 0.45);
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.8), 0 0 20px rgba(0, 229, 255, 0.22), inset 0 0 12px rgba(0, 229, 255, 0.06);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: inherit;
  color: #fff;
  box-sizing: border-box;
  animation: panelSlideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes panelSlideUp {
  from {
    opacity: 0;
    transform: translate(-50%, 14px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

.panel-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(0, 229, 255, 0.2);
  padding-bottom: 6px;
}

.panel-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-title-icon {
  font-size: 15px;
}

.panel-title-text {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: #00e5ff;
}

.panel-status-tag {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.5px;
  transition: all 0.2s ease;
}

.panel-status-tag.placing {
  background: rgba(0, 229, 255, 0.25);
  color: #00e5ff;
  border: 1px solid #00e5ff;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.5);
  animation: pulseTag 1.5s infinite;
}

@keyframes pulseTag {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.panel-close-btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.panel-close-btn:hover {
  color: #ff3366;
  background: rgba(255, 51, 102, 0.15);
}

/* SECTION A: Search input pill */
.location-search-wrap {
  position: relative;
  width: 100%;
}

.search-input-pill {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(0, 229, 255, 0.35);
  border-radius: 20px;
  padding: 5px 12px;
  gap: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.search-input-pill:focus-within {
  border-color: #00e5ff;
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
}

.search-icon {
  font-size: 13px;
  color: #00e5ff;
}

.search-input {
  background: none;
  border: none;
  outline: none;
  color: #fff;
  font-size: 12px;
  width: 100%;
  font-family: inherit;
}

.search-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
}

.search-suggestions-dropdown,
.input-autocomplete-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: rgba(6, 16, 28, 0.98);
  border: 1px solid rgba(0, 229, 255, 0.4);
  border-radius: 6px;
  max-height: 180px;
  overflow-y: auto;
  z-index: 1050;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.85);
}

.suggestion-item {
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(0, 229, 255, 0.12);
  transition: background 0.15s ease;
}

.suggestion-item:last-child {
  border-bottom: none;
}

.suggestion-item:hover,
.suggestion-item.active {
  background: rgba(0, 229, 255, 0.2);
}

.suggestion-name {
  font-weight: 700;
  font-size: 11px;
  color: #00e5ff;
}

.suggestion-coords {
  font-size: 9.5px;
  color: rgba(255, 255, 255, 0.6);
  font-family: var(--font-mono, monospace);
}

/* Quick chips */
.preset-chips-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.preset-chip {
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid rgba(0, 229, 255, 0.28);
  color: #cceeff;
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  font-weight: 700;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  letter-spacing: 0.5px;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.preset-chip:hover {
  background: rgba(0, 229, 255, 0.22);
  border-color: #00e5ff;
  color: #00f0ff;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.4);
}

/* SECTION B: Shortest Route Planner Box */
.route-planner-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid rgba(0, 229, 255, 0.25);
  padding-top: 8px;
}

.route-planner-title {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1.2px;
  color: #00e5ff;
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.4);
}

.route-inputs-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.route-input-col {
  position: relative;
  width: 100%;
}

.route-field-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(0, 229, 255, 0.32);
  border-radius: 4px;
  color: #fff;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  padding: 8px 10px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.route-field-input:focus {
  border-color: #00e5ff;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
}

.route-field-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
  font-family: inherit;
}

/* SECTION C: 3 Action Buttons */
.route-actions-row {
  display: grid;
  grid-template-columns: 1fr 1.35fr 1fr;
  gap: 10px;
  margin-top: 2px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  padding: 9px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.18s ease;
  white-space: nowrap;
}

/* Button 1: PLACE PINS */
.btn-place-pins {
  background: rgba(0, 229, 255, 0.15);
  border: 1.5px solid rgba(0, 229, 255, 0.55);
  color: #00e5ff;
}

.btn-place-pins:hover {
  background: rgba(0, 229, 255, 0.3);
  border-color: #00ffff;
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.5);
}

.btn-place-pins.active {
  background: rgba(0, 229, 255, 0.35);
  border-color: #00ffff;
  color: #00ffff;
  box-shadow: 0 0 14px rgba(0, 255, 255, 0.7);
  animation: pulseBtn 1.2s infinite;
}

@keyframes pulseBtn {
  0%, 100% { box-shadow: 0 0 14px rgba(0, 255, 255, 0.7); }
  50% { box-shadow: 0 0 6px rgba(0, 255, 255, 0.3); }
}

/* Button 2: CALCULATE SHORTEST PATH */
.btn-calculate {
  background: #00f0ff;
  border: 1.5px solid #00f0ff;
  color: #05101a;
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.35);
}

.btn-calculate:hover {
  background: #33f5ff;
  border-color: #33f5ff;
  box-shadow: 0 0 18px rgba(0, 240, 255, 0.6);
}

/* Button 3: CLEAR PINS / ROUTE */
.btn-clear {
  background: rgba(255, 51, 102, 0.15);
  border: 1.5px solid rgba(255, 51, 102, 0.55);
  color: #ff3366;
}

.btn-clear:hover {
  background: rgba(255, 51, 102, 0.3);
  border-color: #ff3366;
  box-shadow: 0 0 10px rgba(255, 51, 102, 0.5);
}

.route-result-display {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>

import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useMaritimeRoutePlannerStore = defineStore('maritimeRoutePlanner', () => {
  const isOpen = ref(false);
  const isPlacingPins = ref(false);
  const pinStage = ref(0); // 0 = start pin, 1 = dest pin
  const startLocation = ref('');
  const destLocation = ref('');
  const searchQuery = ref('');
  const statusBadge = ref('READY');

  function open() {
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
    stopPlacement();
  }

  function toggle() {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  function stopPlacement() {
    isPlacingPins.value = false;
    pinStage.value = 0;
    statusBadge.value = 'READY';
    const planner = window.__cryonis?.routePlanner || window.routePlanner;
    if (planner && typeof planner.stopPinPlacement === 'function') {
      planner.stopPinPlacement();
    }
  }

  return {
    isOpen,
    isPlacingPins,
    pinStage,
    startLocation,
    destLocation,
    searchQuery,
    statusBadge,
    open,
    close,
    toggle,
    stopPlacement,
  };
});

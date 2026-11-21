import * as Cesium from 'cesium';
import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import { PHOTON_SETTING as photonSetting } from './search/photonSetting.js';
import { initRoutePlanner } from './routePlanner.js';
import { initSimulation } from './simulation/index.js';
import { initOceanEmbedUi } from './oceanEmbedUi.js';

// Configure Cesium ion global default access token if provided in environment
if (import.meta.env.CESIUM_ION_TOKEN) {
  Cesium.Ion.defaultAccessToken = import.meta.env.CESIUM_ION_TOKEN;
}

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  geospatial:
    photonSetting === undefined ? {} : { endpoints: { photon: photonSetting } },
  allowQaRegistration: import.meta.env.DEV,
});

application.start().then((components) => {
  try {
    const viewer = components?.scene?.viewer;
    const dataManager = components?.data?.dataManager;
    if (viewer) {
      const routePlanner = initRoutePlanner({ viewer });
      const simManager = initSimulation({ viewer, dataManager });
      initOceanEmbedUi();

      window.__cryonis = {
        routePlanner,
        simManager,
        viewer,
      };
      window.routePlanner = routePlanner;
      window.simManager = simManager;
      window.viewer = viewer;
      window.__gevViewer = viewer;

      // Link RoutePlanner location changes to active Simulation scenario
      routePlanner.onLocationsChanged = (startLoc, destLoc) => {
        if (simManager.getActiveSimulation() === 'sim-2') {
          return simManager.rebuildSimulation2Scenario(startLoc, destLoc);
        }
        return simManager.rebuildSimulation1Scenario(startLoc, destLoc);
      };
    }
  } catch (err) {
    console.warn('[CRYONIS] Navigation module startup notice:', err);
  }
}).catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  if (loaderStatus) {
    loaderStatus.textContent = t('Error: {message}', {
      message: describeError(error),
    });
    loaderStatus.style.color = '#ff4444';
  }
});

export { application };

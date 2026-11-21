import { oceanEmbedLayer } from './data/oceanEmbed.js';

export function initOceanEmbedUi() {
  const depthSlider = document.getElementById('oceanembed-depth');
  const depthValue = document.getElementById('oceanembed-depth-value');
  const dateInput = document.getElementById('oceanembed-date');
  const variableSelect = document.getElementById('oceanembed-variable');
  const runBtn = document.getElementById('oceanembed-run-btn');
  const toast = document.getElementById('toast');
  let toastTimer = null;

  const depths = [
    '0 m', '5 m', '10 m', '20 m', '30 m', '50 m', '75 m', '100 m',
    '125 m', '150 m', '200 m', '300 m', '500 m', '700 m', '1000 m'
  ];

  // Set a sensible default date
  if (dateInput) {
    const today = new Date();
    dateInput.value = today.toISOString().split('T')[0];
  }

  const pushState = () => {
    const selectedDepthIndex = depthSlider ? parseInt(depthSlider.value, 10) : 0;
    const selectedDepthLabel = depthSlider ? depths[selectedDepthIndex] : '0 m';
    const selectedDate = dateInput ? dateInput.value : undefined;
    const selectedVariableValue = variableSelect ? variableSelect.value : undefined;

    oceanEmbedLayer.setVisualizationState({
      depthIndex: selectedDepthIndex,
      depth: selectedDepthLabel,
      date: selectedDate,
      variable: selectedVariableValue
    });

    // Update Results Panel
    const resDate = document.getElementById('oe-res-date');
    const resVariable = document.getElementById('oe-res-variable');
    const resDepth = document.getElementById('oe-res-depth');
    
    if (resDate) resDate.textContent = selectedDate || '--';
    if (resVariable && variableSelect) {
      const option = variableSelect.options[variableSelect.selectedIndex];
      resVariable.textContent = option ? option.text : '--';
    }
    if (resDepth) resDepth.textContent = selectedDepthLabel || '--';
  };

  if (depthSlider && depthValue) {
    depthSlider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value, 10);
      if (idx >= 0 && idx < depths.length) {
        depthValue.textContent = depths[idx];
        pushState();
        oceanEmbedLayer.updateVisualization();
      }
    });
  }

  if (dateInput) {
    dateInput.addEventListener('change', () => {
      pushState();
      oceanEmbedLayer.updateVisualization();
    });
  }

  if (runBtn) {
    runBtn.addEventListener('click', () => {
      pushState();
      oceanEmbedLayer.updateVisualization(true);

      if (!toast) return;
      const d = dateInput ? dateInput.value : 'unknown date';
      const dp = depthSlider ? depths[parseInt(depthSlider.value, 10)] : 'unknown depth';
      
      toast.innerHTML = `OceanEmbed Request<br/>Depth: ${dp}<br/>Date: ${d}`;
      toast.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
      }, 4000);

      // Show the results panel automatically if it's collapsed
      const resultsPanel = document.getElementById('oceanembed-results-panel');
      if (resultsPanel && resultsPanel.classList.contains('collapsed')) {
        resultsPanel.classList.remove('collapsed');
      }

      // Show the profile panel automatically if it's collapsed
      const profilePanel = document.getElementById('oceanembed-profile-panel');
      if (profilePanel && profilePanel.classList.contains('collapsed')) {
        profilePanel.classList.remove('collapsed');
      }
    });
  }
}

/**
 * Interface to receive vertical profile data from the ML model.
 * 
 * @param {Array<{depth: number, temperature: number}>|null} profileData - The predicted profile points
 * @param {Object} context - Optional context for the profile
 * @param {string} [context.location] - Location label
 * @param {string} [context.date] - Date string
 */
export function setVerticalProfile(profileData, context = {}) {
  const chartContainer = document.getElementById('oceanembed-profile-chart');
  const locEl = document.getElementById('oe-profile-loc');
  const dateEl = document.getElementById('oe-profile-date');

  if (locEl) {
    locEl.textContent = context.location || '--';
  }
  if (dateEl) {
    dateEl.textContent = context.date || '--';
  }

  if (chartContainer) {
    if (!profileData || profileData.length === 0) {
      chartContainer.innerHTML = '<span style="color: rgba(255,255,255,0.5); font-size: 11px;">Real model prediction will appear here.</span>';
    } else {
      chartContainer.innerHTML = '<span style="color: rgba(255,255,255,0.5); font-size: 11px;">Waiting for real model...</span>';
    }
  }
}

/**
 * Distributes a prediction response to the UI.
 * 
 * @param {Object} prediction - The full prediction contract response
 */
export function applyOceanEmbedPrediction(prediction) {
  if (!prediction) return;

  // 1. Update Results Panel
  const resLoc = document.getElementById('oe-res-location');
  const resDate = document.getElementById('oe-res-date');
  const resVariable = document.getElementById('oe-res-variable');
  const resDepth = document.getElementById('oe-res-depth');
  const resPred = document.getElementById('oe-res-prediction');
  
  const resRmse = document.getElementById('oe-res-rmse');
  const resBias = document.getElementById('oe-res-bias');
  const resCorrelation = document.getElementById('oe-res-correlation');
  const resGlorys = document.getElementById('oe-res-glorys');
  const resArgo = document.getElementById('oe-res-argo');

  if (resLoc && prediction.location) {
    resLoc.textContent = `${prediction.location.latitude.toFixed(2)}, ${prediction.location.longitude.toFixed(2)}`;
  }
  if (resDate && prediction.date) {
    resDate.textContent = prediction.date;
  }
  if (resVariable && prediction.variable) {
    resVariable.textContent = prediction.variable;
  }
  
  // Note: we can map the depthIndex back to a label if necessary, but we'll assume the UI already set the depth label, 
  // or we can set it if prediction includes it. For now, we trust the UI pushState has set it, or update it if we have real depth.
  
  if (resPred) {
    if (prediction.status === 'success' && prediction.selectedTemperature !== undefined && prediction.selectedTemperature !== null) {
      resPred.textContent = `${prediction.selectedTemperature.toFixed(2)} °C`;
    } else if (prediction.status === 'pending') {
      resPred.textContent = 'Predicting...';
    } else if (prediction.status === 'unavailable') {
      resPred.textContent = 'Waiting for real model';
    } else if (prediction.status === 'error') {
      resPred.textContent = 'Prediction Error';
    } else {
      resPred.textContent = '--';
    }
  }

  // Update validation and reference metrics (empty for now per requirements)
  if (resRmse) resRmse.textContent = prediction.validation?.rmse ?? '--';
  if (resBias) resBias.textContent = prediction.validation?.bias ?? '--';
  if (resCorrelation) resCorrelation.textContent = prediction.validation?.correlation ?? '--';
  if (resGlorys) resGlorys.textContent = prediction.reference?.glorys ?? 'Not available';
  if (resArgo) resArgo.textContent = prediction.reference?.argo ?? 'Not available';

  // 2. Update Vertical Profile Panel
  let displayLoc = '--';
  if (prediction.location) {
    displayLoc = `${prediction.location.latitude.toFixed(2)}, ${prediction.location.longitude.toFixed(2)}`;
  }
  setVerticalProfile(prediction.profile, {
    location: displayLoc,
    date: prediction.date || '--'
  });

  // Handle results-panel mini profile message (if it exists)
  const resProfileChart = document.getElementById('oe-res-profile-chart');
  if (resProfileChart) {
    if (!prediction.profile || prediction.profile.length === 0) {
      resProfileChart.innerHTML = '<span style="font-size:10px; color:var(--text-muted, rgba(255,255,255,0.5));">Vertical profile will appear after a real model prediction.</span>';
    } else {
      resProfileChart.innerHTML = '<span style="font-size:10px; color:rgba(0,229,255,0.8);">[Profile Data Ready]</span>';
    }
  }
}

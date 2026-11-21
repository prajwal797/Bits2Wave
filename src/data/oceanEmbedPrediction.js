/**
 * OceanEmbed Future Model Integration Boundary
 *
 * This module is the conceptual boundary for connecting the future trained OceanEmbed ML model
 * to the frontend visualization.
 * 
 * IMPORTANT:
 * - The real request/response format will be defined AFTER the actual dataset is inspected and the model is trained.
 * - The current demo behavior provided here is NOT a real scientific prediction. It is a mathematical mock
 *   used purely for testing the visualization UI.
 * - Do NOT assume additional model inputs yet.
 */

/**
 * Perform a prediction (mock implementation).
 * 
 * In the future, this function will make an async fetch() call to the model API endpoint
 * (e.g., via the Vite proxy).
 *
 * @param {Object} inputs
 * @param {number} inputs.lat - Latitude
 * @param {number} inputs.lon - Longitude
 * @param {string} inputs.date - The selected date (YYYY-MM-DD)
 * @param {number} inputs.depthIndex - The selected depth index (0 to 14)
 * @param {string} inputs.variable - The selected variable
 * @returns {Promise<Object>} A promise that resolves to the predicted value(s)
 */
export async function fetchOceanEmbedPrediction({ lat, lon, date, depthIndex, variable }) {
  try {
    const response = await fetch('/api/oceanembed/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: lat,
        longitude: lon,
        date: date,
        selectedDepth: depthIndex
      })
    });
    
    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }
    
    return await response.json();
    
  } catch (err) {
    console.error("OceanEmbed prediction fetch failed:", err);
    return {
      status: 'error',
      message: err.message,
      location: { latitude: lat, longitude: lon },
      date: date,
      variable: variable,
      selectedDepth: depthIndex,
      selectedTemperature: null,
      profile: [],
      validation: { rmse: null, bias: null, correlation: null },
      reference: { glorys: null, argo: null }
    };
  }
}

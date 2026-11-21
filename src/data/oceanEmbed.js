/**
 * OceanEmbed Development Data Layer
 * 
 * DEVELOPMENT VISUALIZATION for SIH26066.
 * Region: North Indian Ocean (Lat: 5°N to 30°N, Lon: 45°E to 105°E)
 * 
 * NOTE: These are NOT real ocean observations. They are generated purely
 * to verify Cesium positioning, DataLayerManager integration, rendering,
 * and camera movement.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { registerPickOwner, unregisterPickOwner, isOwnedByOtherLayer } from './pickRegistry.js';
import { fetchOceanEmbedPrediction } from './oceanEmbedPrediction.js';
import { setVerticalProfile, applyOceanEmbedPrediction } from '../oceanEmbedUi.js';

let _enabled = false;
let _pointPrimitiveCollection = null;
let _count = 0;
let _lastUpdate = null;
let _error = null;

let _currentDepth = '0 m';
let _currentDepthIndex = 0;
let _currentDate = new Date().toISOString().split('T')[0];
let _currentVariable = 'subsurface_temperature';
let _selectedPoint = null;
let _clickHandler = null;
let _infoCard = null;
let _viewer = null;


export const oceanEmbedLayer = {
  id: 'oceanEmbed',
  name: 'OceanEmbed',
  icon: '🌊',
  source: 'DEVELOPMENT VISUALIZATION',
  updateInterval: 0,
  statsRefreshInterval: 1000,

  init: async (viewer) => {
    // Initialized on enable
  },

  update: async (viewer) => {
    // Static dataset; no auto-polling needed
  },

  getStats: () => {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _error,
    };
  },

  enable: async (viewer) => {
    if (_enabled) return;
    _enabled = true;

    if (!_pointPrimitiveCollection && viewer) {
      try {
        _pointPrimitiveCollection = new Cesium.PointPrimitiveCollection();
        viewer.scene.primitives.add(_pointPrimitiveCollection);

        let activeCount = 0;

        // Generate a small number of demo grid points in the North Indian Ocean
        for (let lat = 5.0; lat <= 30.0; lat += 5.0) {
          for (let lon = 45.0; lon <= 105.0; lon += 5.0) {
            const p = _pointPrimitiveCollection.add({
              position: Cesium.Cartesian3.fromDegrees(lon, lat, 1000),
              pixelSize: 8,
              color: Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.8),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000000),
            });
            p.id = `oceanEmbed-${lat}-${lon}`;
            p._oceanEmbedData = { lat, lon, temperature: '0.0' };
            activeCount++;
          }
        }

        _count = activeCount;
        _lastUpdate = Date.now();
        console.log(`[OCEANEMBED LAYER] Visualized ${activeCount} DEMO DATA points`);
      } catch (err) {
        _error = `Failed to load OceanEmbed visualization: ${err?.message || err}`;
        console.error('[OCEANEMBED LAYER] Load error:', err);
      }
    }

    _viewer = viewer;
    if (_pointPrimitiveCollection) {
      _pointPrimitiveCollection.show = true;
    }

    // Move camera to North Indian Ocean region
    if (viewer && viewer.camera) {
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(45, 5, 105, 30),
        duration: 2.0,
      });
    }

    if (!_clickHandler && viewer) {
      registerPickOwner('oceanEmbed', (pickedId) => pickedId && pickedId.startsWith('oceanEmbed-'));
      
      _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
      _clickHandler.setInputAction((click) => {
        if (!_enabled) return;
        const picked = viewer.scene.pick(click.position);
        
        if (Cesium.defined(picked) && picked.primitive && picked.primitive._oceanEmbedData) {
          _selectedPoint = picked.primitive._oceanEmbedData;
          oceanEmbedLayer.updateInfoCard();
          governorRequestRender('oceanEmbed-click');
          viewer.scene.requestRender();
        } else if (Cesium.defined(picked) && picked.id) {
          // If another layer owns this pick, hide our card
          let idStr = null;
          if (typeof picked.id === 'string' || typeof picked.id === 'number') idStr = String(picked.id);
          else if (picked.id.mmsi) idStr = String(picked.id.mmsi);
          else if (picked.id.id) idStr = String(picked.id.id);

          if (idStr && isOwnedByOtherLayer('oceanEmbed', idStr)) {
            _selectedPoint = null;
            oceanEmbedLayer.updateInfoCard();
            governorRequestRender('oceanEmbed-click-miss');
            viewer.scene.requestRender();
          }
        } else {
          // clicked empty space
          _selectedPoint = null;
          oceanEmbedLayer.updateInfoCard();
          governorRequestRender('oceanEmbed-click-miss');
          viewer.scene.requestRender();
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    // Render once when necessary
    governorRequestRender('oceanEmbed-enable');
    viewer?.scene?.requestRender?.();
    
    // Initial deterministic visualization
    oceanEmbedLayer.updateVisualization();
  },

  updateInfoCard: () => {
    if (!_infoCard) {
      _infoCard = document.createElement('div');
      _infoCard.id = 'oceanembed-info-card';
      _infoCard.style.position = 'absolute';
      _infoCard.style.right = '24px';
      _infoCard.style.top = '80px';
      _infoCard.style.background = 'rgba(8,16,28,0.95)';
      _infoCard.style.border = '1px solid rgba(0,229,255,0.4)';
      _infoCard.style.borderRadius = '4px';
      _infoCard.style.padding = '12px';
      _infoCard.style.color = '#fff';
      _infoCard.style.fontFamily = 'sans-serif';
      _infoCard.style.fontSize = '12px';
      _infoCard.style.zIndex = '9999';
      _infoCard.style.pointerEvents = 'none';
      _infoCard.style.display = 'none';
      document.body.appendChild(_infoCard);
    }

    // Also update the global results panel location if it exists
    const resLocation = document.getElementById('oe-res-location');
    let displayLoc = '--';
    if (_selectedPoint && _enabled) {
      displayLoc = `${_selectedPoint.lat.toFixed(2)}, ${_selectedPoint.lon.toFixed(2)}`;
    }
    if (resLocation) {
      resLocation.textContent = displayLoc;
    }
    
    // Update Vertical Profile context
    setVerticalProfile(null, {
      location: displayLoc,
      date: _currentDate || '--'
    });
    if (!_selectedPoint || !_enabled) {
      _infoCard.style.display = 'none';
      return;
    }

    _infoCard.innerHTML = `
      <div style="font-size:10px; color:var(--text-muted, rgba(255,255,255,0.5)); letter-spacing:1px; margin-bottom:8px;">OCEANEMBED<br/>DEVELOPMENT VISUALIZATION</div>
      <div style="margin-bottom:4px;">Latitude: ${_selectedPoint.lat.toFixed(2)}</div>
      <div style="margin-bottom:4px;">Longitude: ${_selectedPoint.lon.toFixed(2)}</div>
      <div style="margin-bottom:4px;">Date: ${_currentDate}</div>
      <div style="margin-bottom:4px;">Variable: ${_currentVariable}</div>
      <div style="margin-bottom:8px;">Selected depth: ${_currentDepth}</div>
      <div style="margin-bottom:8px;">Value: <span style="color:#00e5ff; font-weight:600;">${_selectedPoint.temperature} °C</span></div>
      <div style="color:var(--text-muted, rgba(255,255,255,0.5)); font-style:italic; font-size:10px;">DEMO DATA &mdash; NOT A REAL PREDICTION</div>
    `;
    _infoCard.style.display = 'block';
  },

  setVisualizationState: (state) => {
    if (state.depthIndex !== undefined) _currentDepthIndex = state.depthIndex;
    if (state.depth !== undefined) _currentDepth = state.depth;
    if (state.date !== undefined) _currentDate = state.date;
    if (state.variable !== undefined) _currentVariable = state.variable;
    
    oceanEmbedLayer.updateInfoCard();
  },

  updateVisualization: async (debugLog = false) => {
    if (!_pointPrimitiveCollection || !_enabled || !_viewer) return;
    
    const length = _pointPrimitiveCollection.length;
    const promises = [];
    
    for (let i = 0; i < length; i++) {
      const p = _pointPrimitiveCollection.get(i);
      const data = p._oceanEmbedData;
      if (!data) continue;
      
      promises.push(
        fetchOceanEmbedPrediction({
          lat: data.lat,
          lon: data.lon,
          date: _currentDate,
          depthIndex: _currentDepthIndex,
          variable: _currentVariable
        }).then(prediction => {
          const temp = prediction.selectedTemperature;
          data.temperature = temp;
          
          // Apply to frontend UI panels if this is the currently selected point
          if (_selectedPoint && _selectedPoint.lat === data.lat && _selectedPoint.lon === data.lon) {
            applyOceanEmbedPrediction(prediction);
          }
          
          let color;
          if (temp < 15) {
            color = Cesium.Color.fromCssColorString('#0077ff');
          } else if (temp < 20) {
            color = Cesium.Color.fromCssColorString('#00d4ff');
          } else if (temp < 25) {
            color = Cesium.Color.fromCssColorString('#ffaa00');
          } else {
            color = Cesium.Color.fromCssColorString('#ff3300');
          }
          
          if (debugLog && i === 0) {
            console.log('[OCEANEMBED DEBUG] BEFORE UPDATE');
            console.log(`depthIndex: ${_currentDepthIndex}`);
            console.log(`depthMeters: ${_currentDepth}`);
            console.log(`firstPointTemp: ${temp.toFixed(1)}`);
            console.log(`firstPointColor: ${p.color ? p.color.toCssColorString() : 'null'}`);
            console.log(`firstPointPixelSize: ${p.pixelSize}`);
            console.log(`pointCount: ${length}`);
          }
          
          p.color = color.withAlpha(0.8);
          p.pixelSize = temp > 25 ? 10 : 8;
          
          if (debugLog && i === 0) {
            console.log('[OCEANEMBED DEBUG] AFTER UPDATE');
            console.log(`depthIndex: ${_currentDepthIndex}`);
            console.log(`depthMeters: ${_currentDepth}`);
            console.log(`firstPointTemp: ${temp.toFixed(1)}`);
            console.log(`firstPointColor: ${p.color ? p.color.toCssColorString() : 'null'}`);
            console.log(`firstPointPixelSize: ${p.pixelSize}`);
            console.log(`pointCount: ${length}`);
          }
        })
      );
    }
    
    await Promise.all(promises);
    
    oceanEmbedLayer.updateInfoCard();
    governorRequestRender('oceanEmbed-update-viz');
    _viewer.scene.requestRender();
  },

  setDepth: (depth) => {
    _currentDepth = depth;
    // We let the slider or RUN PREDICTION trigger setVisualizationState instead
    // so we can just leave this for compatibility or call updateInfoCard
    oceanEmbedLayer.updateInfoCard();
  },

  disable: (viewer) => {
    _enabled = false;
    if (_pointPrimitiveCollection) {
      _pointPrimitiveCollection.show = false;
    }
    oceanEmbedLayer.updateInfoCard();
    governorRequestRender('oceanEmbed-disable');
    viewer?.scene?.requestRender?.();
  },

  destroy: (viewer) => {
    _enabled = false;
    unregisterPickOwner('oceanEmbed');
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_infoCard) {
      _infoCard.remove();
      _infoCard = null;
    }
    if (_pointPrimitiveCollection && viewer) {
      try {
        viewer.scene.primitives.remove(_pointPrimitiveCollection);
      } catch {
        /* ignore */
      }
      _pointPrimitiveCollection = null;
    }
  },
};

export function createOceanEmbedLayer() {
  return { ...oceanEmbedLayer };
}

export default oceanEmbedLayer;

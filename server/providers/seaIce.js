/**
 * Vite Dev Server Provider for Antarctic Sea-Ice Data & Maritime A* Routing Engine
 *
 * Endpoints:
 * - GET  /api/sea-ice/status   -> Dataset freshness metadata (date 2026-01-01, count 83,019)
 * - GET  /api/sea-ice/point    -> Query sea-ice concentration for lat/lon point
 * - POST /api/sea-ice/profile  -> Sampling array of route points
 * - POST /api/route/calculate  -> Antarctic Maritime A* Routing Engine
 * - POST /api/route/guidance   -> Live Voyage Guidance Engine
 * - GET  /api/route/modes      -> Supported routing modes & weights
 * - GET  /api/vessel/profiles  -> Standard polar vessel profiles & fuel parameters
 * - GET/POST /api/location/validate -> Ocean vs. land validation and terrain snapping
 * - POST /api/oceanembed/predict -> Subsurface ocean prediction proxy / fallback
 */

import {
  loadSeaIceDataset,
  getSeaIceConcentration,
  getSeaIceProfile,
  DATASET_METADATA,
} from '../../src/seaIceEngine.mjs';

import {
  calculateMaritimeRoute,
  calculateMultiRouteOptions,
  classifyPointTerrain,
  findNearestOceanPoint,
  ROUTING_MODES,
} from '../../src/seaIceRoutingEngine.mjs';
import { calculateVoyageGuidance } from '../../src/voyageGuidance.mjs';
import { VESSEL_PROFILES, DEFAULT_VESSEL_PROFILE } from '../../src/fuelModel.mjs';

export function seaIceRoutingProxy() {
  const configure = (server) => {
    // Pre-load dataset on server boot
    loadSeaIceDataset().catch((err) => {
      console.warn('[SEA ICE PROXY] Background ingestion notice:', err?.message || err);
    });

    server.middlewares.use(async (req, res, next) => {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      const sendJson = (status, payload) => {
        if (res.destroyed) return;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify(payload));
      };

      const parseJsonBody = async () => {
        if (req.body && typeof req.body === 'object') return req.body;
        const chunks = [];
        try {
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw.trim()) return {};
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };

        // 1. GET /api/sea-ice/status
        if (req.method === 'GET' && pathname === '/api/sea-ice/status') {
          const meta = await loadSeaIceDataset();
          return sendJson(200, {
            status: meta.status,
            observation_date: meta.date,
            total_records: meta.totalRecords,
            coverage_bbox: {
              min_latitude: meta.minLat,
              max_latitude: meta.maxLat,
              min_longitude: meta.minLon,
              max_longitude: meta.maxLon,
            },
            disclaimer: 'Sea Ice Data: 2026-01-01 (Historical observation dataset)',
          });
        }

        // 2. GET /api/sea-ice/point?lat=...&lon=...
        if (req.method === 'GET' && pathname === '/api/sea-ice/point') {
          await loadSeaIceDataset();
          const lat = parseFloat(urlObj.searchParams.get('lat'));
          const lon = parseFloat(urlObj.searchParams.get('lon'));
          const info = getSeaIceConcentration(lat, lon);
          return sendJson(200, info);
        }

        // 3. GET /api/route/modes
        if (req.method === 'GET' && pathname === '/api/route/modes') {
          return sendJson(200, {
            status: 'success',
            modes: Object.values(ROUTING_MODES),
          });
        }

        // 4. GET /api/vessel/profiles
        if (req.method === 'GET' && pathname === '/api/vessel/profiles') {
          return sendJson(200, {
            status: 'success',
            default: DEFAULT_VESSEL_PROFILE.id,
            profiles: Object.values(VESSEL_PROFILES),
          });
        }

        // 5. GET / POST /api/location/validate
        if (pathname === '/api/location/validate') {
          let lat, lon;
          if (req.method === 'GET') {
            lat = parseFloat(urlObj.searchParams.get('lat'));
            lon = parseFloat(urlObj.searchParams.get('lon'));
          } else if (req.method === 'POST') {
            const body = await parseJsonBody();
            lat = parseFloat(body?.latitude ?? body?.lat);
            lon = parseFloat(body?.longitude ?? body?.lon);
          }

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return sendJson(400, { error: 'Valid latitude and longitude are required' });
          }

          const classification = classifyPointTerrain(lat, lon);
          return sendJson(200, {
            status: 'success',
            latitude: lat,
            longitude: lon,
            ...classification,
          });
        }

        // 6. POST /api/sea-ice/profile
        if (req.method === 'POST' && pathname === '/api/sea-ice/profile') {
          await loadSeaIceDataset();
          const body = await parseJsonBody();
          if (!body || !Array.isArray(body.points)) {
            return sendJson(400, { error: 'Request body must contain a "points" array of {latitude, longitude}' });
          }
          const profile = getSeaIceProfile(body.points);
          return sendJson(200, {
            status: 'success',
            observation_date: DATASET_METADATA.date,
            point_count: profile.length,
            profile,
          });
        }

        // 7. POST /api/route/calculate
        if (req.method === 'POST' && pathname === '/api/route/calculate') {
          const body = await parseJsonBody();
          if (!body) {
            return sendJson(400, { error: 'Invalid JSON request body' });
          }

          const {
            start,
            destination,
            mode = 'balanced',
            max_sea_ice_concentration = null,
            safety_buffer_km = 5.0,
            multi_route = false,
          } = body;

          if (multi_route) {
            const multiRes = await calculateMultiRouteOptions({
              start,
              destination,
              max_sea_ice_concentration,
              safety_buffer_km,
            });
            return sendJson(200, multiRes);
          }

          const routeRes = await calculateMaritimeRoute({
            start,
            destination,
            mode,
            max_sea_ice_concentration,
            safety_buffer_km,
          });

          if (
            routeRes.status === 'LAND_ENDPOINT' ||
            routeRes.status === 'NO_SAFE_ROUTE' ||
            routeRes.status === 'NO_FEASIBLE_MARITIME_ROUTE'
          ) {
            return sendJson(422, routeRes);
          }

          return sendJson(200, routeRes);
        }

        // 8. POST /api/route/guidance
        if (req.method === 'POST' && pathname === '/api/route/guidance') {
          const body = await parseJsonBody();
          if (!body || !body.route) {
            return sendJson(400, { error: 'Request body must contain "route" object' });
          }
          const guidance = calculateVoyageGuidance(body.route, body.vesselState || null, body.options || {});
          return sendJson(200, {
            status: 'success',
            guidance,
          });
        }

        // 9. POST /api/oceanembed/predict (Proxy to local ML service if running, else clean fallback)
        if (req.method === 'POST' && pathname === '/api/oceanembed/predict') {
          const body = await parseJsonBody();
          try {
            const response = await fetch('http://127.0.0.1:8000/predict', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body || {}),
              signal: AbortSignal.timeout(1500),
            });
            if (response.ok) {
              const data = await response.json();
              return sendJson(200, data);
            }
          } catch {
            // External Python ML model server not currently running on port 8000
          }

          // Return honest status reporting that backend service is offline
          const lat = body?.latitude ?? 15.0;
          const lon = body?.longitude ?? 65.0;
          const depthIdx = body?.selectedDepth ?? 0;
          return sendJson(200, {
            status: 'offline_notice',
            service_available: false,
            message: 'OceanEmbed Python ML model server (http://127.0.0.1:8000) is currently offline.',
            location: { latitude: lat, longitude: lon },
            date: body?.date || new Date().toISOString().split('T')[0],
            selectedDepth: depthIdx,
            selectedTemperature: null,
            profile: [],
            validation: { rmse: null, bias: null, correlation: null },
            reference: { glorys: null, argo: null },
          });
        }

        next();
      });
  };

  return {
    name: 'sea-ice-routing-proxy',
    configureServer: configure,
    configurePreviewServer: configure,
  };
}

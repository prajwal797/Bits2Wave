import test from 'node:test';
import assert from 'node:assert/strict';
import { seaIceRoutingProxy } from './seaIce.js';

test('seaIceRoutingProxy provides valid routes and status metadata', async () => {
  const proxy = seaIceRoutingProxy();
  assert.equal(proxy.name, 'sea-ice-routing-proxy');

  let middleware = null;
  const mockServer = {
    middlewares: {
      use(fn) {
        middleware = fn;
      },
    },
  };

  proxy.configureServer(mockServer);
  assert.ok(middleware, 'Middleware should be attached');

  // Test helper
  const invoke = (method, path, body = null) => {
    return new Promise((resolve) => {
      const chunks = [];
      let status = 200;
      let headers = {};

      const req = {
        method,
        url: path,
        headers: { host: 'localhost:3000' },
        async *[Symbol.asyncIterator]() {
          if (body) {
            yield Buffer.from(JSON.stringify(body));
          }
        },
      };

      const res = {
        statusCode: 200,
        setHeader(k, v) {
          headers[k] = v;
        },
        end(data) {
          this.statusCode = status;
          resolve({
            status: this.statusCode,
            headers,
            body: data ? JSON.parse(data) : null,
          });
        },
      };
      Object.defineProperty(res, 'statusCode', {
        get() {
          return status;
        },
        set(s) {
          status = s;
        },
      });

      middleware(req, res, () => {
        resolve({ passedToNext: true });
      });
    });
  };

  // 1. Test status
  const statusRes = await invoke('GET', '/api/sea-ice/status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.observation_date, '2026-01-01');
  assert.equal(statusRes.body.total_records, 83019);

  // 2. Test modes
  const modesRes = await invoke('GET', '/api/route/modes');
  assert.equal(modesRes.status, 200);
  assert.ok(Array.isArray(modesRes.body.modes));
  assert.ok(modesRes.body.modes.length >= 4);

  // 3. Test profiles
  const profilesRes = await invoke('GET', '/api/vessel/profiles');
  assert.equal(profilesRes.status, 200);
  assert.equal(profilesRes.body.default, 'polar_icebreaker');

  // 4. Test route calculate
  const routeRes = await invoke('POST', '/api/route/calculate', {
    start: { latitude: -64.8, longitude: -64.0 },
    destination: { latitude: -64.7, longitude: -63.5 },
    mode: 'shortest',
  });
  assert.equal(routeRes.status, 200);
  assert.equal(routeRes.body.status, 'success');
  assert.ok(routeRes.body.waypoints.length >= 2);
  assert.ok(routeRes.body.metrics.distance_km > 0);
});

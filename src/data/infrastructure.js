import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { INFRASTRUCTURE_DATA_URLS } from '../sources/infrastructureData.js';

/**
 * Create fresh datacenter and dam layers without starting or loading them.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Datacenters then dams, with stable standalone identities.
 */
export function createInfrastructureLayers(services) {
  const datacentersUrl = INFRASTRUCTURE_DATA_URLS['local-datacenters'];
  const damsUrl = INFRASTRUCTURE_DATA_URLS['local-dams'];
  const icebergsUrl = INFRASTRUCTURE_DATA_URLS['local-icebergs'];
  const icebergsFullUrl = INFRASTRUCTURE_DATA_URLS['local-icebergs-full'];
  const datacenters = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      url: datacentersUrl,
      name: 'Datacenters',
      color: '#00ffff', // Cyan
      icon: '▣',
      source: 'Local',
      osmDerived: true,
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  const dams = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: damsUrl,
      name: 'Dams',
      color: '#0088ff', // Blue
      icon: '▰',
      source: 'OpenStreetMap / OpenInfraMap',
      osmDerived: true,
      labels: true,
      labelMax: 900,
      labelGridPx: 132,
    },
    services,
  );

  const icebergs = createLocalGeoJsonLayer(
    {
      id: 'local-icebergs',
      url: icebergsUrl,
      name: 'Icebergs',
      color: '#00e5ff', // Icy cyan
      icon: '🧊',
      source: 'Antarctic Grounded Iceberg Detection',
      labels: true,
      labelMax: 200,
      labelGridPx: 120,
    },
    services,
  );

  const icebergsFull = createLocalGeoJsonLayer(
    {
      id: 'local-icebergs-full',
      url: icebergsFullUrl,
      name: 'Icebergs (Full Dataset)',
      color: '#00e5ff', // Icy cyan
      icon: '🧊',
      source: 'Antarctic Grounded Iceberg Sentinel-1 v1.2',
      labels: false,
      stems: false,
    },
    services,
  );

  return [datacenters, dams, icebergs, icebergsFull];
}

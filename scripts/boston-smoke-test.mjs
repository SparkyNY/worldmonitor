#!/usr/bin/env node

const DATASETS = [
  {
    id: 'crimeIncidents',
    url: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Boston_Incidents_Public_v2_view/FeatureServer/0/query',
    params: { where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 10, f: 'geojson' },
    required: true,
  },
  {
    id: 'fireIncidents',
    url: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Boston_Incidents_View/FeatureServer/0/query',
    params: { where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 10, f: 'geojson' },
    required: true,
  },
  {
    id: 'policeDistricts',
    url: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Police_Districts/FeatureServer/0/query',
    params: { where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 10, f: 'geojson' },
    required: true,
  },
  {
    id: 'fireHydrants',
    url: null,
    params: {},
    required: false,
    note: 'Stubbed until a stable public hydrant endpoint is configured.',
  },
  {
    id: 'fireDepartments',
    url: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/BFD_Firehouse/FeatureServer/0/query',
    params: { where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 10, f: 'geojson' },
    required: true,
  },
  {
    id: 'communityCenters',
    url: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Community_Centers/FeatureServer/0/query',
    params: { where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 10, f: 'geojson' },
    required: true,
  },
];

async function fetchDataset(dataset) {
  if (!dataset.url) {
    return {
      id: dataset.id,
      ok: !dataset.required,
      count: 0,
      warning: dataset.note || 'No URL configured',
    };
  }

  const query = new URLSearchParams(Object.entries(dataset.params).map(([k, v]) => [k, String(v)]));
  const started = Date.now();
  const response = await fetch(`${dataset.url}?${query.toString()}`);
  const elapsed = Date.now() - started;

  if (!response.ok) {
    return {
      id: dataset.id,
      ok: false,
      count: 0,
      error: `HTTP ${response.status}`,
      elapsed,
    };
  }

  const payload = await response.json();
  const count = Array.isArray(payload?.features) ? payload.features.length : 0;
  return {
    id: dataset.id,
    ok: count > 0 || !dataset.required,
    count,
    elapsed,
  };
}

const results = [];
for (const dataset of DATASETS) {
  try {
    // eslint-disable-next-line no-await-in-loop
    const result = await fetchDataset(dataset);
    results.push(result);
  } catch (error) {
    results.push({ id: dataset.id, ok: false, count: 0, error: error instanceof Error ? error.message : String(error) });
  }
}

const failed = results.filter((r) => !r.ok);
for (const row of results) {
  const state = row.ok ? 'OK' : 'FAIL';
  const detail = row.error ? `error=${row.error}` : row.warning ? `warning=${row.warning}` : `count=${row.count}`;
  const timing = row.elapsed != null ? ` ${row.elapsed}ms` : '';
  console.log(`[${state}] ${row.id} ${detail}${timing}`);
}

if (failed.length > 0) {
  console.error(`\nBoston smoke test failed for ${failed.length} dataset(s).`);
  process.exit(1);
}

console.log('\nBoston smoke test passed.');

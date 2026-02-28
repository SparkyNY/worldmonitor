import { getPersistentCache, setPersistentCache } from './persistent-cache';

export type BostonDatasetId =
  | 'crimeIncidents'
  | 'fireIncidents'
  | 'policeDistricts'
  | 'fireHydrants'
  | 'fireDepartments'
  | 'communityCenters';

export type BostonLayerId = 'policeDistricts' | 'fireHydrants' | 'fireDepartments' | 'communityCenters';

export interface BostonProvenance {
  datasetId: BostonDatasetId;
  sourceUrl: string;
  fetchedAt: string;
  recordCount: number;
  queryParams: Record<string, string | number | boolean>;
  warnings: string[];
}

export interface BostonIncident {
  id: string;
  dataset: 'crime' | 'fire';
  incidentNumber: string;
  typeCode: string;
  sourceCategory: string;
  date: string | null;
  dateTimeReported: string | null;
  description: string;
  district: string;
  incidentType: string;
  address: string;
  lat: number | null;
  lon: number | null;
  raw: Record<string, unknown>;
}

export interface BostonLayerData {
  type: 'FeatureCollection';
  features: GeoJSON.Feature[];
}

export interface BostonDatasetPayload {
  incidents?: BostonIncident[];
  layer?: BostonLayerData;
  provenance: BostonProvenance;
}

interface ArcGisDatasetConfig {
  id: BostonDatasetId;
  sourceUrl: string;
  mode: 'incident' | 'layer' | 'stub';
  queryParams?: Record<string, string | number | boolean>;
  pageSize?: number;
  maxPages?: number;
  maxRecords?: number;
  datasetTag?: 'crime' | 'fire';
  warning?: string;
}

const CACHE_PREFIX = 'boston-open-data';
const DEFAULT_PAGE_SIZE = 1000;

const DATASETS: Record<BostonDatasetId, ArcGisDatasetConfig> = {
  crimeIncidents: {
    id: 'crimeIncidents',
    sourceUrl: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Boston_Incidents_Public_v2_view/FeatureServer/0/query',
    mode: 'incident',
    datasetTag: 'crime',
    pageSize: 500,
    maxPages: 8,
    maxRecords: 4000,
    queryParams: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
      orderByFields: 'occurred_on_date DESC, objectid DESC',
    },
  },
  fireIncidents: {
    id: 'fireIncidents',
    sourceUrl: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Boston_Incidents_View/FeatureServer/0/query',
    mode: 'incident',
    datasetTag: 'fire',
    pageSize: 500,
    maxPages: 8,
    maxRecords: 4000,
    queryParams: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
      orderByFields: 'incident_date DESC, objectid DESC',
    },
  },
  policeDistricts: {
    id: 'policeDistricts',
    sourceUrl: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Police_Districts/FeatureServer/0/query',
    mode: 'layer',
    pageSize: 500,
    queryParams: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
    },
  },
  fireHydrants: {
    id: 'fireHydrants',
    sourceUrl: 'https://data.boston.gov/',
    mode: 'stub',
    warning: 'Stable public hydrant endpoint not resolved yet. Add Analyze Boston or BostonMaps FeatureServer URL in src/services/boston-open-data.ts (fireHydrants config).',
  },
  fireDepartments: {
    id: 'fireDepartments',
    sourceUrl: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/BFD_Firehouse/FeatureServer/0/query',
    mode: 'layer',
    pageSize: 500,
    queryParams: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
    },
  },
  communityCenters: {
    id: 'communityCenters',
    sourceUrl: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Community_Centers/FeatureServer/0/query',
    mode: 'layer',
    pageSize: 500,
    queryParams: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
    },
  },
};

function toStringRecord(value: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function pickString(properties: Record<string, unknown>, candidates: string[]): string {
  for (const key of candidates) {
    const direct = properties[key];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    const lower = Object.keys(properties).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!lower) continue;
    const value = properties[lower];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function pickDateString(properties: Record<string, unknown>, candidates: string[]): string | null {
  for (const key of candidates) {
    const direct = properties[key] ?? properties[Object.keys(properties).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ''];
    if (direct == null) continue;

    if (typeof direct === 'number') {
      const maybeDate = new Date(direct);
      if (!Number.isNaN(maybeDate.getTime())) return maybeDate.toISOString();
    }

    if (typeof direct === 'string' && direct.trim()) {
      const parsed = new Date(direct);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      return direct;
    }
  }

  return null;
}

function getFeatureCoordinates(feature: GeoJSON.Feature): { lat: number | null; lon: number | null } {
  const geometry = feature.geometry;
  if (!geometry) return { lat: null, lon: null };

  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const lon = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const lat = Number(pickString(props, ['latitude', 'lat', 'y', 'LATITUDE']));
  const lon = Number(pickString(props, ['longitude', 'lon', 'lng', 'x', 'LONGITUDE']));
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

function isLikelyFireIncident(properties: Record<string, unknown>): boolean {
  const haystack = [
    pickString(properties, ['offense_description', 'OFFENSE_DESCRIPTION']),
    pickString(properties, ['nature', 'NATURE']),
    pickString(properties, ['incident_type_description', 'INCIDENT_TYPE_DESCRIPTION']),
    pickString(properties, ['incident_type', 'INCIDENT_TYPE']),
    pickString(properties, ['department', 'DEPARTMENT']),
    pickString(properties, ['agency', 'AGENCY']),
  ]
    .join(' ')
    .toLowerCase();

  return /(fire|alarm|smoke|burn|hazmat|rescue)/.test(haystack);
}

function normalizeIncidentFeature(feature: GeoJSON.Feature, datasetTag: 'crime' | 'fire'): BostonIncident {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const { lat, lon } = getFeatureCoordinates(feature);
  const date = pickDateString(properties, [
    'occurred_on_date',
    'incident_date',
    'dispatch_date',
    'fromdate',
    'open_dt',
    'date',
    'offense_date',
  ]);

  const incidentType = pickString(properties, [
    'incident_type_description',
    'incident_type',
    'offense_code_group',
    'offense_code_name',
    'nature',
    'service',
  ]);

  const description = pickString(properties, [
    'offense_description',
    'offense_code_name',
    'description',
    'nature',
    'comments',
    'incident_type_description',
  ]);

  const incidentNumber = pickString(properties, [
    'incident_number',
    'INCIDENT_NUMBER',
    'incidentnum',
    'INCIDENTNUM',
    'case_number',
    'CASE_NUMBER',
    'objectid',
    'OBJECTID',
  ]);

  const typeCode = pickString(properties, [
    'offense_code',
    'OFFENSE_CODE',
    'incident_type',
    'INCIDENT_TYPE',
    'nature_code',
    'NATURE_CODE',
  ]);

  const dateTimeReported = pickDateString(properties, [
    'occurred_on_date',
    'incident_date',
    'dispatch_date',
    'report_date',
    'open_dt',
    'date',
  ]);

  const district = pickString(properties, ['district', 'police_district', 'reporting_area', 'precinct']) || 'Unknown';
  const address = pickString(properties, ['street', 'streetname', 'location', 'address']) || 'Unknown location';

  const objectId = pickString(properties, ['objectid', 'OBJECTID', 'incident_number', 'INCIDENT_NUMBER']);
  const id = incidentNumber || objectId || `${datasetTag}-${address}-${date ?? 'no-date'}-${typeCode || 'na'}`;

  return {
    id,
    dataset: datasetTag,
    incidentNumber: incidentNumber || objectId || 'N/A',
    typeCode: typeCode || 'N/A',
    sourceCategory: incidentType || 'Uncategorized',
    date,
    dateTimeReported,
    description: description || incidentType || 'No description',
    district,
    incidentType: incidentType || 'Unknown',
    address,
    lat,
    lon,
    raw: properties,
  };
}

function normalizeIncidentFeatures(features: GeoJSON.Feature[], datasetTag: 'crime' | 'fire'): BostonIncident[] {
  const normalized = features.map((feature) => normalizeIncidentFeature(feature, datasetTag));
  if (datasetTag === 'fire') {
    return normalized.filter((incident) => {
      const raw = incident.raw;
      return isLikelyFireIncident(raw);
    });
  }
  return normalized;
}

function layerCollection(features: GeoJSON.Feature[]): BostonLayerData {
  return {
    type: 'FeatureCollection',
    features,
  };
}

function cacheKey(datasetId: BostonDatasetId): string {
  return `${CACHE_PREFIX}:${datasetId}`;
}

async function fetchArcGisCount(sourceUrl: string, queryParams: Record<string, string | number | boolean>): Promise<number | null> {
  const params = new URLSearchParams({
    ...toStringRecord(queryParams),
    returnCountOnly: 'true',
    f: 'json',
  });

  const response = await fetch(`${sourceUrl}?${params.toString()}`);
  if (!response.ok) return null;

  const payload = await response.json() as { count?: number };
  return typeof payload.count === 'number' ? payload.count : null;
}

async function fetchArcGisPage(
  sourceUrl: string,
  queryParams: Record<string, string | number | boolean>,
  offset: number,
  limit: number,
): Promise<{ features: GeoJSON.Feature[]; exceededTransferLimit?: boolean }> {
  const params = new URLSearchParams({
    ...toStringRecord(queryParams),
    resultOffset: String(offset),
    resultRecordCount: String(limit),
    f: 'geojson',
  });

  const response = await fetch(`${sourceUrl}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`ArcGIS request failed (${response.status})`);
  }

  const payload = await response.json() as {
    features?: GeoJSON.Feature[];
    exceededTransferLimit?: boolean;
  };

  return {
    features: Array.isArray(payload.features) ? payload.features : [],
    exceededTransferLimit: payload.exceededTransferLimit,
  };
}

async function fetchArcGisFeatureCollection(config: ArcGisDatasetConfig): Promise<{ layer: BostonLayerData; warnings: string[]; queryParams: Record<string, string | number | boolean> }> {
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = config.maxPages ?? 100;
  const maxRecords = config.maxRecords ?? Number.POSITIVE_INFINITY;
  const queryParams = {
    where: '1=1',
    outFields: '*',
    returnGeometry: true,
    outSR: 4326,
    ...(config.queryParams ?? {}),
  };

  const warnings: string[] = [];
  const count = await fetchArcGisCount(config.sourceUrl, queryParams);
  if (count == null) {
    warnings.push('Could not retrieve total count from ArcGIS service (using page-length termination).');
  }

  let offset = 0;
  const allFeatures: GeoJSON.Feature[] = [];
  let hasMore = true;
  let pageGuard = 0;
  let sawExceededTransferLimit = false;

  while (hasMore && pageGuard < maxPages) {
    pageGuard += 1;
    const page = await fetchArcGisPage(config.sourceUrl, queryParams, offset, pageSize);
    const featureCount = page.features.length;
    const remaining = Math.max(0, maxRecords - allFeatures.length);
    allFeatures.push(...page.features.slice(0, remaining));
    if (page.exceededTransferLimit) sawExceededTransferLimit = true;

    if (allFeatures.length >= maxRecords) {
      warnings.push(`Record fetch bounded at ${maxRecords} records for responsive local usage.`);
      hasMore = false;
    } else if (featureCount < pageSize && !page.exceededTransferLimit) {
      hasMore = false;
    } else if (count != null && allFeatures.length >= count) {
      hasMore = false;
    } else {
      offset += pageSize;
    }
  }

  if (pageGuard >= maxPages) {
    warnings.push(`Pagination capped at ${maxPages} pages to protect local runtime.`);
  }
  if (sawExceededTransferLimit) {
    warnings.push('ArcGIS reported exceededTransferLimit during paging; additional pages were requested automatically.');
  }

  return {
    layer: layerCollection(allFeatures),
    warnings,
    queryParams: {
      ...queryParams,
      pageSize,
    },
  };
}

export async function getCachedBostonDataset(datasetId: BostonDatasetId): Promise<BostonDatasetPayload | null> {
  const cached = await getPersistentCache<BostonDatasetPayload>(cacheKey(datasetId));
  return cached?.data ?? null;
}

export async function refreshBostonDataset(datasetId: BostonDatasetId): Promise<BostonDatasetPayload> {
  const config = DATASETS[datasetId];
  if (!config) {
    throw new Error(`Unknown Boston dataset: ${datasetId}`);
  }

  const fetchedAt = new Date().toISOString();

  if (config.mode === 'stub') {
    const payload: BostonDatasetPayload = {
      layer: { type: 'FeatureCollection', features: [] },
      provenance: {
        datasetId,
        sourceUrl: config.sourceUrl,
        fetchedAt,
        recordCount: 0,
        queryParams: {},
        warnings: config.warning ? [config.warning] : ['Dataset configured as stub.'],
      },
    };
    await setPersistentCache(cacheKey(datasetId), payload);
    return payload;
  }

  const { layer, warnings, queryParams } = await fetchArcGisFeatureCollection(config);

  let payload: BostonDatasetPayload;
  if (config.mode === 'incident') {
    const incidents = normalizeIncidentFeatures(layer.features, config.datasetTag ?? 'crime');
    payload = {
      incidents,
      provenance: {
        datasetId,
        sourceUrl: config.sourceUrl,
        fetchedAt,
        recordCount: incidents.length,
        queryParams,
        warnings,
      },
    };

    if (config.datasetTag === 'fire' && incidents.length === 0) {
      payload.provenance.warnings.push('No fire incidents matched heuristic filters. Review fire endpoint fields in src/services/boston-open-data.ts.');
    }
  } else {
    payload = {
      layer,
      provenance: {
        datasetId,
        sourceUrl: config.sourceUrl,
        fetchedAt,
        recordCount: layer.features.length,
        queryParams,
        warnings,
      },
    };
  }

  await setPersistentCache(cacheKey(datasetId), payload);
  return payload;
}

export async function refreshAllBostonDatasets(): Promise<Record<BostonDatasetId, BostonDatasetPayload>> {
  const ids = Object.keys(DATASETS) as BostonDatasetId[];
  const entries = await Promise.all(ids.map(async (id) => {
    const payload = await refreshBostonDataset(id);
    return [id, payload] as const;
  }));

  return Object.fromEntries(entries) as Record<BostonDatasetId, BostonDatasetPayload>;
}

export async function getCachedBostonBundle(): Promise<Partial<Record<BostonDatasetId, BostonDatasetPayload>>> {
  const ids = Object.keys(DATASETS) as BostonDatasetId[];
  const entries = await Promise.all(ids.map(async (id) => {
    const cached = await getCachedBostonDataset(id);
    return [id, cached] as const;
  }));

  const bundle: Partial<Record<BostonDatasetId, BostonDatasetPayload>> = {};
  for (const [id, data] of entries) {
    if (data) bundle[id] = data;
  }
  return bundle;
}

export function getBostonDatasetSource(datasetId: BostonDatasetId): string {
  return DATASETS[datasetId]?.sourceUrl ?? '';
}

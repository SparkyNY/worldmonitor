import { getPersistentCache, setPersistentCache } from './persistent-cache';

export type LocalTransitDatasetId = 'transitStatus';
export type LocalTransitMode = 'subway' | 'bus' | 'commuter_rail' | 'ferry' | 'amtrak';
export type LocalTransitAlertSeverity = 'info' | 'minor' | 'major' | 'severe';

export interface LocalTransitVehicle {
  id: string;
  mode: Exclude<LocalTransitMode, 'amtrak'>;
  routeId: string;
  routeLabel: string;
  status: string;
  lat: number;
  lon: number;
  bearing: number | null;
  updatedAt: string | null;
}

export interface LocalTransitLine {
  id: string;
  mode: Exclude<LocalTransitMode, 'amtrak'>;
  routeId: string;
  routeLabel: string;
  color: string;
  textColor: string;
  path: Array<[number, number]>;
  source: 'mbta_shape' | 'vehicle_synthetic';
}

export interface LocalTransitAlert {
  id: string;
  source: 'mbta' | 'amtrak';
  mode: LocalTransitMode;
  title: string;
  description: string;
  severity: LocalTransitAlertSeverity;
  updatedAt: string | null;
  url: string;
}

export interface LocalTransitSummary {
  mode: LocalTransitMode;
  label: string;
  vehicleCount: number;
  alertCount: number;
  status: string;
}

export interface LocalTransitProvenance {
  datasetId: LocalTransitDatasetId;
  sourceUrl: string;
  fetchedAt: string;
  recordCount: number;
  queryParams: Record<string, string | number | boolean>;
  warnings: string[];
}

export interface LocalTransitPayload {
  vehicles: LocalTransitVehicle[];
  lines: LocalTransitLine[];
  alerts: LocalTransitAlert[];
  summaries: LocalTransitSummary[];
  provenance: LocalTransitProvenance;
}

interface MbtaResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

interface MbtaResponse {
  data?: MbtaResource[];
  included?: MbtaResource[];
}

type JsonRecord = Record<string, unknown>;

const CACHE_KEY = 'local-transit:status';
const MBTA_BASE_URL = 'https://api-v3.mbta.com';
const MBTA_VEHICLES_URL = `${MBTA_BASE_URL}/vehicles`;
const MBTA_ROUTES_URL = `${MBTA_BASE_URL}/routes`;
const MBTA_SHAPES_URL = `${MBTA_BASE_URL}/shapes`;
const MBTA_ALERTS_URL = `${MBTA_BASE_URL}/alerts`;
const MBTA_GTFS_VEHICLES_ENHANCED_URL = 'https://cdn.mbta.com/realtime/VehiclePositions_enhanced.json';
const MBTA_GTFS_ALERTS_ENHANCED_URL = 'https://cdn.mbta.com/realtime/Alerts_enhanced.json';
const BOSTON_LAT = 42.3601;
const BOSTON_LON = -71.0589;
const BOSTON_RADIUS_KM = 45;
const ROUTE_TYPES = '0,1,2,3,4';
const MBTA_API_KEY = import.meta.env.VITE_MBTA_API_KEY?.trim() || '';
const AMTRAK_FEED_OVERRIDE = import.meta.env.VITE_AMTRAK_ALERTS_RSS_URL?.trim() || '';
const AMTRAK_KEYWORDS = [
  'boston',
  'south station',
  'back bay',
  'route 128',
  'westwood',
  'downeaster',
  'north station',
  'acela',
  'northeast regional',
  'lake shore limited',
];
const AMTRAK_DEFAULT_FEEDS = [
  'https://www.amtrak.com/content/amtrak/en-us/service-alerts/rss.xml',
  'https://www.amtrak.com/content/amtrak/en-us/service-alerts-and-notices/rss.xml',
];
const AMTRAK_FEED_CANDIDATES = Array.from(new Set([
  ...(AMTRAK_FEED_OVERRIDE ? [AMTRAK_FEED_OVERRIDE] : []),
  ...AMTRAK_DEFAULT_FEEDS,
]));

function toStringParams(params: Record<string, string | number | boolean | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const text = String(value).trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function modeFromRouteType(routeType: number | null): Exclude<LocalTransitMode, 'amtrak'> | null {
  if (routeType === 0 || routeType === 1) return 'subway';
  if (routeType === 2) return 'commuter_rail';
  if (routeType === 3) return 'bus';
  if (routeType === 4) return 'ferry';
  return null;
}

function modeFromRouteId(routeId: string): Exclude<LocalTransitMode, 'amtrak'> | null {
  const normalized = routeId.trim().toUpperCase();
  if (!normalized) return null;

  if (
    normalized === 'RED'
    || normalized === 'ORANGE'
    || normalized === 'BLUE'
    || normalized.startsWith('GREEN-')
    || normalized === 'MATTAPAN'
  ) {
    return 'subway';
  }
  if (normalized.startsWith('CR-')) return 'commuter_rail';
  if (normalized.startsWith('FERRY') || normalized.startsWith('BOAT-') || normalized === 'F1') return 'ferry';
  return 'bus';
}

function modeLabel(mode: LocalTransitMode): string {
  switch (mode) {
    case 'subway':
      return 'Subway';
    case 'bus':
      return 'Bus';
    case 'commuter_rail':
      return 'Commuter Rail';
    case 'ferry':
      return 'Ferry';
    case 'amtrak':
      return 'Amtrak';
  }
}

function modeColor(mode: Exclude<LocalTransitMode, 'amtrak'>): string {
  switch (mode) {
    case 'subway':
      return '#e74c3c';
    case 'bus':
      return '#2e86de';
    case 'commuter_rail':
      return '#8e44ad';
    case 'ferry':
      return '#16a085';
  }
}

function normalizeHexColor(value: unknown, fallback: string): string {
  const raw = textOrEmpty(value).replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) return `#${raw}`;
  if (/^[0-9A-F]{3}$/.test(raw)) return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  return fallback;
}

function severityFromMbta(raw: unknown): LocalTransitAlertSeverity {
  const severity = toNumber(raw);
  if (severity == null) return 'minor';
  if (severity >= 9) return 'severe';
  if (severity >= 7) return 'major';
  if (severity >= 4) return 'minor';
  return 'info';
}

function severityFromHeadline(text: string): LocalTransitAlertSeverity {
  const lower = text.toLowerCase();
  if (/(suspend|cancel|severe|emergency|major)/.test(lower)) return 'severe';
  if (/(delay|disruption|bypass|issue|service change)/.test(lower)) return 'major';
  if (/(advisory|detour|maintenance|track work)/.test(lower)) return 'minor';
  return 'info';
}

function extractText(node: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const element = node.querySelector(selector);
    const value = element?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function parseGtfsTranslatedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const obj = asRecord(value);
  if (!obj) return '';

  const direct = textOrEmpty(obj.text);
  if (direct) return direct;

  const translations = Array.isArray(obj.translation) ? obj.translation : [];
  for (const item of translations) {
    const row = asRecord(item);
    const text = textOrEmpty(row?.text);
    if (text) return text;
  }
  return '';
}

function isBostonRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return AMTRAK_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function sortByModeThenRoute(a: LocalTransitVehicle, b: LocalTransitVehicle): number {
  const modeRank: Record<LocalTransitVehicle['mode'], number> = {
    subway: 1,
    commuter_rail: 2,
    bus: 3,
    ferry: 4,
  };

  const modeDiff = modeRank[a.mode] - modeRank[b.mode];
  if (modeDiff !== 0) return modeDiff;
  return a.routeLabel.localeCompare(b.routeLabel);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
}

function isWithinBostonRadius(lat: number, lon: number): boolean {
  return haversineKm(lat, lon, BOSTON_LAT, BOSTON_LON) <= BOSTON_RADIUS_KM;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function decodePolyline(encoded: string): Array<[number, number]> {
  if (!encoded) return [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: Array<[number, number]> = [];

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      if (index >= encoded.length) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;

    shift = 0;
    result = 0;
    do {
      if (index >= encoded.length) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLon = (result & 1) ? ~(result >> 1) : (result >> 1);
    lon += deltaLon;

    coordinates.push([lon / 1e5, lat / 1e5]);
  }

  return coordinates;
}

function isPathBostonRelevant(path: Array<[number, number]>): boolean {
  return path.some(([lon, lat]) => isWithinBostonRadius(lat, lon));
}

function parseMbtaError(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed) as { errors?: Array<{ detail?: string; title?: string; source?: { parameter?: string } }> };
    const first = parsed.errors?.[0];
    if (!first) return '';
    const detail = first.detail || first.title || '';
    const parameter = first.source?.parameter ? ` (param: ${first.source.parameter})` : '';
    return `${detail}${parameter}`.trim();
  } catch {
    return trimmed.replace(/\s+/g, ' ').slice(0, 180);
  }
}

async function fetchMbtaJson(url: string, query: Record<string, string | number | boolean | undefined>): Promise<MbtaResponse> {
  const params = new URLSearchParams(toStringParams(query));
  const response = await fetch(`${url}?${params.toString()}`);
  if (!response.ok) {
    const body = await response.text();
    const detail = parseMbtaError(body);
    throw new Error(`MBTA request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return await response.json() as MbtaResponse;
}

async function fetchJson(url: string): Promise<JsonRecord> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const payload = await response.json();
  const obj = asRecord(payload);
  if (!obj) throw new Error('JSON payload was not an object');
  return obj;
}

function normalizeVehiclesFromMbtaV3(payload: MbtaResponse): LocalTransitVehicle[] {
  const routeById = new Map<string, MbtaResource>();
  for (const included of payload.included ?? []) {
    if (included.type === 'route') routeById.set(included.id, included);
  }

  const vehicles: LocalTransitVehicle[] = [];
  for (const row of payload.data ?? []) {
    if (row.type !== 'vehicle') continue;

    const attrs = row.attributes ?? {};
    const lat = toNumber(attrs.latitude);
    const lon = toNumber(attrs.longitude);
    if (lat == null || lon == null) continue;

    const routeRel = row.relationships?.route?.data;
    const routeId = routeRel?.id ?? '';
    const route = routeById.get(routeId);
    const routeAttrs = route?.attributes ?? {};
    const mode = modeFromRouteType(toNumber(routeAttrs.route_type)) ?? modeFromRouteId(routeId);
    if (!mode) continue;

    const routeLabelValue = routeAttrs.short_name ?? routeAttrs.long_name;
    const routeLabel = String(routeLabelValue || routeId || 'Unknown route');
    const status = String(attrs.current_status ?? attrs.current_stop_sequence ?? 'IN_TRANSIT_TO');

    vehicles.push({
      id: row.id,
      mode,
      routeId: routeId || row.id,
      routeLabel,
      status,
      lat,
      lon,
      bearing: toNumber(attrs.bearing),
      updatedAt: toIsoDate(attrs.updated_at),
    });
  }

  return vehicles;
}

function normalizeVehiclesFromGtfsEnhanced(payload: JsonRecord): LocalTransitVehicle[] {
  const entities = Array.isArray(payload.entity) ? payload.entity : [];
  const vehicles: LocalTransitVehicle[] = [];

  for (const entityRaw of entities) {
    const entity = asRecord(entityRaw);
    const vehicle = asRecord(entity?.vehicle);
    if (!vehicle) continue;

    const position = asRecord(vehicle.position);
    const trip = asRecord(vehicle.trip);
    const lat = toNumber(position?.latitude ?? vehicle.latitude);
    const lon = toNumber(position?.longitude ?? vehicle.longitude);
    if (lat == null || lon == null) continue;

    const routeId = textOrEmpty(trip?.route_id) || textOrEmpty(vehicle.route_id) || textOrEmpty(entity?.id);
    const mode = modeFromRouteType(toNumber(trip?.route_type ?? vehicle.route_type)) ?? modeFromRouteId(routeId);
    if (!mode) continue;

    const status = textOrEmpty(vehicle.current_status) || textOrEmpty(vehicle.currentStatus) || 'IN_TRANSIT_TO';
    const timestamp = vehicle.timestamp ?? entity?.timestamp;

    vehicles.push({
      id: textOrEmpty(entity?.id) || `gtfs-${routeId}-${lat}-${lon}`,
      mode,
      routeId: routeId || 'unknown',
      routeLabel: routeId || 'Unknown route',
      status,
      lat,
      lon,
      bearing: toNumber(position?.bearing ?? vehicle.bearing),
      updatedAt: toIsoDate(timestamp),
    });
  }

  return vehicles;
}

function filterBostonVehicles(vehicles: LocalTransitVehicle[]): LocalTransitVehicle[] {
  return vehicles.filter((vehicle) => isWithinBostonRadius(vehicle.lat, vehicle.lon));
}

function buildSyntheticLinesFromVehicles(vehicles: LocalTransitVehicle[]): LocalTransitLine[] {
  const byRoute = new Map<string, LocalTransitVehicle[]>();
  for (const vehicle of vehicles) {
    if (!vehicle.routeId) continue;
    const rows = byRoute.get(vehicle.routeId) ?? [];
    rows.push(vehicle);
    byRoute.set(vehicle.routeId, rows);
  }

  const lines: LocalTransitLine[] = [];
  for (const [routeId, rows] of byRoute) {
    if (rows.length < 2) continue;
    const lonSpread = Math.max(...rows.map((r) => r.lon)) - Math.min(...rows.map((r) => r.lon));
    const latSpread = Math.max(...rows.map((r) => r.lat)) - Math.min(...rows.map((r) => r.lat));
    const sorted = [...rows].sort((a, b) => (lonSpread >= latSpread ? a.lon - b.lon : a.lat - b.lat));
    const path = sorted.map((row) => [row.lon, row.lat] as [number, number]);
    const mode = rows[0]!.mode;
    lines.push({
      id: `synthetic-${routeId}`,
      mode,
      routeId,
      routeLabel: rows[0]!.routeLabel || routeId,
      color: modeColor(mode),
      textColor: '#FFFFFF',
      path,
      source: 'vehicle_synthetic',
    });
  }

  return lines;
}

async function fetchMbtaLines(vehicles: LocalTransitVehicle[], warnings: string[]): Promise<LocalTransitLine[]> {
  const routeIds = Array.from(new Set(vehicles.map((v) => v.routeId).filter(Boolean)));
  if (routeIds.length === 0) return [];

  const routeMeta = new Map<string, {
    mode: Exclude<LocalTransitMode, 'amtrak'>;
    routeLabel: string;
    color: string;
    textColor: string;
  }>();

  const chunkedRouteIds = chunk(routeIds, 40);
  for (const routeChunk of chunkedRouteIds) {
    try {
      const routesPayload = await fetchMbtaJson(MBTA_ROUTES_URL, {
        'filter[id]': routeChunk.join(','),
        'page[limit]': routeChunk.length,
        ...(MBTA_API_KEY ? { api_key: MBTA_API_KEY } : {}),
      });
      for (const row of routesPayload.data ?? []) {
        if (row.type !== 'route') continue;
        const attrs = row.attributes ?? {};
        const mode = modeFromRouteType(toNumber(attrs.route_type)) ?? modeFromRouteId(row.id);
        if (!mode) continue;
        const fallback = modeColor(mode);
        const routeLabel = String(attrs.short_name ?? attrs.long_name ?? row.id);
        routeMeta.set(row.id, {
          mode,
          routeLabel,
          color: normalizeHexColor(attrs.color, fallback),
          textColor: normalizeHexColor(attrs.text_color, '#FFFFFF'),
        });
      }
    } catch (error) {
      warnings.push(`MBTA route metadata query failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  const bestByRoute = new Map<string, LocalTransitLine>();
  for (const routeChunk of chunkedRouteIds) {
    try {
      const shapesPayload = await fetchMbtaJson(MBTA_SHAPES_URL, {
        'filter[route]': routeChunk.join(','),
        'page[limit]': 2000,
        ...(MBTA_API_KEY ? { api_key: MBTA_API_KEY } : {}),
      });
      for (const row of shapesPayload.data ?? []) {
        if (row.type !== 'shape') continue;
        const attrs = row.attributes ?? {};
        const routeId = row.relationships?.route?.data?.id ?? textOrEmpty(attrs.route_id);
        if (!routeId) continue;
        const polyline = textOrEmpty(attrs.polyline);
        if (!polyline) continue;
        const path = decodePolyline(polyline);
        if (path.length < 2 || !isPathBostonRelevant(path)) continue;

        const meta = routeMeta.get(routeId);
        const mode = meta?.mode ?? modeFromRouteId(routeId);
        if (!mode) continue;

        const candidate: LocalTransitLine = {
          id: `shape-${routeId}-${row.id}`,
          mode,
          routeId,
          routeLabel: meta?.routeLabel ?? routeId,
          color: meta?.color ?? modeColor(mode),
          textColor: meta?.textColor ?? '#FFFFFF',
          path,
          source: 'mbta_shape',
        };

        const existing = bestByRoute.get(routeId);
        if (!existing || candidate.path.length > existing.path.length) {
          bestByRoute.set(routeId, candidate);
        }
      }
    } catch (error) {
      warnings.push(`MBTA route shape query failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  const lines = Array.from(bestByRoute.values());
  if (lines.length > 0) {
    return lines.sort((a, b) => a.routeLabel.localeCompare(b.routeLabel));
  }

  const synthetic = buildSyntheticLinesFromVehicles(vehicles);
  if (synthetic.length > 0) {
    warnings.push('Falling back to synthetic transit lines from live vehicle positions.');
  }
  return synthetic;
}

async function fetchMbtaVehicles(warnings: string[]): Promise<LocalTransitVehicle[]> {
  const primaryQuery = {
    include: 'route',
    'filter[route_type]': ROUTE_TYPES,
    'page[limit]': 1000,
    ...(MBTA_API_KEY ? { api_key: MBTA_API_KEY } : {}),
  };
  const fallbackQuery = {
    include: 'route',
    'page[limit]': 1000,
    ...(MBTA_API_KEY ? { api_key: MBTA_API_KEY } : {}),
  };
  const attemptNotes: string[] = [];

  for (const [label, query] of [['filtered', primaryQuery], ['fallback', fallbackQuery]] as const) {
    try {
      const payload = await fetchMbtaJson(MBTA_VEHICLES_URL, query);
      const vehicles = filterBostonVehicles(normalizeVehiclesFromMbtaV3(payload)).sort(sortByModeThenRoute);
      if (vehicles.length > 0) return vehicles;
      attemptNotes.push(`MBTA ${label} vehicle query returned zero Boston-area vehicles.`);
    } catch (error) {
      attemptNotes.push(`MBTA ${label} vehicle query failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  try {
    const gtfs = await fetchJson(MBTA_GTFS_VEHICLES_ENHANCED_URL);
    const vehicles = filterBostonVehicles(normalizeVehiclesFromGtfsEnhanced(gtfs)).sort(sortByModeThenRoute);
    if (vehicles.length > 0) return vehicles;
    attemptNotes.push('MBTA GTFS vehicle fallback returned zero Boston-area vehicles.');
  } catch (error) {
    attemptNotes.push(`MBTA GTFS vehicle fallback failed (${error instanceof Error ? error.message : String(error)}).`);
  }

  if (attemptNotes.length > 0) warnings.push(attemptNotes.join(' | '));
  return [];
}

function normalizeAlertsFromMbtaV3(payload: MbtaResponse): LocalTransitAlert[] {
  const routeById = new Map<string, MbtaResource>();
  for (const included of payload.included ?? []) {
    if (included.type === 'route') routeById.set(included.id, included);
  }

  const alerts: LocalTransitAlert[] = [];
  for (const row of payload.data ?? []) {
    if (row.type !== 'alert') continue;
    const attrs = row.attributes ?? {};

    const informed = Array.isArray(attrs.informed_entity) ? attrs.informed_entity : [];
    const informedMode = informed
      .map((entity) => {
        const entityObj = asRecord(entity);
        return modeFromRouteType(toNumber(entityObj?.route_type));
      })
      .find((mode): mode is Exclude<LocalTransitMode, 'amtrak'> => mode != null);

    const routeRel = row.relationships?.route?.data;
    const routeTypeFromRelationship = routeRel?.id
      ? modeFromRouteType(toNumber(routeById.get(routeRel.id)?.attributes?.route_type))
      : null;

    const routeId = routeRel?.id ?? '';
    const mode = informedMode ?? routeTypeFromRelationship ?? modeFromRouteId(routeId);
    if (!mode) continue;

    const title = String(attrs.header ?? attrs.service_effect ?? attrs.effect_name ?? 'MBTA service alert');
    const description = String(attrs.description ?? attrs.short_header ?? '');
    alerts.push({
      id: `mbta-${row.id}`,
      source: 'mbta',
      mode,
      title,
      description,
      severity: severityFromMbta(attrs.severity),
      updatedAt: toIsoDate(attrs.updated_at ?? attrs.created_at),
      url: String(attrs.url ?? 'https://www.mbta.com/alerts'),
    });
  }

  return alerts;
}

function normalizeAlertsFromGtfsEnhanced(payload: JsonRecord): LocalTransitAlert[] {
  const entities = Array.isArray(payload.entity) ? payload.entity : [];
  const alerts: LocalTransitAlert[] = [];

  for (const entityRaw of entities) {
    const entity = asRecord(entityRaw);
    const alert = asRecord(entity?.alert);
    if (!alert) continue;

    const informed = Array.isArray(alert.informed_entity) ? alert.informed_entity : [];
    const informedMode = informed
      .map((item) => {
        const row = asRecord(item);
        return modeFromRouteType(toNumber(row?.route_type));
      })
      .find((mode): mode is Exclude<LocalTransitMode, 'amtrak'> => mode != null);

    const routeId = informed
      .map((item) => textOrEmpty(asRecord(item)?.route_id))
      .find(Boolean) || '';

    const mode = informedMode ?? modeFromRouteId(routeId);
    if (!mode) continue;

    const title = parseGtfsTranslatedText(alert.header_text) || parseGtfsTranslatedText(alert.short_header_text) || 'MBTA service alert';
    const description = parseGtfsTranslatedText(alert.description_text);
    const url = parseGtfsTranslatedText(alert.url) || 'https://www.mbta.com/alerts';

    alerts.push({
      id: `mbta-gtfs-${textOrEmpty(entity?.id) || routeId || alerts.length}`,
      source: 'mbta',
      mode,
      title,
      description,
      severity: severityFromHeadline(`${title} ${description}`),
      updatedAt: toIsoDate(alert.updated_at),
      url,
    });
  }

  return alerts;
}

async function fetchMbtaAlerts(warnings: string[]): Promise<LocalTransitAlert[]> {
  const primaryQuery = {
    include: 'route',
    'filter[route_type]': ROUTE_TYPES,
    'page[limit]': 250,
    sort: '-updated_at',
    ...(MBTA_API_KEY ? { api_key: MBTA_API_KEY } : {}),
  };
  const fallbackQuery = {
    include: 'route',
    'page[limit]': 250,
    sort: '-updated_at',
    ...(MBTA_API_KEY ? { api_key: MBTA_API_KEY } : {}),
  };
  const attemptNotes: string[] = [];

  for (const [label, query] of [['filtered', primaryQuery], ['fallback', fallbackQuery]] as const) {
    try {
      const payload = await fetchMbtaJson(MBTA_ALERTS_URL, query);
      const alerts = normalizeAlertsFromMbtaV3(payload);
      if (alerts.length > 0) return alerts;
      attemptNotes.push(`MBTA ${label} alert query returned zero alerts.`);
    } catch (error) {
      attemptNotes.push(`MBTA ${label} alert query failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  try {
    const gtfs = await fetchJson(MBTA_GTFS_ALERTS_ENHANCED_URL);
    const alerts = normalizeAlertsFromGtfsEnhanced(gtfs);
    if (alerts.length > 0) return alerts;
    attemptNotes.push('MBTA GTFS alert fallback returned zero alerts.');
  } catch (error) {
    attemptNotes.push(`MBTA GTFS alert fallback failed (${error instanceof Error ? error.message : String(error)}).`);
  }

  if (attemptNotes.length > 0) warnings.push(attemptNotes.join(' | '));
  return [];
}

function parseAmtrakFeed(xml: string): LocalTransitAlert[] {
  if (!xml.trim()) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];

  return Array.from(doc.querySelectorAll('item')).map((item, index) => {
    const title = extractText(item, ['title']) || 'Amtrak service alert';
    const description = extractText(item, ['description']);
    const link = extractText(item, ['link']) || 'https://www.amtrak.com/alert.html';
    const updatedAt = toIsoDate(extractText(item, ['pubDate', 'updated', 'dc\\:date']));
    return {
      id: `amtrak-${index}-${link}`,
      source: 'amtrak' as const,
      mode: 'amtrak' as const,
      title,
      description,
      severity: severityFromHeadline(`${title} ${description}`),
      updatedAt,
      url: link,
    };
  });
}

async function fetchAmtrakAlerts(warnings: string[]): Promise<{ alerts: LocalTransitAlert[]; sourceUrl: string }> {
  const failures: string[] = [];

  for (const candidate of AMTRAK_FEED_CANDIDATES) {
    const proxied = `/api/rss-proxy?url=${encodeURIComponent(candidate)}`;
    try {
      const response = await fetch(proxied);
      if (!response.ok) {
        failures.push(`${candidate} -> HTTP ${response.status}`);
        continue;
      }

      const xml = await response.text();
      const all = parseAmtrakFeed(xml);
      if (all.length === 0) {
        failures.push(`${candidate} -> empty/unparseable feed`);
        continue;
      }

      const bostonOnly = all.filter((item) => isBostonRelated(`${item.title} ${item.description}`));
      if (bostonOnly.length === 0) {
        warnings.push('Amtrak feed reachable but no Boston-area alerts matched filters.');
      }

      return {
        alerts: bostonOnly,
        sourceUrl: candidate,
      };
    } catch (error) {
      failures.push(`${candidate} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    warnings.push(`Amtrak alerts unavailable (${failures.slice(0, 2).join(' | ')}).`);
  }

  return {
    alerts: [],
    sourceUrl: AMTRAK_FEED_CANDIDATES.join(' | '),
  };
}

function buildSummary(vehicles: LocalTransitVehicle[], alerts: LocalTransitAlert[]): LocalTransitSummary[] {
  const modes: LocalTransitMode[] = ['subway', 'bus', 'commuter_rail', 'ferry', 'amtrak'];

  return modes.map((mode) => {
    const vehicleCount = mode === 'amtrak' ? 0 : vehicles.filter((vehicle) => vehicle.mode === mode).length;
    const modeAlerts = alerts.filter((alert) => alert.mode === mode);
    const hasSevere = modeAlerts.some((alert) => alert.severity === 'severe' || alert.severity === 'major');

    let status = 'Normal service';
    if (modeAlerts.length > 0) {
      status = hasSevere
        ? 'Major service disruption'
        : `${modeAlerts.length} active service alert${modeAlerts.length === 1 ? '' : 's'}`;
    } else if (mode !== 'amtrak' && vehicleCount === 0) {
      status = 'No live vehicles reported';
    } else if (mode === 'amtrak') {
      status = 'No Boston-area alert published';
    }

    return {
      mode,
      label: modeLabel(mode),
      vehicleCount,
      alertCount: modeAlerts.length,
      status,
    };
  });
}

export async function getCachedLocalTransit(): Promise<LocalTransitPayload | null> {
  const cached = await getPersistentCache<LocalTransitPayload>(CACHE_KEY);
  return cached?.data ?? null;
}

export async function refreshLocalTransit(): Promise<LocalTransitPayload> {
  const warnings: string[] = [];
  const fetchedAt = new Date().toISOString();

  const [vehiclesResult, mbtaAlertsResult, amtrakResult] = await Promise.allSettled([
    fetchMbtaVehicles(warnings),
    fetchMbtaAlerts(warnings),
    fetchAmtrakAlerts(warnings),
  ]);

  const vehicles = vehiclesResult.status === 'fulfilled' ? vehiclesResult.value : [];
  if (vehiclesResult.status === 'rejected') {
    warnings.push(`MBTA vehicle refresh failed (${vehiclesResult.reason instanceof Error ? vehiclesResult.reason.message : String(vehiclesResult.reason)}).`);
  }

  let lines: LocalTransitLine[] = [];
  if (vehicles.length > 0) {
    try {
      lines = await fetchMbtaLines(vehicles, warnings);
    } catch (error) {
      warnings.push(`MBTA transit line refresh failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  const mbtaAlerts = mbtaAlertsResult.status === 'fulfilled' ? mbtaAlertsResult.value : [];
  if (mbtaAlertsResult.status === 'rejected') {
    warnings.push(`MBTA alert refresh failed (${mbtaAlertsResult.reason instanceof Error ? mbtaAlertsResult.reason.message : String(mbtaAlertsResult.reason)}).`);
  }

  const amtrak = amtrakResult.status === 'fulfilled'
    ? amtrakResult.value
    : { alerts: [] as LocalTransitAlert[], sourceUrl: AMTRAK_FEED_CANDIDATES.join(' | ') };
  if (amtrakResult.status === 'rejected') {
    warnings.push(`Amtrak refresh failed (${amtrakResult.reason instanceof Error ? amtrakResult.reason.message : String(amtrakResult.reason)}).`);
  }

  const alerts = [...mbtaAlerts, ...amtrak.alerts].sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bt - at;
  });
  const summaries = buildSummary(vehicles, alerts);

  const payload: LocalTransitPayload = {
    vehicles,
    lines,
    alerts,
    summaries,
    provenance: {
      datasetId: 'transitStatus',
      sourceUrl: MBTA_VEHICLES_URL,
      fetchedAt,
      recordCount: vehicles.length + alerts.length,
      queryParams: {
        mbtaRouteTypes: ROUTE_TYPES,
        bostonLat: BOSTON_LAT,
        bostonLon: BOSTON_LON,
        bostonRadiusKm: BOSTON_RADIUS_KM,
        mbtaApiKeyUsed: Boolean(MBTA_API_KEY),
        mbtaAlertsEndpoint: MBTA_ALERTS_URL,
        mbtaVehiclesGtfsFallback: MBTA_GTFS_VEHICLES_ENHANCED_URL,
        mbtaAlertsGtfsFallback: MBTA_GTFS_ALERTS_ENHANCED_URL,
        amtrakSource: amtrak.sourceUrl,
        amtrakFeedCandidates: AMTRAK_FEED_CANDIDATES.length,
        amtrakOverrideConfigured: Boolean(AMTRAK_FEED_OVERRIDE),
      },
      warnings,
    },
  };

  await setPersistentCache(CACHE_KEY, payload);
  return payload;
}

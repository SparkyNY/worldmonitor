import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';
import { recordCacheTelemetry } from './_cache-telemetry.js';
import { createIpRateLimiter } from './_ip-rate-limit.js';

export const config = { runtime: 'edge' };

const BASE_CACHE_KEY = 'cyber-threats:v1';
const GEO_CACHE_KEY_PREFIX = 'cyber-threats:geoip:v1:';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

const CACHE_TTL_SECONDS = 10 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
const STALE_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_TTL_SECONDS = 24 * 60 * 60;
const GEO_CACHE_TTL_MS = GEO_CACHE_TTL_SECONDS * 1000;

const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_RECENT_URL = (limit) => `https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`;

const UPSTREAM_TIMEOUT_MS = 8000;
const GEO_MAX_UNRESOLVED_PER_RUN = 100;
const GEO_CONCURRENCY = 8;

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;
const rateLimiter = createIpRateLimiter({
  limit: RATE_LIMIT,
  windowMs: RATE_WINDOW_MS,
  maxEntries: 8000,
});

const ALLOWED_TYPES = new Set(['c2_server', 'malware_host', 'phishing', 'malicious_url']);
const ALLOWED_SOURCES = new Set(['feodo', 'urlhaus']);
const ALLOWED_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const ALLOWED_INDICATOR_TYPES = new Set(['ip', 'domain', 'url']);

const responseMemoryCache = new Map();
const staleFallbackCache = new Map();
const geoMemoryCache = new Map();

function clampInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function getClientIp(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown_error');
}

function cleanString(value, maxLen = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidCoordinates(latValue, lonValue) {
  const lat = toFiniteNumber(latValue);
  const lon = toFiniteNumber(lonValue);
  if (lat === null || lon === null) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const raw = cleanString(String(value), 80);
  if (!raw) return null;

  const normalized = raw
    .replace(' UTC', 'Z')
    .replace(' GMT', 'Z')
    .replace(' +00:00', 'Z')
    .replace(' ', 'T');

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const fallback = new Date(normalized);
  if (!Number.isNaN(fallback.getTime())) return fallback.toISOString();

  return null;
}

function isIPv4(value) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

function isIPv6(value) {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
}

function isIpAddress(value) {
  const candidate = cleanString(value, 80).toLowerCase();
  if (!candidate) return false;
  return isIPv4(candidate) || isIPv6(candidate);
}

function normalizeCountry(value) {
  const raw = cleanString(String(value ?? ''), 64);
  if (!raw) return undefined;
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

function normalizeTags(input, maxTags = 8) {
  const tags = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[;,|]/g)
      : [];

  const normalized = [];
  const seen = new Set();
  for (const tag of tags) {
    const clean = cleanString(String(tag ?? ''), 40).toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
    if (normalized.length >= maxTags) break;
  }
  return normalized;
}

function normalizeEnum(value, allowlist, fallback) {
  const normalized = cleanString(String(value ?? ''), 40).toLowerCase();
  if (allowlist.has(normalized)) return normalized;
  return fallback;
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    default: return 1;
  }
}

function inferFeodoSeverity(record, malwareFamily) {
  const malware = cleanString(malwareFamily, 80).toLowerCase();
  const status = cleanString(record?.status || record?.c2_status || '', 30).toLowerCase();

  if (/emotet|qakbot|trickbot|dridex|ransom/i.test(malware)) return 'critical';
  if (status === 'online') return 'high';
  return 'medium';
}

function inferUrlhausType(record, tags) {
  const threat = cleanString(record?.threat || record?.threat_type || '', 40).toLowerCase();
  const allTags = tags.join(' ');

  if (threat.includes('phish') || allTags.includes('phish')) return 'phishing';
  if (threat.includes('malware') || threat.includes('payload') || allTags.includes('malware')) return 'malware_host';
  return 'malicious_url';
}

function inferUrlhausSeverity(type, tags) {
  if (type === 'phishing') return 'medium';
  if (tags.includes('ransomware') || tags.includes('botnet')) return 'critical';
  if (type === 'malware_host') return 'high';
  return 'medium';
}

function sanitizeThreat(threat) {
  const indicator = cleanString(threat?.indicator, 255);
  if (!indicator) return null;

  const indicatorType = normalizeEnum(threat?.indicatorType, ALLOWED_INDICATOR_TYPES, 'ip');
  if (indicatorType === 'ip' && !isIpAddress(indicator)) return null;

  const source = normalizeEnum(threat?.source, ALLOWED_SOURCES, 'feodo');
  const type = normalizeEnum(threat?.type, ALLOWED_TYPES, source === 'feodo' ? 'c2_server' : 'malicious_url');
  const severity = normalizeEnum(threat?.severity, ALLOWED_SEVERITIES, 'medium');

  const firstSeen = toIsoDate(threat?.firstSeen);
  const lastSeen = toIsoDate(threat?.lastSeen);

  const rawLat = toFiniteNumber(threat?.lat);
  const rawLon = toFiniteNumber(threat?.lon);
  const lat = hasValidCoordinates(rawLat, rawLon) ? rawLat : null;
  const lon = hasValidCoordinates(rawLat, rawLon) ? rawLon : null;

  return {
    id: cleanString(threat?.id, 255) || `${source}:${indicatorType}:${indicator}`,
    type,
    source,
    indicator,
    indicatorType,
    lat,
    lon,
    country: normalizeCountry(threat?.country),
    severity,
    malwareFamily: cleanString(threat?.malwareFamily, 80) || undefined,
    tags: normalizeTags(threat?.tags),
    firstSeen: firstSeen || undefined,
    lastSeen: lastSeen || undefined,
  };
}

function parseFeodoRecord(record, cutoffMs) {
  const ip = cleanString(
    record?.ip_address
      || record?.dst_ip
      || record?.ip
      || record?.ioc
      || record?.host,
    80,
  ).toLowerCase();

  if (!isIpAddress(ip)) return null;

  const statusRaw = cleanString(record?.status || record?.c2_status || '', 30).toLowerCase();
  if (statusRaw !== 'online') return null;

  const firstSeen = toIsoDate(record?.first_seen || record?.first_seen_utc || record?.dateadded);
  const lastSeen = toIsoDate(record?.last_online || record?.last_seen || record?.last_seen_utc || record?.first_seen || record?.first_seen_utc);

  const activityIso = lastSeen || firstSeen;
  if (activityIso) {
    const activityMs = Date.parse(activityIso);
    if (Number.isFinite(activityMs) && activityMs < cutoffMs) return null;
  }

  const malwareFamily = cleanString(record?.malware || record?.malware_family || record?.family, 80);
  const tags = normalizeTags(record?.tags);

  const sanitized = sanitizeThreat({
    id: `feodo:${ip}`,
    type: 'c2_server',
    source: 'feodo',
    indicator: ip,
    indicatorType: 'ip',
    lat: toFiniteNumber(record?.latitude ?? record?.lat),
    lon: toFiniteNumber(record?.longitude ?? record?.lon),
    country: record?.country || record?.country_code,
    severity: inferFeodoSeverity(record, malwareFamily),
    malwareFamily,
    tags: ['botnet', 'c2', ...tags],
    firstSeen,
    lastSeen,
  });

  return sanitized;
}

function parseUrlhausRecord(record, cutoffMs) {
  const rawUrl = cleanString(record?.url || record?.ioc || '', 1024);
  const statusRaw = cleanString(record?.url_status || record?.status || '', 30).toLowerCase();
  if (statusRaw && statusRaw !== 'online') return null;

  const tags = normalizeTags(record?.tags);

  let hostname = '';
  if (rawUrl) {
    try {
      hostname = cleanString(new URL(rawUrl).hostname, 255).toLowerCase();
    } catch {
      hostname = '';
    }
  }

  const recordIp = cleanString(record?.host || record?.ip_address || record?.ip, 80).toLowerCase();
  const ipCandidate = isIpAddress(recordIp)
    ? recordIp
    : (isIpAddress(hostname) ? hostname : '');

  const indicatorType = ipCandidate
    ? 'ip'
    : (hostname ? 'domain' : 'url');

  const indicator = ipCandidate || hostname || rawUrl;
  if (!indicator) return null;

  const firstSeen = toIsoDate(record?.dateadded || record?.firstseen || record?.first_seen);
  const lastSeen = toIsoDate(record?.last_online || record?.last_seen || record?.dateadded);

  const activityIso = lastSeen || firstSeen;
  if (activityIso) {
    const activityMs = Date.parse(activityIso);
    if (Number.isFinite(activityMs) && activityMs < cutoffMs) return null;
  }

  const type = inferUrlhausType(record, tags);

  return sanitizeThreat({
    id: `urlhaus:${indicatorType}:${indicator}`,
    type,
    source: 'urlhaus',
    indicator,
    indicatorType,
    lat: toFiniteNumber(record?.latitude ?? record?.lat),
    lon: toFiniteNumber(record?.longitude ?? record?.lon),
    country: record?.country || record?.country_code,
    severity: inferUrlhausSeverity(type, tags),
    malwareFamily: record?.threat,
    tags,
    firstSeen,
    lastSeen,
  });
}

export function __testParseFeodoRecords(records, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const safeRecords = Array.isArray(records) ? records : [];
  return safeRecords
    .map((record) => parseFeodoRecord(record, cutoffMs))
    .filter(Boolean);
}

export function __testParseUrlhausRecords(records, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const safeRecords = Array.isArray(records) ? records : [];
  return safeRecords
    .map((record) => parseUrlhausRecord(record, cutoffMs))
    .filter(Boolean);
}

export function __testDedupeThreats(threats) {
  const deduped = new Map();
  for (const threat of Array.isArray(threats) ? threats : []) {
    const sanitized = sanitizeThreat(threat);
    if (!sanitized) continue;
    const key = `${sanitized.source}:${sanitized.indicatorType}:${sanitized.indicator}`;
    if (!deduped.has(key)) {
      deduped.set(key, sanitized);
      continue;
    }

    const existing = deduped.get(key);
    const existingSeen = Date.parse(existing.lastSeen || existing.firstSeen || '1970-01-01T00:00:00.000Z');
    const candidateSeen = Date.parse(sanitized.lastSeen || sanitized.firstSeen || '1970-01-01T00:00:00.000Z');

    if (candidateSeen >= existingSeen) {
      deduped.set(key, {
        ...existing,
        ...sanitized,
        tags: normalizeTags([...(existing.tags || []), ...(sanitized.tags || [])]),
      });
    }
  }
  return Array.from(deduped.values());
}

function hasFreshResponseCache(cacheKey) {
  const entry = responseMemoryCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    return null;
  }

  return entry.data;
}

function getStaleResponseCache(cacheKey) {
  const entry = staleFallbackCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > STALE_FALLBACK_MAX_AGE_MS) {
    staleFallbackCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setResponseCaches(cacheKey, data) {
  const entry = { data, timestamp: Date.now() };
  responseMemoryCache.set(cacheKey, entry);
  staleFallbackCache.set(cacheKey, entry);
}

function getGeoMemory(ip) {
  const entry = geoMemoryCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > GEO_CACHE_TTL_MS) {
    geoMemoryCache.delete(ip);
    return null;
  }
  return entry.value;
}

function setGeoMemory(ip, value) {
  geoMemoryCache.set(ip, { value, timestamp: Date.now() });
}

function isValidGeo(value) {
  if (!value || typeof value !== 'object') return false;
  return hasValidCoordinates(value.lat, value.lon);
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getGeoFromCache(ip) {
  const fromMemory = getGeoMemory(ip);
  if (isValidGeo(fromMemory)) return fromMemory;

  const cacheKey = `${GEO_CACHE_KEY_PREFIX}${ip}`;
  const fromRedis = await getCachedJson(cacheKey);
  if (isValidGeo(fromRedis)) {
    setGeoMemory(ip, fromRedis);
    return fromRedis;
  }

  return null;
}

async function setGeoCache(ip, geo) {
  setGeoMemory(ip, geo);
  const cacheKey = `${GEO_CACHE_KEY_PREFIX}${ip}`;
  void setCachedJson(cacheKey, geo, GEO_CACHE_TTL_SECONDS);
}

async function fetchGeoIp(ip) {
  const primary = await fetchJsonWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (primary.ok) {
    const data = await primary.json();
    const lat = toFiniteNumber(data?.latitude);
    const lon = toFiniteNumber(data?.longitude);
    if (hasValidCoordinates(lat, lon)) {
      return {
        lat,
        lon,
        country: normalizeCountry(data?.country_code || data?.country),
      };
    }
  }

  const fallback = await fetchJsonWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  if (!fallback.ok) return null;

  const data = await fallback.json();
  const lat = toFiniteNumber(data?.latitude);
  const lon = toFiniteNumber(data?.longitude);
  if (!hasValidCoordinates(lat, lon)) return null;

  return {
    lat,
    lon,
    country: normalizeCountry(data?.country_code || data?.country_name),
  };
}

async function geolocateIp(ip) {
  const cached = await getGeoFromCache(ip);
  if (cached) return cached;

  try {
    const geo = await fetchGeoIp(ip);
    if (!geo) return null;
    await setGeoCache(ip, geo);
    return geo;
  } catch {
    return null;
  }
}

async function hydrateThreatCoordinates(threats) {
  const unresolvedIps = [];
  const seenIps = new Set();

  for (const threat of threats) {
    const hasCoords = hasValidCoordinates(threat.lat, threat.lon);
    if (hasCoords) continue;
    if (threat.indicatorType !== 'ip') continue;

    const ip = cleanString(threat.indicator, 80).toLowerCase();
    if (!isIpAddress(ip) || seenIps.has(ip)) continue;
    seenIps.add(ip);
    unresolvedIps.push(ip);
  }

  const cappedIps = unresolvedIps.slice(0, GEO_MAX_UNRESOLVED_PER_RUN);
  const resolvedByIp = new Map();

  const queue = [...cappedIps];
  const workerCount = Math.min(GEO_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const ip = queue.shift();
      if (!ip) continue;
      const geo = await geolocateIp(ip);
      if (geo) {
        resolvedByIp.set(ip, geo);
      }
    }
  });

  await Promise.all(workers);

  return threats.map((threat) => {
    const hasCoords = hasValidCoordinates(threat.lat, threat.lon);
    if (hasCoords || threat.indicatorType !== 'ip') return threat;

    const lookup = resolvedByIp.get(cleanString(threat.indicator, 80).toLowerCase());
    if (!lookup) return threat;

    return {
      ...threat,
      lat: lookup.lat,
      lon: lookup.lon,
      country: threat.country || lookup.country,
    };
  });
}

async function fetchFeodoSource(limit, cutoffMs) {
  try {
    const response = await fetchJsonWithTimeout(FEODO_URL, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        ok: false,
        threats: [],
        reason: `feodo_http_${response.status}`,
      };
    }

    const payload = await response.json();
    const records = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.data) ? payload.data : []);

    const parsed = records
      .map((record) => parseFeodoRecord(record, cutoffMs))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = Date.parse(a.lastSeen || a.firstSeen || '1970-01-01T00:00:00.000Z');
        const bTime = Date.parse(b.lastSeen || b.firstSeen || '1970-01-01T00:00:00.000Z');
        return bTime - aTime;
      })
      .slice(0, limit);

    return { ok: true, threats: parsed };
  } catch (error) {
    return {
      ok: false,
      threats: [],
      reason: `feodo_error:${cleanString(toErrorMessage(error), 120)}`,
    };
  }
}

async function fetchUrlhausSource(limit, cutoffMs) {
  const authKey = cleanString(process.env.URLHAUS_AUTH_KEY || '', 200);
  if (!authKey) {
    return {
      ok: false,
      threats: [],
      reason: 'missing_auth_key',
      enabled: false,
    };
  }

  try {
    const response = await fetchJsonWithTimeout(URLHAUS_RECENT_URL(limit), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Auth-Key': authKey,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        threats: [],
        reason: `urlhaus_http_${response.status}`,
        enabled: true,
      };
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.urls)
      ? payload.urls
      : (Array.isArray(payload?.data) ? payload.data : []);

    const parsed = rows
      .map((record) => parseUrlhausRecord(record, cutoffMs))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = Date.parse(a.lastSeen || a.firstSeen || '1970-01-01T00:00:00.000Z');
        const bTime = Date.parse(b.lastSeen || b.firstSeen || '1970-01-01T00:00:00.000Z');
        return bTime - aTime;
      })
      .slice(0, limit);

    return {
      ok: true,
      threats: parsed,
      enabled: true,
    };
  } catch (error) {
    return {
      ok: false,
      threats: [],
      reason: `urlhaus_error:${cleanString(toErrorMessage(error), 120)}`,
      enabled: true,
    };
  }
}

export function __resetCyberThreatsState() {
  responseMemoryCache.clear();
  staleFallbackCache.clear();
  geoMemoryCache.clear();
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    if (isDisallowedOrigin(req)) {
      return new Response(null, { status: 403, headers: corsHeaders });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed', data: [] }, {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (isDisallowedOrigin(req)) {
    return Response.json({ error: 'Origin not allowed', data: [] }, {
      status: 403,
      headers: corsHeaders,
    });
  }

  const ip = getClientIp(req);
  if (!rateLimiter.check(ip)) {
    return Response.json({ error: 'Rate limited', data: [] }, {
      status: 429,
      headers: {
        ...corsHeaders,
        'Retry-After': '60',
      },
    });
  }

  const requestUrl = new URL(req.url);
  const limit = clampInt(requestUrl.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const days = clampInt(requestUrl.searchParams.get('days'), DEFAULT_DAYS, 1, MAX_DAYS);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const cacheKey = `${BASE_CACHE_KEY}:limit=${limit}:days=${days}`;

  const redisCached = await getCachedJson(cacheKey);
  if (redisCached && typeof redisCached === 'object' && Array.isArray(redisCached.data)) {
    setResponseCaches(cacheKey, redisCached);
    recordCacheTelemetry('/api/cyber-threats', 'REDIS-HIT');
    return Response.json(redisCached, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'REDIS-HIT',
      },
    });
  }

  const memoryCached = hasFreshResponseCache(cacheKey);
  if (memoryCached && Array.isArray(memoryCached.data)) {
    recordCacheTelemetry('/api/cyber-threats', 'MEMORY-HIT');
    return Response.json(memoryCached, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'MEMORY-HIT',
      },
    });
  }

  try {
    const [feodo, urlhaus] = await Promise.all([
      fetchFeodoSource(limit, cutoffMs),
      fetchUrlhausSource(limit, cutoffMs),
    ]);

    if (!feodo.ok && !urlhaus.ok) {
      throw new Error('all_sources_failed');
    }

    const combined = __testDedupeThreats([
      ...feodo.threats,
      ...urlhaus.threats,
    ]);

    const withGeo = await hydrateThreatCoordinates(combined);

    const mapData = withGeo
      .filter((threat) => hasValidCoordinates(threat.lat, threat.lon))
      .map((threat) => ({
        ...threat,
        lat: Number(threat.lat),
        lon: Number(threat.lon),
      }))
      .sort((a, b) => {
        const bySeverity = severityRank(b.severity) - severityRank(a.severity);
        if (bySeverity !== 0) return bySeverity;
        const aTime = Date.parse(a.lastSeen || a.firstSeen || '1970-01-01T00:00:00.000Z');
        const bTime = Date.parse(b.lastSeen || b.firstSeen || '1970-01-01T00:00:00.000Z');
        return bTime - aTime;
      })
      .slice(0, limit);

    const partial = !feodo.ok || (urlhaus.enabled === true && !urlhaus.ok);

    const result = {
      success: true,
      count: mapData.length,
      partial,
      sources: {
        feodo: {
          ok: feodo.ok,
          count: feodo.threats.length,
          ...(feodo.reason ? { reason: feodo.reason } : {}),
        },
        urlhaus: {
          ok: urlhaus.ok,
          count: urlhaus.threats.length,
          ...(urlhaus.reason ? { reason: urlhaus.reason } : {}),
        },
      },
      data: mapData,
      cachedAt: new Date().toISOString(),
    };

    setResponseCaches(cacheKey, result);
    void setCachedJson(cacheKey, result, CACHE_TTL_SECONDS);
    recordCacheTelemetry('/api/cyber-threats', 'MISS');

    return Response.json(result, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    const stale = getStaleResponseCache(cacheKey);
    if (stale && Array.isArray(stale.data)) {
      recordCacheTelemetry('/api/cyber-threats', 'STALE');
      return Response.json(stale, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30',
          'X-Cache': 'STALE',
        },
      });
    }

    recordCacheTelemetry('/api/cyber-threats', 'ERROR');
    return Response.json({
      error: `Fetch failed: ${toErrorMessage(error)}`,
      data: [],
    }, {
      status: 502,
      headers: corsHeaders,
    });
  }
}

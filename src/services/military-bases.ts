import { MILITARY_BASES } from '@/config';
import type { MilitaryBaseEnriched, MilitaryBaseType } from '@/types';

export interface MilitaryBaseCluster {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
  dominantType: MilitaryBaseType;
}

interface CachedResult {
  bases: MilitaryBaseEnriched[];
  clusters: MilitaryBaseCluster[];
  totalInView: number;
  truncated: boolean;
  cacheKey: string;
}

const quantize = (v: number, step: number) => Math.round(v / step) * step;

function getBboxGridStep(zoom: number): number {
  if (zoom < 5) return 5;
  if (zoom <= 7) return 1;
  return 0.5;
}

function quantizeBbox(swLat: number, swLon: number, neLat: number, neLon: number, zoom: number): string {
  const step = getBboxGridStep(zoom);
  return [quantize(swLat, step), quantize(swLon, step), quantize(neLat, step), quantize(neLon, step)].join(':');
}

function inBounds(lat: number, lon: number, swLat: number, swLon: number, neLat: number, neLon: number): boolean {
  const inLat = lat >= swLat && lat <= neLat;
  // Handle antimeridian crossing boxes.
  const inLon = swLon <= neLon ? lon >= swLon && lon <= neLon : lon >= swLon || lon <= neLon;
  return inLat && inLon;
}

function toEnrichedBase(base: MilitaryBaseEnriched): MilitaryBaseEnriched {
  return { ...base };
}

function pickClusterStep(zoom: number): number {
  if (zoom < 3.5) return 8;
  if (zoom < 5) return 4;
  return 2;
}

function buildClusters(bases: MilitaryBaseEnriched[], zoom: number): MilitaryBaseCluster[] {
  if (bases.length === 0 || zoom >= 6) return [];

  const step = pickClusterStep(zoom);
  const buckets = new Map<string, {
    latSum: number;
    lonSum: number;
    count: number;
    byType: Record<MilitaryBaseType, number>;
  }>();

  for (const base of bases) {
    const key = `${quantize(base.lat, step)}:${quantize(base.lon, step)}`;
    const bucket = buckets.get(key) ?? {
      latSum: 0,
      lonSum: 0,
      count: 0,
      byType: {
        'us-nato': 0,
        china: 0,
        russia: 0,
        uk: 0,
        france: 0,
        india: 0,
        italy: 0,
        uae: 0,
        turkey: 0,
        japan: 0,
        other: 0,
      },
    };
    bucket.latSum += base.lat;
    bucket.lonSum += base.lon;
    bucket.count += 1;
    bucket.byType[base.type] += 1;
    buckets.set(key, bucket);
  }

  const clusters: MilitaryBaseCluster[] = [];
  for (const [id, bucket] of buckets.entries()) {
    if (bucket.count < 2) continue;
    let dominantType: MilitaryBaseType = 'other';
    let dominantCount = -1;
    for (const [type, count] of Object.entries(bucket.byType) as Array<[MilitaryBaseType, number]>) {
      if (count > dominantCount) {
        dominantType = type;
        dominantCount = count;
      }
    }
    clusters.push({
      id,
      latitude: bucket.latSum / bucket.count,
      longitude: bucket.lonSum / bucket.count,
      count: bucket.count,
      dominantType,
    });
  }

  return clusters;
}

let lastResult: CachedResult | null = null;
let pendingFetch: Promise<CachedResult | null> | null = null;

export async function fetchMilitaryBases(
  swLat: number,
  swLon: number,
  neLat: number,
  neLon: number,
  zoom: number,
  filters?: { type?: string; kind?: string; country?: string },
): Promise<CachedResult | null> {
  const qBbox = quantizeBbox(swLat, swLon, neLat, neLon, zoom);
  const floorZoom = Math.floor(zoom);
  const cacheKey = `${qBbox}:${floorZoom}:${filters?.type || ''}:${filters?.kind || ''}:${filters?.country || ''}`;

  if (lastResult && lastResult.cacheKey === cacheKey) {
    return lastResult;
  }
  if (pendingFetch) return pendingFetch;

  pendingFetch = Promise.resolve().then(() => {
    const typeFilter = filters?.type?.trim().toLowerCase();
    const countryFilter = filters?.country?.trim().toLowerCase();
    const kindFilter = filters?.kind?.trim().toLowerCase();

    const filtered = MILITARY_BASES
      .filter((base) => inBounds(base.lat, base.lon, swLat, swLon, neLat, neLon))
      .filter((base) => !typeFilter || base.type === typeFilter)
      .filter((base) => !countryFilter || (base.country || '').toLowerCase() === countryFilter)
      .filter((base) => !kindFilter || (base as MilitaryBaseEnriched).kind?.toLowerCase() === kindFilter)
      .map((base) => toEnrichedBase(base as MilitaryBaseEnriched));

    const result: CachedResult = {
      bases: filtered,
      clusters: buildClusters(filtered, zoom),
      totalInView: filtered.length,
      truncated: false,
      cacheKey,
    };

    lastResult = result;
    return result;
  }).catch((err) => {
    console.error('[bases-svc] fallback error', err);
    return lastResult;
  }).finally(() => {
    pendingFetch = null;
  });

  return pendingFetch;
}

/**
 * Shared constants for clustering and correlation analysis.
 * Used by both main-thread services and the analysis worker.
 *
 * IMPORTANT: If you change these values, update the worker too!
 * The worker (src/workers/analysis.worker.ts) has a copy of these
 * values for isolation. Keep them in sync.
 */

// Clustering constants
export const SIMILARITY_THRESHOLD = 0.5;

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than',
  'too', 'very', 'just', 'also', 'now', 'new', 'says', 'said', 'after',
]);

// Correlation constants
export const PREDICTION_SHIFT_THRESHOLD = 5;
export const MARKET_MOVE_THRESHOLD = 2;
export const NEWS_VELOCITY_THRESHOLD = 3;
export const FLOW_PRICE_THRESHOLD = 1.5;
export const ENERGY_COMMODITY_SYMBOLS = new Set(['CL=F', 'NG=F']);

export const PIPELINE_KEYWORDS = ['pipeline', 'pipelines', 'line', 'terminal'];
export const FLOW_DROP_KEYWORDS = [
  'flow', 'throughput', 'capacity', 'outage', 'leak', 'rupture', 'shutdown',
  'maintenance', 'curtailment', 'force majeure', 'halt', 'halted', 'reduced',
  'reduction', 'drop', 'offline', 'suspend', 'suspended', 'stoppage',
];

export const TOPIC_KEYWORDS = [
  'iran', 'israel', 'ukraine', 'russia', 'china', 'taiwan', 'oil', 'crypto',
  'fed', 'interest', 'inflation', 'recession', 'war', 'sanctions', 'tariff',
  'ai', 'tech', 'layoff', 'trump', 'biden', 'election',
];

export const TOPIC_MAPPINGS: Record<string, string[]> = {
  'iran': ['iran', 'israel', 'oil', 'sanctions'],
  'israel': ['israel', 'iran', 'war', 'gaza'],
  'ukraine': ['ukraine', 'russia', 'war', 'nato'],
  'russia': ['russia', 'ukraine', 'sanctions'],
  'china': ['china', 'taiwan', 'tariff', 'trade'],
  'taiwan': ['taiwan', 'china'],
  'trump': ['trump', 'election', 'tariff'],
  'fed': ['fed', 'interest', 'inflation', 'recession'],
  'bitcoin': ['crypto', 'bitcoin'],
  'recession': ['recession', 'fed', 'inflation'],
};

// Pure utility functions that can be shared
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

export function includesKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword));
}

export function findRelatedTopics(prediction: string): string[] {
  const title = prediction.toLowerCase();
  const related: string[] = [];

  for (const [key, topics] of Object.entries(TOPIC_MAPPINGS)) {
    if (title.includes(key)) {
      related.push(...topics);
    }
  }

  return [...new Set(related)];
}

export function generateSignalId(): string {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateDedupeKey(type: string, identifier: string, value: number): string {
  const marketSignals = ['silent_divergence', 'flow_price_divergence'];
  if (marketSignals.includes(type)) {
    return `${type}:${identifier}`;
  }
  const roundedValue = Math.round(value * 10) / 10;
  return `${type}:${identifier}:${roundedValue}`;
}

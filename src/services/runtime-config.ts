import { isDesktopRuntime } from './runtime';
import { invokeTauri } from './tauri-bridge';

export type RuntimeSecretKey =
  | 'GROQ_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'FRED_API_KEY'
  | 'EIA_API_KEY'
  | 'CLOUDFLARE_API_TOKEN'
  | 'ACLED_ACCESS_TOKEN'
  | 'URLHAUS_AUTH_KEY'
  | 'OTX_API_KEY'
  | 'ABUSEIPDB_API_KEY'
  | 'WINGBITS_API_KEY'
  | 'WS_RELAY_URL'
  | 'VITE_OPENSKY_RELAY_URL'
  | 'OPENSKY_CLIENT_ID'
  | 'OPENSKY_CLIENT_SECRET'
  | 'AISSTREAM_API_KEY';

export type RuntimeFeatureId =
  | 'aiGroq'
  | 'aiOpenRouter'
  | 'economicFred'
  | 'energyEia'
  | 'internetOutages'
  | 'acledConflicts'
  | 'abuseChThreatIntel'
  | 'alienvaultOtxThreatIntel'
  | 'abuseIpdbThreatIntel'
  | 'wingbitsEnrichment'
  | 'aisRelay'
  | 'openskyRelay';

export interface RuntimeFeatureDefinition {
  id: RuntimeFeatureId;
  name: string;
  description: string;
  requiredSecrets: RuntimeSecretKey[];
  fallback: string;
}

export interface RuntimeSecretState {
  value: string;
  source: 'env' | 'vault';
}

export interface RuntimeConfig {
  featureToggles: Record<RuntimeFeatureId, boolean>;
  secrets: Partial<Record<RuntimeSecretKey, RuntimeSecretState>>;
}

const TOGGLES_STORAGE_KEY = 'worldmonitor-runtime-feature-toggles';

const defaultToggles: Record<RuntimeFeatureId, boolean> = {
  aiGroq: true,
  aiOpenRouter: true,
  economicFred: true,
  energyEia: true,
  internetOutages: true,
  acledConflicts: true,
  abuseChThreatIntel: true,
  alienvaultOtxThreatIntel: true,
  abuseIpdbThreatIntel: true,
  wingbitsEnrichment: true,
  aisRelay: true,
  openskyRelay: true,
};

export const RUNTIME_FEATURES: RuntimeFeatureDefinition[] = [
  {
    id: 'aiGroq',
    name: 'Groq summarization',
    description: 'Primary fast LLM provider used for AI summary generation.',
    requiredSecrets: ['GROQ_API_KEY'],
    fallback: 'Falls back to OpenRouter, then local browser model.',
  },
  {
    id: 'aiOpenRouter',
    name: 'OpenRouter summarization',
    description: 'Secondary LLM provider for AI summary fallback.',
    requiredSecrets: ['OPENROUTER_API_KEY'],
    fallback: 'Falls back to local browser model only.',
  },
  {
    id: 'economicFred',
    name: 'FRED economic indicators',
    description: 'Macro indicators from Federal Reserve Economic Data.',
    requiredSecrets: ['FRED_API_KEY'],
    fallback: 'Economic panel remains available with non-FRED metrics.',
  },
  {
    id: 'energyEia',
    name: 'EIA oil analytics',
    description: 'US Energy Information Administration oil metrics.',
    requiredSecrets: ['EIA_API_KEY'],
    fallback: 'Oil analytics cards show disabled state.',
  },
  {
    id: 'internetOutages',
    name: 'Cloudflare outage radar',
    description: 'Internet outages from Cloudflare Radar annotations API.',
    requiredSecrets: ['CLOUDFLARE_API_TOKEN'],
    fallback: 'Outage layer is disabled and map continues with other feeds.',
  },
  {
    id: 'acledConflicts',
    name: 'ACLED conflicts & protests',
    description: 'Conflict and protest event feeds from ACLED.',
    requiredSecrets: ['ACLED_ACCESS_TOKEN'],
    fallback: 'Conflict/protest overlays are hidden.',
  },
  {
    id: 'abuseChThreatIntel',
    name: 'abuse.ch cyber IOC feeds',
    description: 'URLhaus and ThreatFox IOC ingestion for the cyber threat layer.',
    requiredSecrets: ['URLHAUS_AUTH_KEY'],
    fallback: 'URLhaus/ThreatFox IOC ingestion is disabled.',
  },
  {
    id: 'alienvaultOtxThreatIntel',
    name: 'AlienVault OTX threat intel',
    description: 'Optional OTX IOC ingestion for cyber threat enrichment.',
    requiredSecrets: ['OTX_API_KEY'],
    fallback: 'OTX IOC enrichment is disabled.',
  },
  {
    id: 'abuseIpdbThreatIntel',
    name: 'AbuseIPDB threat intel',
    description: 'Optional AbuseIPDB IOC/reputation enrichment for the cyber threat layer.',
    requiredSecrets: ['ABUSEIPDB_API_KEY'],
    fallback: 'AbuseIPDB enrichment is disabled.',
  },
  {
    id: 'wingbitsEnrichment',
    name: 'Wingbits aircraft enrichment',
    description: 'Military flight operator/aircraft enrichment metadata.',
    requiredSecrets: ['WINGBITS_API_KEY'],
    fallback: 'Flight map still renders with heuristic-only classification.',
  },
  {
    id: 'aisRelay',
    name: 'AIS vessel relay',
    description: 'Live vessel ingestion via relay endpoint and AIS key.',
    requiredSecrets: ['WS_RELAY_URL', 'AISSTREAM_API_KEY'],
    fallback: 'AIS layer is disabled.',
  },
  {
    id: 'openskyRelay',
    name: 'OpenSky military flights relay',
    description: 'Relay credentials for OpenSky OAuth client credentials flow.',
    requiredSecrets: ['VITE_OPENSKY_RELAY_URL', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
    fallback: 'Military flights fall back to limited/no data.',
  },
];

function readEnvSecret(key: RuntimeSecretKey): string {
  const envValue = (import.meta as { env?: Record<string, unknown> }).env?.[key];
  return typeof envValue === 'string' ? envValue.trim() : '';
}

function readStoredToggles(): Record<RuntimeFeatureId, boolean> {
  try {
    const stored = localStorage.getItem(TOGGLES_STORAGE_KEY);
    if (!stored) return { ...defaultToggles };
    const parsed = JSON.parse(stored) as Partial<Record<RuntimeFeatureId, boolean>>;
    return { ...defaultToggles, ...parsed };
  } catch {
    return { ...defaultToggles };
  }
}

function validateSecretValue(value: string): boolean {
  return value.trim().length >= 8;
}

const listeners = new Set<() => void>();

const runtimeConfig: RuntimeConfig = {
  featureToggles: readStoredToggles(),
  secrets: {},
};

function notifyConfigChanged(): void {
  for (const listener of listeners) listener();
}

function seedSecretsFromEnvironment(): void {
  if (isDesktopRuntime()) return;

  const keys = new Set<RuntimeSecretKey>(RUNTIME_FEATURES.flatMap(feature => feature.requiredSecrets));
  for (const key of keys) {
    const value = readEnvSecret(key);
    if (value) {
      runtimeConfig.secrets[key] = { value, source: 'env' };
    }
  }
}

seedSecretsFromEnvironment();

export function subscribeRuntimeConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRuntimeConfigSnapshot(): RuntimeConfig {
  return {
    featureToggles: { ...runtimeConfig.featureToggles },
    secrets: { ...runtimeConfig.secrets },
  };
}

export function isFeatureEnabled(featureId: RuntimeFeatureId): boolean {
  return runtimeConfig.featureToggles[featureId] !== false;
}

export function getSecretState(key: RuntimeSecretKey): { present: boolean; valid: boolean; source: 'env' | 'vault' | 'missing' } {
  const state = runtimeConfig.secrets[key];
  if (!state) return { present: false, valid: false, source: 'missing' };
  return { present: true, valid: validateSecretValue(state.value), source: state.source };
}

export function isFeatureAvailable(featureId: RuntimeFeatureId): boolean {
  if (!isFeatureEnabled(featureId)) return false;

  // Cloud/web deployments validate credentials server-side.
  // Desktop runtime validates local secrets client-side for capability gating.
  if (!isDesktopRuntime()) {
    return true;
  }

  const feature = RUNTIME_FEATURES.find(item => item.id === featureId);
  if (!feature) return false;
  return feature.requiredSecrets.every(secretKey => getSecretState(secretKey).valid);
}

export function setFeatureToggle(featureId: RuntimeFeatureId, enabled: boolean): void {
  runtimeConfig.featureToggles[featureId] = enabled;
  localStorage.setItem(TOGGLES_STORAGE_KEY, JSON.stringify(runtimeConfig.featureToggles));
  notifyConfigChanged();
}

export async function setSecretValue(key: RuntimeSecretKey, value: string): Promise<void> {
  if (!isDesktopRuntime()) {
    console.warn('[runtime-config] Ignoring secret write outside desktop runtime');
    return;
  }

  const sanitized = value.trim();
  if (sanitized) {
    await invokeTauri<void>('set_secret', { key, value: sanitized });
    runtimeConfig.secrets[key] = { value: sanitized, source: 'vault' };
  } else {
    await invokeTauri<void>('delete_secret', { key });
    delete runtimeConfig.secrets[key];
  }

  // Push to sidecar so handlers pick it up immediately
  pushSecretToSidecar(key, sanitized || '');

  notifyConfigChanged();
}

function pushSecretToSidecar(key: string, value: string): void {
  fetch('http://127.0.0.1:46123/api/local-env-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: value || null }),
  }).catch(() => { /* sidecar not running */ });
}

export async function loadDesktopSecrets(): Promise<void> {
  if (!isDesktopRuntime()) return;

  try {
    const keys = await invokeTauri<RuntimeSecretKey[]>('list_supported_secret_keys');

    await Promise.all(keys.map(async (key) => {
      const value = await invokeTauri<string | null>('get_secret', { key });
      if (value && value.trim()) {
        runtimeConfig.secrets[key] = { value: value.trim(), source: 'vault' };
        pushSecretToSidecar(key, value.trim());
      }
    }));

    notifyConfigChanged();
  } catch (error) {
    console.warn('[runtime-config] Failed to load desktop secrets from vault', error);
  }
}

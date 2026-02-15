import { Panel } from './Panel';
import {
  RUNTIME_FEATURES,
  getRuntimeConfigSnapshot,
  getSecretState,
  isFeatureAvailable,
  isFeatureEnabled,
  setFeatureToggle,
  setSecretValue,
  subscribeRuntimeConfig,
  type RuntimeFeatureDefinition,
  type RuntimeSecretKey,
} from '@/services/runtime-config';
import { invokeTauri } from '@/services/tauri-bridge';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';

const SIGNUP_URLS: Partial<Record<RuntimeSecretKey, string>> = {
  GROQ_API_KEY: 'https://console.groq.com/keys',
  OPENROUTER_API_KEY: 'https://openrouter.ai/settings/keys',
  FRED_API_KEY: 'https://fred.stlouisfed.org/docs/api/api_key.html',
  EIA_API_KEY: 'https://www.eia.gov/opendata/register.php',
  CLOUDFLARE_API_TOKEN: 'https://dash.cloudflare.com/profile/api-tokens',
  ACLED_ACCESS_TOKEN: 'https://developer.acleddata.com/',
  URLHAUS_AUTH_KEY: 'https://auth.abuse.ch/',
  OTX_API_KEY: 'https://otx.alienvault.com/',
  ABUSEIPDB_API_KEY: 'https://www.abuseipdb.com/login',
  WINGBITS_API_KEY: 'https://wingbits.com/register',
  AISSTREAM_API_KEY: 'https://aisstream.io/authenticate',
  OPENSKY_CLIENT_ID: 'https://opensky-network.org/login?view=registration',
  OPENSKY_CLIENT_SECRET: 'https://opensky-network.org/login?view=registration',
};

const SECRET_HELP_TEXT: Partial<Record<RuntimeSecretKey, string>> = {
  URLHAUS_AUTH_KEY: 'Used for both URLhaus and ThreatFox APIs.',
  OTX_API_KEY: 'Optional enrichment source for the cyber threat layer.',
  ABUSEIPDB_API_KEY: 'Optional enrichment source for malicious IP reputation.',
};

interface RuntimeConfigPanelOptions {
  mode?: 'full' | 'alert';
  buffered?: boolean;
}

export class RuntimeConfigPanel extends Panel {
  private unsubscribe: (() => void) | null = null;
  private readonly mode: 'full' | 'alert';
  private readonly buffered: boolean;
  private pendingSecrets = new Map<RuntimeSecretKey, string>();

  constructor(options: RuntimeConfigPanelOptions = {}) {
    super({ id: 'runtime-config', title: 'Desktop Configuration', showCount: false });
    this.mode = options.mode ?? (isDesktopRuntime() ? 'alert' : 'full');
    this.buffered = options.buffered ?? false;
    this.unsubscribe = subscribeRuntimeConfig(() => this.render());
    this.render();
  }

  public async commitPendingSecrets(): Promise<void> {
    for (const [key, value] of this.pendingSecrets) {
      await setSecretValue(key, value);
    }
    this.pendingSecrets.clear();
  }

  public hasPendingChanges(): boolean {
    return this.pendingSecrets.size > 0;
  }

  public destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  protected render(): void {
    const snapshot = getRuntimeConfigSnapshot();
    const desktop = isDesktopRuntime();

    if (desktop && this.mode === 'alert') {
      const totalFeatures = RUNTIME_FEATURES.length;
      const availableFeatures = RUNTIME_FEATURES.filter((feature) => isFeatureAvailable(feature.id)).length;
      const missingFeatures = Math.max(0, totalFeatures - availableFeatures);
      const configuredCount = Object.keys(snapshot.secrets).length;
      const alertTitle = configuredCount > 0
        ? (missingFeatures > 0 ? 'Some features need API keys' : 'Desktop settings configured')
        : 'Configure API keys to unlock features';
      const alertClass = missingFeatures > 0 ? 'warn' : 'ok';

      this.content.innerHTML = `
        <section class="runtime-alert runtime-alert-${alertClass}">
          <h3>${alertTitle}</h3>
          <p>
            ${availableFeatures}/${totalFeatures} features available${configuredCount > 0 ? ` · ${configuredCount} secrets configured` : ''}.
          </p>
          <button type="button" class="runtime-open-settings-btn" data-open-settings>
            Open Settings
          </button>
        </section>
      `;
      this.attachListeners();
      return;
    }

    this.content.innerHTML = `
      <div class="runtime-config-summary">
        ${desktop ? 'Desktop mode' : 'Web mode (read-only, server-managed credentials)'} · ${Object.keys(snapshot.secrets).length} local secrets configured · ${RUNTIME_FEATURES.filter(f => isFeatureAvailable(f.id)).length}/${RUNTIME_FEATURES.length} features available
      </div>
      <div class="runtime-config-list">
        ${RUNTIME_FEATURES.map(feature => this.renderFeature(feature)).join('')}
      </div>
    `;

    this.attachListeners();
  }

  private renderFeature(feature: RuntimeFeatureDefinition): string {
    const enabled = isFeatureEnabled(feature.id);
    const available = isFeatureAvailable(feature.id);
    const secrets = feature.requiredSecrets.map((key) => this.renderSecretRow(key)).join('');
    const desktop = isDesktopRuntime();
    const fallbackHtml = available ? '' : `<p class="runtime-feature-fallback fallback">${escapeHtml(feature.fallback)}</p>`;

    return `
      <section class="runtime-feature ${available ? 'available' : 'degraded'}">
        <header class="runtime-feature-header">
          <label>
            <input type="checkbox" data-toggle="${feature.id}" ${enabled ? 'checked' : ''} ${desktop ? '' : 'disabled'}>
            <span>${escapeHtml(feature.name)}</span>
          </label>
          <span class="runtime-pill ${available ? 'ok' : 'warn'}">${available ? 'Ready' : 'Needs Keys'}</span>
        </header>
        <div class="runtime-secrets">${secrets}</div>
        ${fallbackHtml}
      </section>
    `;
  }

  private renderSecretRow(key: RuntimeSecretKey): string {
    const state = getSecretState(key);
    const status = !state.present ? 'Missing' : state.valid ? `Valid (${state.source})` : 'Looks invalid';
    const signupUrl = SIGNUP_URLS[key];
    const helpText = SECRET_HELP_TEXT[key];
    const linkHtml = signupUrl
      ? ` <a href="#" data-signup-url="${signupUrl}" class="runtime-secret-link" title="Get API key">&#x2197;</a>`
      : '';
    return `
      <div class="runtime-secret-row">
        <div class="runtime-secret-key"><code>${escapeHtml(key)}</code>${linkHtml}</div>
        <span class="runtime-secret-status ${state.valid ? 'ok' : 'warn'}">${escapeHtml(status)}</span>
        ${helpText ? `<div class="runtime-secret-meta">${escapeHtml(helpText)}</div>` : ''}
        <input type="password" data-secret="${key}" placeholder="Set secret" autocomplete="off" ${isDesktopRuntime() ? '' : 'disabled'}>
      </div>
    `;
  }

  private attachListeners(): void {
    this.content.querySelectorAll<HTMLAnchorElement>('a[data-signup-url]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.dataset.signupUrl;
        if (!url) return;
        if (isDesktopRuntime()) {
          void invokeTauri<void>('open_url', { url }).catch(() => window.open(url, '_blank'));
        } else {
          window.open(url, '_blank');
        }
      });
    });

    if (!isDesktopRuntime()) return;

    if (this.mode === 'alert') {
      this.content.querySelector<HTMLButtonElement>('[data-open-settings]')?.addEventListener('click', () => {
        void invokeTauri<void>('open_settings_window_command').catch((error) => {
          console.warn('[runtime-config] Failed to open settings window', error);
        });
      });
      return;
    }

    this.content.querySelectorAll<HTMLInputElement>('input[data-toggle]').forEach((input) => {
      input.addEventListener('change', () => {
        const featureId = input.dataset.toggle as RuntimeFeatureDefinition['id'] | undefined;
        if (!featureId) return;
        setFeatureToggle(featureId, input.checked);
      });
    });

    this.content.querySelectorAll<HTMLInputElement>('input[data-secret]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.secret as RuntimeSecretKey | undefined;
        if (!key || !input.value) return;
        if (this.buffered) {
          this.pendingSecrets.set(key, input.value);
          input.value = '';
          input.placeholder = 'Pending (save with OK)';
        } else {
          void setSecretValue(key, input.value);
          input.value = '';
        }
      });
    });
  }
}

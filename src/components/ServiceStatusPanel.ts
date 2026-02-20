
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';
import {
  getDesktopReadinessChecks,
  getKeyBackedAvailabilitySummary,
  getNonParityFeatures,
} from '@/services/desktop-readiness';

interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  status: 'operational' | 'degraded' | 'outage' | 'unknown';
  description: string;
}

interface LocalBackendStatus {
  enabled?: boolean;
  mode?: string;
  port?: number;
  remoteBase?: string;
}

interface ServiceStatusResponse {
  success: boolean;
  timestamp: string;
  summary: {
    operational: number;
    degraded: number;
    outage: number;
    unknown: number;
  };
  services: ServiceStatus[];
  local?: LocalBackendStatus;
}

type CategoryFilter = 'all' | 'cloud' | 'dev' | 'comm' | 'ai' | 'saas';

function getCategoryLabel(category: CategoryFilter): string {
  const labels: Record<CategoryFilter, string> = {
    all: t('components.serviceStatus.categories.all'),
    cloud: t('components.serviceStatus.categories.cloud'),
    dev: t('components.serviceStatus.categories.dev'),
    comm: t('components.serviceStatus.categories.comm'),
    ai: t('components.serviceStatus.categories.ai'),
    saas: t('components.serviceStatus.categories.saas'),
  };
  return labels[category];
}

export class ServiceStatusPanel extends Panel {
  private services: ServiceStatus[] = [];
  private loading = true;
  private error: string | null = null;
  private filter: CategoryFilter = 'all';
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private localBackend: LocalBackendStatus | null = null;

  constructor() {
    super({ id: 'service-status', title: t('panels.serviceStatus'), showCount: false });
    void this.fetchStatus();
    this.refreshInterval = setInterval(() => this.fetchStatus(), 60000);
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  private async fetchStatus(): Promise<void> {
    try {
      const res = await fetch('/api/service-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: ServiceStatusResponse = await res.json();
      if (!data.success) throw new Error('Failed to load status');

      this.services = data.services;
      this.localBackend = data.local ?? null;
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to fetch';
      console.error('[ServiceStatus] Fetch error:', err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private setFilter(filter: CategoryFilter): void {
    this.filter = filter;
    this.render();
  }

  private getFilteredServices(): ServiceStatus[] {
    if (this.filter === 'all') return this.services;
    return this.services.filter(s => s.category === this.filter);
  }

  protected render(): void {
    if (this.loading) {
      this.content.innerHTML = `
        <div class="service-status-loading">
          <div class="loading-spinner"></div>
          <span>${t('components.serviceStatus.checkingServices')}</span>
        </div>
      `;
      return;
    }

    if (this.error) {
      this.content.innerHTML = `
        <div class="service-status-error">
          <span class="error-text">${escapeHtml(this.error)}</span>
          <button class="retry-btn">${t('common.retry')}</button>
        </div>
      `;
      this.content.querySelector('.retry-btn')?.addEventListener('click', () => {
        this.loading = true;
        this.render();
        void this.fetchStatus();
      });
      return;
    }

    const filtered = this.getFilteredServices();
    const issues = filtered.filter(s => s.status !== 'operational');

    const backendHtml = this.renderBackendStatus();
    const readinessHtml = this.renderDesktopReadiness();
    const summaryHtml = this.renderSummary(filtered);
    const filtersHtml = this.renderFilters();
    const servicesHtml = this.renderServices(filtered);

    this.content.innerHTML = `
      ${backendHtml}
      ${readinessHtml}
      ${summaryHtml}
      ${filtersHtml}
      <div class="service-status-list">
        ${servicesHtml}
      </div>
      ${issues.length === 0 ? `<div class="all-operational">${t('components.serviceStatus.allOperational')}</div>` : ''}
    `;

    this.attachFilterListeners();
  }


  private renderBackendStatus(): string {
    if (!isDesktopRuntime()) return '';

    if (!this.localBackend?.enabled) {
      return `
        <div class="service-status-backend warning">
          ${t('components.serviceStatus.backendUnavailable')}
        </div>
      `;
    }

    const port = this.localBackend.port ?? 46123;
    const remote = this.localBackend.remoteBase ?? 'https://worldmonitor.app';

    return `
      <div class="service-status-backend">
        Local backend active on <strong>127.0.0.1:${port}</strong> · cloud fallback: <strong>${escapeHtml(remote)}</strong>
      </div>
    `;
  }

  private renderSummary(services: ServiceStatus[]): string {
    const operational = services.filter(s => s.status === 'operational').length;
    const degraded = services.filter(s => s.status === 'degraded').length;
    const outage = services.filter(s => s.status === 'outage').length;

    return `
      <div class="service-status-summary">
        <div class="summary-item operational">
          <span class="summary-count">${operational}</span>
          <span class="summary-label">${t('components.serviceStatus.ok')}</span>
        </div>
        <div class="summary-item degraded">
          <span class="summary-count">${degraded}</span>
          <span class="summary-label">${t('components.serviceStatus.degraded')}</span>
        </div>
        <div class="summary-item outage">
          <span class="summary-count">${outage}</span>
          <span class="summary-label">${t('components.serviceStatus.outage')}</span>
        </div>
      </div>
    `;
  }

  private renderDesktopReadiness(): string {
    if (!isDesktopRuntime()) return '';

    const checks = getDesktopReadinessChecks(Boolean(this.localBackend?.enabled));
    const keySummary = getKeyBackedAvailabilitySummary();
    const nonParity = getNonParityFeatures();

    return `
      <div class="service-status-desktop-readiness">
        <div class="service-status-desktop-title">${t('components.serviceStatus.desktopReadiness')}</div>
        <div class="service-status-desktop-subtitle">${t('components.serviceStatus.acceptanceChecks', { ready: String(checks.filter(check => check.ready).length), total: String(checks.length), available: String(keySummary.available), featureTotal: String(keySummary.total) })}</div>
        <ul class="service-status-desktop-list">
          ${checks.map(check => `<li>${check.ready ? '✅' : '⚠️'} ${escapeHtml(check.label)}</li>`).join('')}
        </ul>
        <details class="service-status-non-parity">
          <summary>${t('components.serviceStatus.nonParityFallbacks', { count: String(nonParity.length) })}</summary>
          <ul>
            ${nonParity.map(feature => `<li><strong>${escapeHtml(feature.panel)}</strong>: ${escapeHtml(feature.fallback)}</li>`).join('')}
          </ul>
        </details>
      </div>
    `;
  }

  private renderFilters(): string {
    const categories: CategoryFilter[] = ['all', 'cloud', 'dev', 'comm', 'ai', 'saas'];
    const filters = categories.map(key => {
      const active = this.filter === key ? 'active' : '';
      return `<button class="status-filter-btn ${active}" data-filter="${key}">${getCategoryLabel(key)}</button>`;
    }).join('');

    return `<div class="service-status-filters">${filters}</div>`;
  }

  private renderServices(services: ServiceStatus[]): string {
    return services.map(service => {
      const statusIcon = this.getStatusIcon(service.status);
      const statusClass = service.status;

      return `
        <div class="service-status-item ${statusClass}">
          <span class="status-icon">${statusIcon}</span>
          <span class="status-name">${escapeHtml(service.name)}</span>
          <span class="status-badge ${statusClass}">${service.status.toUpperCase()}</span>
        </div>
      `;
    }).join('');
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'operational': return '●';
      case 'degraded': return '◐';
      case 'outage': return '○';
      default: return '?';
    }
  }

  private attachFilterListeners(): void {
    this.content.querySelectorAll('.status-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = (btn as HTMLElement).dataset.filter as CategoryFilter;
        this.setFilter(filter);
      });
    });
  }
}

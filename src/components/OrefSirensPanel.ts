import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import type { OrefAlertsResponse, OrefAlert } from '@/services/oref-alerts';

export class OrefSirensPanel extends Panel {
  private alerts: OrefAlert[] = [];
  private historyCount24h = 0;

  constructor() {
    super({
      id: 'oref-sirens',
      title: t('panels.orefSirens'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.orefSirens.infoTooltip'),
    });
    this.showLoading(t('components.orefSirens.checking'));
  }

  public setData(data: OrefAlertsResponse): void {
    if (!data.configured) {
      this.setContent(`<div class="panel-empty">${t('components.orefSirens.notConfigured')}</div>`);
      this.setCount(0);
      return;
    }

    const prevCount = this.alerts.length;
    this.alerts = data.alerts || [];
    this.historyCount24h = data.historyCount24h || 0;
    this.setCount(this.alerts.length);

    if (prevCount === 0 && this.alerts.length > 0) {
      this.setNewBadge(this.alerts.length);
    }

    this.render();
  }

  private formatAlertTime(dateStr: string): string {
    try {
      const diff = Date.now() - new Date(dateStr).getTime();
      if (diff < 60_000) return t('components.orefSirens.justNow');
      const mins = Math.floor(diff / 60_000);
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    } catch {
      return '';
    }
  }

  private render(): void {
    if (this.alerts.length === 0) {
      this.setContent(`
        <div class="oref-panel-content">
          <div class="oref-status oref-ok">
            <span class="oref-status-icon">&#x2705;</span>
            <span>${t('components.orefSirens.noAlerts')}</span>
          </div>
          <div class="oref-footer">
            <span class="oref-history">${t('components.orefSirens.historyCount', { count: String(this.historyCount24h) })}</span>
          </div>
        </div>
      `);
      return;
    }

    const alertRows = this.alerts.slice(0, 20).map(alert => {
      const areas = (alert.data || []).map(a => escapeHtml(a)).join(', ');
      const time = this.formatAlertTime(alert.alertDate);
      return `<div class="oref-alert-row">
        <div class="oref-alert-header">
          <span class="oref-alert-title">${escapeHtml(alert.title || alert.cat)}</span>
          <span class="oref-alert-time">${time}</span>
        </div>
        <div class="oref-alert-areas">${areas}</div>
      </div>`;
    }).join('');

    this.setContent(`
      <div class="oref-panel-content">
        <div class="oref-status oref-danger">
          <span class="oref-pulse"></span>
          <span>${t('components.orefSirens.activeSirens', { count: String(this.alerts.length) })}</span>
        </div>
        <div class="oref-list">${alertRows}</div>
        <div class="oref-footer">
          <span class="oref-history">${t('components.orefSirens.historyCount', { count: String(this.historyCount24h) })}</span>
        </div>
      </div>
    `);
  }
}

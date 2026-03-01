import { Panel } from './Panel';
import type {
  BostonDatasetId,
  BostonIncident,
  BostonLayerId,
  BostonProvenance,
} from '@/services/boston-open-data';
import type {
  LocalTransitAlert,
  LocalTransitPayload,
  LocalTransitProvenance,
  LocalTransitSummary,
} from '@/services/local-transit';
import { escapeHtml } from '@/utils/sanitize';

type PanelRefreshDatasetId = BostonDatasetId | 'transitStatus';
type PanelProvenance = BostonProvenance | LocalTransitProvenance;

interface BostonPanelCallbacks {
  onRefreshAll: () => Promise<void>;
  onRefreshDataset: (datasetId: BostonDatasetId) => Promise<void>;
  onRefreshTransit: () => Promise<void>;
  onLayerToggle: (layerId: BostonLayerId, enabled: boolean) => void;
  onCrimeFilterChange: (incidents: BostonIncident[]) => void;
  onFireFilterChange: (incidents: BostonIncident[]) => void;
  onIncidentFocus: (incident: BostonIncident) => void;
}

interface LayerToggleState {
  policeDistricts: boolean;
  fireHydrants: boolean;
  fireDepartments: boolean;
  communityCenters: boolean;
  transitVehicles: boolean;
}

interface DatasetRefreshState {
  crimeIncidents: boolean;
  fireIncidents: boolean;
  policeDistricts: boolean;
  fireHydrants: boolean;
  fireDepartments: boolean;
  communityCenters: boolean;
  transitStatus: boolean;
}

interface BostonPanelData {
  crimeIncidents: BostonIncident[];
  fireIncidents: BostonIncident[];
  transit: LocalTransitPayload | null;
  provenance: Partial<Record<PanelRefreshDatasetId, PanelProvenance>>;
}

export class BostonPanel extends Panel {
  private callbacks: BostonPanelCallbacks;
  private data: BostonPanelData = {
    crimeIncidents: [],
    fireIncidents: [],
    transit: null,
    provenance: {},
  };

  private layerState: LayerToggleState = {
    policeDistricts: true,
    fireHydrants: true,
    fireDepartments: true,
    communityCenters: false,
    transitVehicles: true,
  };

  private refreshState: DatasetRefreshState = {
    crimeIncidents: false,
    fireIncidents: false,
    policeDistricts: false,
    fireHydrants: false,
    fireDepartments: false,
    communityCenters: false,
    transitStatus: false,
  };

  private activeTab: 'crime' | 'fire' = 'crime';
  private showProvenance = false;
  private selectedIncidentId: string | null = null;

  private crimeDateFrom: string;
  private crimeDateTo: string;
  private crimeDistrict = 'all';
  private crimeKeyword = '';
  private crimeWindowHours = 7 * 24;

  private fireDateFrom: string;
  private fireDateTo: string;
  private fireType = 'all';
  private fireKeyword = '';
  private fireWindowHours = 7 * 24;

  constructor(callbacks: BostonPanelCallbacks) {
    super({
      id: 'boston',
      title: 'Boston Open Data',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Manual refresh only. Data is fetched from public Boston open data endpoints and cached locally for offline use.',
    });

    this.callbacks = callbacks;

    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    this.crimeDateFrom = from;
    this.crimeDateTo = to;
    this.fireDateFrom = from;
    this.fireDateTo = to;

    this.renderPanel();
    this.bindEvents();
    (Object.entries(this.layerState) as Array<[BostonLayerId, boolean]>).forEach(([layerId, enabled]) => {
      this.callbacks.onLayerToggle(layerId, enabled);
    });
    this.emitFilteredIncidents();
  }

  public setLayerState(state: Partial<LayerToggleState>): void {
    this.layerState = { ...this.layerState, ...state };
    this.renderPanel();
  }

  public setData(data: Partial<BostonPanelData>): void {
    this.data = {
      crimeIncidents: data.crimeIncidents ?? this.data.crimeIncidents,
      fireIncidents: data.fireIncidents ?? this.data.fireIncidents,
      transit: data.transit ?? this.data.transit,
      provenance: data.provenance ?? this.data.provenance,
    };

    this.setCount(this.data.crimeIncidents.length + this.data.fireIncidents.length);
    this.emitFilteredIncidents();
    this.renderPanel();
  }

  public setDatasetRefreshing(datasetId: PanelRefreshDatasetId, refreshing: boolean): void {
    this.refreshState[datasetId] = refreshing;
    this.renderPanel();
  }

  public setAllRefreshing(refreshing: boolean): void {
    (Object.keys(this.refreshState) as PanelRefreshDatasetId[]).forEach((id) => {
      this.refreshState[id] = refreshing;
    });
    this.renderPanel();
  }

  private bindEvents(): void {
    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      const tab = target.closest<HTMLElement>('[data-boston-tab]');
      if (tab) {
        this.activeTab = (tab.dataset.bostonTab as 'crime' | 'fire') ?? 'crime';
        this.renderPanel();
        return;
      }

      const rangeBtn = target.closest<HTMLElement>('[data-boston-range-hours]');
      if (rangeBtn?.dataset.bostonRangeHours) {
        const hours = Number(rangeBtn.dataset.bostonRangeHours);
        const scope = (rangeBtn.dataset.bostonRangeScope as 'crime' | 'fire') ?? 'crime';
        if (Number.isFinite(hours) && hours > 0) {
          this.applyRangeWindow(scope, hours);
          this.emitFilteredIncidents();
          this.renderPanel();
        }
        return;
      }

      const refreshAll = target.closest<HTMLElement>('[data-boston-refresh="all"]');
      if (refreshAll) {
        void this.callbacks.onRefreshAll();
        return;
      }

      const refreshDataset = target.closest<HTMLElement>('[data-boston-refresh-dataset]');
      if (refreshDataset?.dataset.bostonRefreshDataset) {
        const datasetId = refreshDataset.dataset.bostonRefreshDataset as PanelRefreshDatasetId;
        if (datasetId === 'transitStatus') void this.callbacks.onRefreshTransit();
        else void this.callbacks.onRefreshDataset(datasetId);
        return;
      }

      const refreshTransit = target.closest<HTMLElement>('[data-boston-refresh-transit]');
      if (refreshTransit) {
        void this.callbacks.onRefreshTransit();
        return;
      }

      const toggleProvenance = target.closest<HTMLElement>('[data-boston-provenance-toggle]');
      if (toggleProvenance) {
        this.showProvenance = !this.showProvenance;
        this.renderPanel();
        return;
      }

      const incidentRow = target.closest<HTMLElement>('[data-boston-incident-id]');
      if (incidentRow?.dataset.bostonIncidentId) {
        const incidentId = incidentRow.dataset.bostonIncidentId;
        const incident = [...this.data.crimeIncidents, ...this.data.fireIncidents].find((item) => item.id === incidentId);
        if (incident) {
          this.selectedIncidentId = incident.id;
          this.callbacks.onIncidentFocus(incident);
          this.renderPanel();
        }
      }
    });

    this.content.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;

      const layerToggle = target.closest<HTMLElement>('[data-boston-layer]');
      if (layerToggle?.dataset.bostonLayer && target instanceof HTMLInputElement) {
        const layerId = layerToggle.dataset.bostonLayer as BostonLayerId;
        this.layerState[layerId] = target.checked;
        this.callbacks.onLayerToggle(layerId, target.checked);
        this.renderPanel();
        return;
      }

      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;

      if (target.dataset.bostonCrimeDateFrom != null) {
        this.crimeDateFrom = target.value;
        this.crimeWindowHours = 0;
      }
      if (target.dataset.bostonCrimeDateTo != null) {
        this.crimeDateTo = target.value;
        this.crimeWindowHours = 0;
      }
      if (target.dataset.bostonCrimeDistrict != null) this.crimeDistrict = target.value;
      if (target.dataset.bostonFireDateFrom != null) {
        this.fireDateFrom = target.value;
        this.fireWindowHours = 0;
      }
      if (target.dataset.bostonFireDateTo != null) {
        this.fireDateTo = target.value;
        this.fireWindowHours = 0;
      }
      if (target.dataset.bostonFireType != null) this.fireType = target.value;

      this.emitFilteredIncidents();
      this.renderPanel();
    });

    this.content.addEventListener('input', (event) => {
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.bostonCrimeKeyword != null) {
        this.crimeKeyword = target.value;
        this.emitFilteredIncidents();
        this.renderPanel();
      } else if (target.dataset.bostonFireKeyword != null) {
        this.fireKeyword = target.value;
        this.emitFilteredIncidents();
        this.renderPanel();
      }
    });
  }

  private emitFilteredIncidents(): void {
    this.callbacks.onCrimeFilterChange(this.getFilteredCrimeIncidents());
    this.callbacks.onFireFilterChange(this.getFilteredFireIncidents());
  }

  private getFilteredCrimeIncidents(): BostonIncident[] {
    return this.data.crimeIncidents
      .filter((incident) => this.crimeWindowHours > 0
        ? isWithinRollingWindow(incident.dateTimeReported ?? incident.date, this.crimeWindowHours)
        : inDateRange(incident.dateTimeReported ?? incident.date, this.crimeDateFrom, this.crimeDateTo))
      .filter((incident) => this.crimeDistrict === 'all' || incident.district === this.crimeDistrict)
      .filter((incident) => {
        if (!this.crimeKeyword.trim()) return true;
        const q = this.crimeKeyword.toLowerCase();
        return incident.incidentNumber.toLowerCase().includes(q)
          || incident.description.toLowerCase().includes(q)
          || incident.incidentType.toLowerCase().includes(q)
          || incident.typeCode.toLowerCase().includes(q)
          || incident.address.toLowerCase().includes(q);
      });
  }

  private getFilteredFireIncidents(): BostonIncident[] {
    return this.data.fireIncidents
      .filter((incident) => this.fireWindowHours > 0
        ? isWithinRollingWindow(incident.dateTimeReported ?? incident.date, this.fireWindowHours)
        : inDateRange(incident.dateTimeReported ?? incident.date, this.fireDateFrom, this.fireDateTo))
      .filter((incident) => this.fireType === 'all' || incident.incidentType === this.fireType)
      .filter((incident) => {
        if (!this.fireKeyword.trim()) return true;
        const q = this.fireKeyword.toLowerCase();
        return incident.incidentNumber.toLowerCase().includes(q)
          || incident.description.toLowerCase().includes(q)
          || incident.incidentType.toLowerCase().includes(q)
          || incident.typeCode.toLowerCase().includes(q)
          || incident.address.toLowerCase().includes(q);
      });
  }

  private getCrimeDistrictOptions(): string[] {
    return Array.from(new Set(this.data.crimeIncidents.map((i) => i.district).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  private getFireTypeOptions(): string[] {
    return Array.from(new Set(this.data.fireIncidents.map((i) => i.incidentType).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  private renderPanel(): void {
    const crimeIncidents = this.getFilteredCrimeIncidents();
    const fireIncidents = this.getFilteredFireIncidents();
    const districtOptions = this.getCrimeDistrictOptions();
    const fireTypeOptions = this.getFireTypeOptions();
    const fireTypeSummary = summarizeTypes(fireIncidents);

    const crimeRows = renderIncidentRows(crimeIncidents, this.selectedIncidentId);
    const fireRows = renderIncidentRows(fireIncidents, this.selectedIncidentId);

    const activeIncidents = this.activeTab === 'crime' ? crimeIncidents : fireIncidents;
    const transitSummary = this.data.transit?.summaries ?? [];
    const transitAlerts = this.data.transit?.alerts ?? [];
    const transitLines = this.data.transit?.lines ?? [];
    const transitFetchedAt = this.data.transit?.provenance.fetchedAt ?? null;

    this.setContent(`
      <div class="boston-panel-content">
        <div class="boston-toolbar">
          <button class="boston-btn" data-boston-refresh="all" ${this.anyRefreshing() ? 'disabled' : ''}>Refresh Boston</button>
          <button class="boston-btn boston-btn-secondary" data-boston-provenance-toggle>
            ${this.showProvenance ? 'Hide Provenance' : 'Show Provenance'}
          </button>
        </div>

        <section class="boston-section">
          <div class="boston-section-title">Layers</div>
          <div class="boston-layer-grid">
            ${renderLayerToggle('Police Districts', 'policeDistricts', this.layerState.policeDistricts, this.refreshState.policeDistricts)}
            ${renderLayerToggle('Fire Hydrants', 'fireHydrants', this.layerState.fireHydrants, this.refreshState.fireHydrants)}
            ${renderLayerToggle('Fire Departments', 'fireDepartments', this.layerState.fireDepartments, this.refreshState.fireDepartments)}
            ${renderLayerToggle('Community Centers', 'communityCenters', this.layerState.communityCenters, this.refreshState.communityCenters)}
            ${renderLayerToggle('Transit Vehicles', 'transitVehicles', this.layerState.transitVehicles, this.refreshState.transitStatus, 'transitStatus')}
          </div>
        </section>

        <section class="boston-section">
          <div class="boston-section-title-row">
            <div class="boston-section-title">Transit Status</div>
            <button class="boston-btn" data-boston-refresh-transit ${this.refreshState.transitStatus ? 'disabled' : ''}>Refresh Transit</button>
          </div>
          <div class="boston-transit-meta">
            ${transitFetchedAt
              ? `Live MBTA pull: ${escapeHtml(formatDateTime(transitFetchedAt))} · ${transitLines.length} route lines · ${this.data.transit?.vehicles.length ?? 0} vehicles`
              : 'Waiting for first transit fetch'}
          </div>
          <div class="boston-transit-grid">${renderTransitSummary(transitSummary)}</div>
          <div class="boston-transit-alerts">${renderTransitAlerts(transitAlerts)}</div>
        </section>

        <section class="boston-section">
          <div class="boston-tabs">
            <button class="boston-tab ${this.activeTab === 'crime' ? 'active' : ''}" data-boston-tab="crime">Crime Incidents (${crimeIncidents.length})</button>
            <button class="boston-tab ${this.activeTab === 'fire' ? 'active' : ''}" data-boston-tab="fire">Fire Incidents (${fireIncidents.length})</button>
          </div>

          <div class="boston-view ${this.activeTab === 'crime' ? 'active' : ''}">
            <div class="boston-controls">
              <label>From <input type="date" value="${escapeHtml(this.crimeDateFrom)}" data-boston-crime-date-from></label>
              <label>To <input type="date" value="${escapeHtml(this.crimeDateTo)}" data-boston-crime-date-to></label>
              <label>District
                <select data-boston-crime-district>
                  <option value="all">All</option>
                  ${districtOptions.map((district) => `<option value="${escapeHtml(district)}" ${district === this.crimeDistrict ? 'selected' : ''}>${escapeHtml(district)}</option>`).join('')}
                </select>
              </label>
              <label>Search <input type="search" value="${escapeHtml(this.crimeKeyword)}" placeholder="Incident # / keyword" data-boston-crime-keyword></label>
              <button class="boston-btn" data-boston-refresh-dataset="crimeIncidents" ${this.refreshState.crimeIncidents ? 'disabled' : ''}>Refresh</button>
            </div>
            <div class="boston-range-pills">
              ${renderRangePill('crime', 24, this.crimeWindowHours)}
              ${renderRangePill('crime', 48, this.crimeWindowHours)}
              ${renderRangePill('crime', 7 * 24, this.crimeWindowHours, '7d')}
              ${renderRangePill('crime', 30 * 24, this.crimeWindowHours, '30d')}
            </div>
            <div class="boston-list-wrap">
              <table class="boston-table">
                <thead><tr><th>Incident #</th><th>Type Code</th><th>Address</th><th>District</th><th>Date/Time Reported</th></tr></thead>
                <tbody>${crimeRows}</tbody>
              </table>
            </div>
          </div>

          <div class="boston-view ${this.activeTab === 'fire' ? 'active' : ''}">
            <div class="boston-controls">
              <label>From <input type="date" value="${escapeHtml(this.fireDateFrom)}" data-boston-fire-date-from></label>
              <label>To <input type="date" value="${escapeHtml(this.fireDateTo)}" data-boston-fire-date-to></label>
              <label>Type
                <select data-boston-fire-type>
                  <option value="all">All</option>
                  ${fireTypeOptions.map((type) => `<option value="${escapeHtml(type)}" ${type === this.fireType ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}
                </select>
              </label>
              <label>Search <input type="search" value="${escapeHtml(this.fireKeyword)}" placeholder="Incident # / keyword" data-boston-fire-keyword></label>
              <button class="boston-btn" data-boston-refresh-dataset="fireIncidents" ${this.refreshState.fireIncidents ? 'disabled' : ''}>Refresh</button>
            </div>
            <div class="boston-range-pills">
              ${renderRangePill('fire', 24, this.fireWindowHours)}
              ${renderRangePill('fire', 48, this.fireWindowHours)}
              ${renderRangePill('fire', 7 * 24, this.fireWindowHours, '7d')}
              ${renderRangePill('fire', 30 * 24, this.fireWindowHours, '30d')}
            </div>
            <div class="boston-fire-chart">${renderTypeSummary(fireTypeSummary)}</div>
            <div class="boston-list-wrap">
              <table class="boston-table">
                <thead><tr><th>Incident #</th><th>Type Code</th><th>Address</th><th>District</th><th>Date/Time Reported</th></tr></thead>
                <tbody>${fireRows}</tbody>
              </table>
            </div>
          </div>

          <div class="boston-incident-summary">${activeIncidents.length} incidents shown on map as clusters (table capped at first 200 rows).</div>
        </section>

        ${this.showProvenance ? renderProvenance(this.data.provenance) : ''}
      </div>
    `);
  }

  private anyRefreshing(): boolean {
    return (Object.values(this.refreshState) as boolean[]).some(Boolean);
  }

  private applyRangeWindow(scope: 'crime' | 'fire', hours: number): void {
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = now.toISOString().slice(0, 10);

    if (scope === 'crime') {
      this.crimeWindowHours = hours;
      this.crimeDateFrom = fromDate;
      this.crimeDateTo = toDate;
      return;
    }

    this.fireWindowHours = hours;
    this.fireDateFrom = fromDate;
    this.fireDateTo = toDate;
  }
}

function renderLayerToggle(
  label: string,
  layer: BostonLayerId,
  enabled: boolean,
  refreshing: boolean,
  refreshDatasetId?: PanelRefreshDatasetId,
): string {
  const datasetId = refreshDatasetId ?? (layer as unknown as BostonDatasetId);
  return `
    <div class="boston-layer-item" data-boston-layer="${layer}">
      <label>
        <input type="checkbox" ${enabled ? 'checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>
      <button class="boston-btn boston-btn-secondary" data-boston-refresh-dataset="${datasetId}" ${refreshing ? 'disabled' : ''}>Refresh</button>
    </div>
  `;
}

function renderIncidentRows(incidents: BostonIncident[], selectedIncidentId: string | null): string {
  if (!incidents.length) {
    return '<tr><td colspan="5" class="boston-empty">No incidents in current filter.</td></tr>';
  }

  return incidents.slice(0, 200).map((incident) => {
    const selected = selectedIncidentId === incident.id ? ' selected' : '';
    return `
      <tr class="boston-incident-row${selected}" data-boston-incident-id="${escapeHtml(incident.id)}">
        <td>${escapeHtml(incident.incidentNumber || 'N/A')}</td>
        <td>${escapeHtml(incident.typeCode || 'N/A')}</td>
        <td>${escapeHtml(incident.address)}</td>
        <td>${escapeHtml(incident.district || 'Unknown')}</td>
        <td>${escapeHtml(formatDate(incident.dateTimeReported ?? incident.date))}</td>
      </tr>
    `;
  }).join('');
}

function renderRangePill(scope: 'crime' | 'fire', hours: number, currentHours: number, label?: string): string {
  const text = label ?? `${hours}h`;
  const active = currentHours === hours ? ' active' : '';
  return `<button class="boston-pill${active}" data-boston-range-scope="${scope}" data-boston-range-hours="${hours}">${text}</button>`;
}

function renderTransitSummary(items: LocalTransitSummary[]): string {
  if (items.length === 0) {
    return '<div class="boston-empty">No transit data fetched yet.</div>';
  }

  return items.map((item) => `
    <div class="boston-transit-card">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${item.vehicleCount} vehicles</span>
      <span>${item.alertCount} alerts</span>
      <span>${escapeHtml(item.status)}</span>
    </div>
  `).join('');
}

function renderTransitAlerts(alerts: LocalTransitAlert[]): string {
  if (alerts.length === 0) {
    return '<div class="boston-empty">No Boston-area transit alerts found.</div>';
  }

  return alerts.slice(0, 12).map((alert) => `
    <div class="boston-transit-alert">
      <span><strong>${escapeHtml(alert.source.toUpperCase())}</strong> ${escapeHtml(alert.title)}</span>
      <span>${escapeHtml(formatDateTime(alert.updatedAt))}</span>
      ${alert.url ? `<a href="${escapeHtml(alert.url)}" target="_blank" rel="noopener">Open</a>` : ''}
    </div>
  `).join('');
}

function renderProvenance(provenance: Partial<Record<PanelRefreshDatasetId, PanelProvenance>>): string {
  const datasets: PanelRefreshDatasetId[] = [
    'crimeIncidents',
    'fireIncidents',
    'policeDistricts',
    'fireHydrants',
    'fireDepartments',
    'communityCenters',
    'transitStatus',
  ];

  return `
    <section class="boston-section">
      <div class="boston-section-title">Provenance</div>
      <div class="boston-provenance-list">
        ${datasets.map((datasetId) => {
          const row = provenance[datasetId];
          if (!row) {
            return `<div class="boston-prov-item"><strong>${escapeHtml(datasetId)}</strong><span>Not fetched yet.</span></div>`;
          }

          const params = Object.entries(row.queryParams ?? {})
            .map(([key, value]) => `${key}=${String(value)}`)
            .join('&');

          return `
            <div class="boston-prov-item">
              <strong>${escapeHtml(datasetId)}</strong>
              <span>Last refreshed: ${escapeHtml(formatDateTime(row.fetchedAt))}</span>
              <span>Source: <a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(row.sourceUrl)}</a></span>
              <span>Records: ${row.recordCount}</span>
              <span>Query: ${escapeHtml(params || '(none)')}</span>
              ${row.warnings.length > 0 ? `<span class="boston-warning">Warnings: ${escapeHtml(row.warnings.join(' | '))}</span>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function inDateRange(value: string | null, from: string, to: string): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;

  const fromTs = Date.parse(`${from}T00:00:00`);
  const toTs = Date.parse(`${to}T23:59:59`);
  return timestamp >= fromTs && timestamp <= toTs;
}

function isWithinRollingWindow(value: string | null, hours: number): boolean {
  if (!value || !Number.isFinite(hours) || hours <= 0) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return timestamp >= cutoff;
}

function formatDate(value: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function summarizeTypes(incidents: BostonIncident[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const incident of incidents) {
    const key = incident.incidentType || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function renderTypeSummary(items: Array<{ label: string; count: number }>): string {
  if (items.length === 0) return '<div class=\"boston-empty\">No fire type distribution available.</div>';
  const max = Math.max(...items.map((item) => item.count), 1);
  return items.map((item) => {
    const width = Math.max(4, Math.round((item.count / max) * 100));
    return `<div class=\"boston-fire-bar-row\"><span>${escapeHtml(item.label)}</span><div class=\"boston-fire-bar\"><i style=\"width:${width}%\"></i></div><strong>${item.count}</strong></div>`;
  }).join('');
}

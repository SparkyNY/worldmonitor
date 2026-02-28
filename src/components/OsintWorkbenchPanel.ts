import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

type IndicatorType = 'ip' | 'domain' | 'url' | 'hash' | 'email' | 'username' | 'asn';

interface OsintTool {
  label: string;
  buildUrl: (query: string) => string;
  note?: string;
}

const TOOL_MAP: Record<IndicatorType, OsintTool[]> = {
  ip: [
    { label: 'AbuseIPDB', buildUrl: (q) => `https://www.abuseipdb.com/check/${encodeURIComponent(q)}` },
    { label: 'VirusTotal', buildUrl: (q) => `https://www.virustotal.com/gui/ip-address/${encodeURIComponent(q)}` },
    { label: 'Shodan', buildUrl: (q) => `https://www.shodan.io/host/${encodeURIComponent(q)}` },
    { label: 'Censys', buildUrl: (q) => `https://search.censys.io/search?resource=hosts&q=${encodeURIComponent(q)}` },
    { label: 'GreyNoise', buildUrl: (q) => `https://viz.greynoise.io/ip/${encodeURIComponent(q)}` },
  ],
  domain: [
    { label: 'VirusTotal', buildUrl: (q) => `https://www.virustotal.com/gui/domain/${encodeURIComponent(q)}` },
    { label: 'URLScan', buildUrl: (q) => `https://urlscan.io/search/#domain:${encodeURIComponent(q)}` },
    { label: 'SecurityTrails', buildUrl: (q) => `https://securitytrails.com/domain/${encodeURIComponent(q)}` },
    { label: 'WHOIS', buildUrl: (q) => `https://www.whois.com/whois/${encodeURIComponent(q)}` },
    { label: 'DNSDumpster', buildUrl: (q) => `https://dnsdumpster.com/static/map/${encodeURIComponent(q)}.png`, note: 'DNS map preview' },
  ],
  url: [
    { label: 'URLScan', buildUrl: (q) => `https://urlscan.io/search/#${encodeURIComponent(q)}` },
    { label: 'VirusTotal', buildUrl: (q) => `https://www.virustotal.com/gui/search/${encodeURIComponent(q)}` },
    { label: 'Wayback', buildUrl: (q) => `https://web.archive.org/web/*/${encodeURIComponent(q)}` },
    { label: 'Google Cache', buildUrl: (q) => `https://www.google.com/search?q=cache:${encodeURIComponent(q)}` },
  ],
  hash: [
    { label: 'VirusTotal', buildUrl: (q) => `https://www.virustotal.com/gui/search/${encodeURIComponent(q)}` },
    { label: 'Hybrid Analysis', buildUrl: (q) => `https://www.hybrid-analysis.com/search?query=${encodeURIComponent(q)}` },
    { label: 'MalwareBazaar', buildUrl: (q) => `https://bazaar.abuse.ch/browse.php?search=${encodeURIComponent(q)}` },
  ],
  email: [
    { label: 'HaveIBeenPwned', buildUrl: (q) => `https://haveibeenpwned.com/account/${encodeURIComponent(q)}` },
    { label: 'Hunter', buildUrl: (q) => `https://hunter.io/search/${encodeURIComponent(q)}` },
    { label: 'Google Search', buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(`"${q}"`)}` },
  ],
  username: [
    { label: 'WhatsMyName', buildUrl: (q) => `https://whatsmyname.app/?q=${encodeURIComponent(q)}` },
    { label: 'Namechk', buildUrl: (q) => `https://namechk.com/${encodeURIComponent(q)}` },
    { label: 'Google Search', buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(`"${q}"`)}` },
  ],
  asn: [
    { label: 'BGPView', buildUrl: (q) => `https://bgpview.io/asn/${encodeURIComponent(q)}` },
    { label: 'Hurricane Electric', buildUrl: (q) => `https://bgp.he.net/${encodeURIComponent(q)}` },
    { label: 'Radar by Cloudflare', buildUrl: (q) => `https://radar.cloudflare.com/traffic/as${encodeURIComponent(q.replace(/^AS/i, ''))}` },
  ],
};

const QUICK_LINKS: Array<{ label: string; url: string; desc: string }> = [
  { label: 'OSINT Framework', url: 'https://osintframework.com/', desc: 'Category index of investigation tools' },
  { label: 'IntelTechniques', url: 'https://inteltechniques.com/tools/', desc: 'Free investigative utilities and references' },
  { label: 'Wayback Machine', url: 'https://web.archive.org/', desc: 'Historical snapshots of websites' },
  { label: 'CISA Alerts', url: 'https://www.cisa.gov/news-events/cybersecurity-advisories', desc: 'Official US cybersecurity advisories' },
];

export class OsintWorkbenchPanel extends Panel {
  private indicatorType: IndicatorType = 'ip';
  private query = '';
  private errorMessage = '';

  constructor() {
    const titleKey = t('panels.osintWorkbench');
    super({
      id: 'osint-workbench',
      title: titleKey === 'panels.osintWorkbench' ? 'OSINT Workbench' : titleKey,
      trackActivity: false,
    });

    this.content.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;
      const select = target.closest<HTMLSelectElement>('.osint-type-select');
      if (!select) return;
      this.indicatorType = (select.value as IndicatorType) || 'ip';
      this.render();
    });

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.osint-run-btn')) {
        this.executeSearch();
        return;
      }
      if (target.closest('.osint-open-all-btn')) {
        const tools = this.getTools();
        if (!this.query) return;
        for (const tool of tools) {
          const url = tool.buildUrl(this.query);
          window.open(url, '_blank', 'noopener');
        }
      }
    });

    this.content.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.osint-query-input')) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.executeSearch();
      }
    });

    this.render();
  }

  private getTools(): OsintTool[] {
    return TOOL_MAP[this.indicatorType] || TOOL_MAP.ip;
  }

  private executeSearch(): void {
    const input = this.content.querySelector<HTMLInputElement>('.osint-query-input');
    const query = input?.value.trim() ?? '';
    if (!query) {
      this.errorMessage = 'Enter a value to query.';
      this.render();
      return;
    }
    this.query = query;
    this.errorMessage = '';
    this.render();
  }

  private render(): void {
    const tools = this.getTools();
    const indicatorOptions: IndicatorType[] = ['ip', 'domain', 'url', 'hash', 'email', 'username', 'asn'];
    const activeQuery = this.query;

    const toolRows = activeQuery
      ? tools.map((tool) => {
        const url = tool.buildUrl(activeQuery);
        return `
          <div class="osint-result-item">
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(tool.label)}</a>
            ${tool.note ? `<span>${escapeHtml(tool.note)}</span>` : ''}
          </div>
        `;
      }).join('')
      : '<div class="osint-empty">Run a query to generate tool links.</div>';

    const quickLinksHtml = QUICK_LINKS.map((link) => `
      <a class="osint-quick-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener">
        <strong>${escapeHtml(link.label)}</strong>
        <span>${escapeHtml(link.desc)}</span>
      </a>
    `).join('');

    this.setContent(`
      <div class="osint-panel-content">
        <div class="osint-toolbar">
          <label>
            Type
            <select class="osint-type-select">
              ${indicatorOptions.map((type) => `
                <option value="${type}" ${this.indicatorType === type ? 'selected' : ''}>${type.toUpperCase()}</option>
              `).join('')}
            </select>
          </label>
          <input class="osint-query-input" type="text" placeholder="IP, domain, URL, hash, email, username, ASN" value="${escapeHtml(activeQuery)}" />
          <button class="osint-run-btn">Generate Links</button>
        </div>
        ${this.errorMessage ? `<div class="osint-error">${escapeHtml(this.errorMessage)}</div>` : ''}
        <div class="osint-results-header">
          <span>Targets for ${escapeHtml(this.indicatorType.toUpperCase())}</span>
          <button class="osint-open-all-btn" ${activeQuery ? '' : 'disabled'}>Open All</button>
        </div>
        <div class="osint-results">${toolRows}</div>
        <div class="osint-framework-links">
          ${quickLinksHtml}
        </div>
      </div>
    `);
  }
}

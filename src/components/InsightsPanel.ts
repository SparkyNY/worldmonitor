import { Panel } from './Panel';
import { mlWorker } from '@/services/ml-worker';
import { generateSummary, type SummarizationProvider } from '@/services/summarization';
import { isMobileDevice } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import type { ClusteredEvent } from '@/types';

export class InsightsPanel extends Panel {
  private isHidden = false;
  private lastBriefUpdate = 0;
  private cachedBrief: string | null = null;
  private briefProvider: SummarizationProvider | null = null;
  private static readonly BRIEF_COOLDOWN_MS = 120000; // 2 min cooldown (API has limits)

  constructor() {
    super({
      id: 'insights',
      title: 'AI INSIGHTS',
      showCount: false,
      infoTooltip: `
        <strong>AI-Powered Analysis</strong><br>
        • <strong>World Brief</strong>: AI summary (Groq/OpenRouter)<br>
        • <strong>Sentiment</strong>: News tone analysis<br>
        • <strong>Velocity</strong>: Fast-moving stories<br>
        <em>Desktop only • Powered by Llama 3.3</em>
      `,
    });

    if (isMobileDevice()) {
      this.hide();
      this.isHidden = true;
    }
  }

  // High-priority military/conflict keywords (huge boost)
  private static readonly MILITARY_KEYWORDS = [
    'war', 'armada', 'invasion', 'airstrike', 'strike', 'missile', 'troops',
    'deployed', 'offensive', 'artillery', 'bomb', 'combat', 'fleet', 'warship',
    'carrier', 'navy', 'airforce', 'deployment', 'mobilization', 'attack',
  ];

  // Geopolitical flashpoints (major boost)
  private static readonly FLASHPOINT_KEYWORDS = [
    'iran', 'russia', 'china', 'taiwan', 'ukraine', 'north korea', 'israel', 'gaza',
    'syria', 'yemen', 'hezbollah', 'hamas', 'kremlin', 'pentagon', 'nato',
  ];

  // Crisis keywords (moderate boost)
  private static readonly CRISIS_KEYWORDS = [
    'crisis', 'emergency', 'catastrophe', 'disaster', 'collapse', 'martial law',
    'sanctions', 'ultimatum', 'threat', 'retaliation', 'escalation', 'tensions',
  ];

  // Business/tech context that should REDUCE score (demote business news with military words)
  private static readonly DEMOTE_KEYWORDS = [
    'ceo', 'earnings', 'stock', 'startup', 'data center', 'datacenter', 'revenue',
    'quarterly', 'profit', 'investor', 'ipo', 'funding', 'valuation',
  ];

  private getImportanceScore(cluster: ClusteredEvent): number {
    let score = 0;
    const titleLower = cluster.primaryTitle.toLowerCase();

    // Source confirmation (base signal)
    score += cluster.sourceCount * 10;

    // Military keywords: highest priority (+80 base, +20 per match)
    const militaryMatches = InsightsPanel.MILITARY_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (militaryMatches.length > 0) {
      score += 80 + (militaryMatches.length * 20);
    }

    // Flashpoint keywords: high priority (+60 base, +15 per match)
    const flashpointMatches = InsightsPanel.FLASHPOINT_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (flashpointMatches.length > 0) {
      score += 60 + (flashpointMatches.length * 15);
    }

    // Crisis keywords: moderate priority (+30 base, +10 per match)
    const crisisMatches = InsightsPanel.CRISIS_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (crisisMatches.length > 0) {
      score += 30 + (crisisMatches.length * 10);
    }

    // Demote business/tech news that happens to contain military words
    const demoteMatches = InsightsPanel.DEMOTE_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (demoteMatches.length > 0) {
      score *= 0.3; // Heavy penalty for business context
    }

    // Velocity multiplier
    const velMultiplier: Record<string, number> = {
      'viral': 3,
      'spike': 2.5,
      'elevated': 1.5,
      'normal': 1
    };
    score *= velMultiplier[cluster.velocity?.level ?? 'normal'] ?? 1;

    // Alert bonus
    if (cluster.isAlert) score += 50;

    // Recency bonus (decay over 12 hours)
    const ageMs = Date.now() - cluster.firstSeen.getTime();
    const ageHours = ageMs / 3600000;
    const recencyMultiplier = Math.max(0.5, 1 - (ageHours / 12));
    score *= recencyMultiplier;

    return score;
  }

  private selectTopStories(clusters: ClusteredEvent[], maxCount: number): ClusteredEvent[] {
    // Filter: require at least 2 sources OR alert OR elevated+ velocity
    const candidates = clusters.filter(c =>
      c.sourceCount >= 2 ||
      c.isAlert ||
      (c.velocity && c.velocity.level !== 'normal')
    );

    // Score and sort
    const scored = candidates
      .map(c => ({ cluster: c, score: this.getImportanceScore(c) }))
      .sort((a, b) => b.score - a.score);

    // Select with source diversity (max 3 from same primary source)
    const selected: ClusteredEvent[] = [];
    const sourceCount = new Map<string, number>();
    const MAX_PER_SOURCE = 3;

    for (const { cluster } of scored) {
      const source = cluster.primarySource;
      const count = sourceCount.get(source) || 0;

      if (count < MAX_PER_SOURCE) {
        selected.push(cluster);
        sourceCount.set(source, count + 1);
      }

      if (selected.length >= maxCount) break;
    }

    return selected;
  }

  private setProgress(step: number, total: number, message: string): void {
    const percent = Math.round((step / total) * 100);
    this.setContent(`
      <div class="insights-progress">
        <div class="insights-progress-bar">
          <div class="insights-progress-fill" style="width: ${percent}%"></div>
        </div>
        <div class="insights-progress-info">
          <span class="insights-progress-step">Step ${step}/${total}</span>
          <span class="insights-progress-message">${message}</span>
        </div>
      </div>
    `);
  }

  public async updateInsights(clusters: ClusteredEvent[]): Promise<void> {
    if (this.isHidden) return;

    if (clusters.length === 0) {
      this.setContent('<div class="insights-empty">Waiting for news data...</div>');
      return;
    }

    const totalSteps = 3;

    try {
      // Step 1: Filter and rank stories by composite importance score
      this.setProgress(1, totalSteps, 'Ranking important stories...');

      const importantClusters = this.selectTopStories(clusters, 8);

      if (importantClusters.length === 0) {
        this.setContent('<div class="insights-empty">No breaking or multi-source stories yet</div>');
        return;
      }

      const titles = importantClusters.map(c => c.primaryTitle);

      // Step 2: Analyze sentiment (browser-based, fast)
      this.setProgress(2, totalSteps, 'Analyzing sentiment...');
      let sentiments: Array<{ label: string; score: number }> | null = null;

      if (mlWorker.isAvailable) {
        sentiments = await mlWorker.classifySentiment(titles).catch(() => null);
      }

      // Step 3: Generate World Brief (with cooldown)
      let worldBrief = this.cachedBrief;
      const now = Date.now();

      if (!worldBrief || now - this.lastBriefUpdate > InsightsPanel.BRIEF_COOLDOWN_MS) {
        this.setProgress(3, totalSteps, 'Generating world brief...');

        const result = await generateSummary(titles, (_step, _total, msg) => {
          // Show sub-progress for summarization
          this.setProgress(3, totalSteps, `Generating brief: ${msg}`);
        });

        if (result) {
          worldBrief = result.summary;
          this.cachedBrief = worldBrief;
          this.briefProvider = result.provider;
          this.lastBriefUpdate = now;
          console.log(`[InsightsPanel] Brief from ${result.provider}${result.cached ? ' (cached)' : ''}`);
        }
      } else {
        this.setProgress(3, totalSteps, 'Using cached brief...');
      }

      this.renderInsights(importantClusters, sentiments, worldBrief);
    } catch (error) {
      console.error('[InsightsPanel] Error:', error);
      this.setContent('<div class="insights-error">Analysis failed - retrying...</div>');
    }
  }

  private renderInsights(
    clusters: ClusteredEvent[],
    sentiments: Array<{ label: string; score: number }> | null,
    worldBrief: string | null
  ): void {
    const briefHtml = worldBrief ? this.renderWorldBrief(worldBrief) : '';
    const sentimentOverview = this.renderSentimentOverview(sentiments);
    const breakingHtml = this.renderBreakingStories(clusters, sentiments);
    const statsHtml = this.renderStats(clusters);

    this.setContent(`
      ${briefHtml}
      ${sentimentOverview}
      ${statsHtml}
      <div class="insights-section">
        <div class="insights-section-title">BREAKING & CONFIRMED</div>
        ${breakingHtml}
      </div>
    `);
  }

  private renderWorldBrief(brief: string): string {
    const providerBadge = this.briefProvider && this.briefProvider !== 'cache'
      ? `<span class="insights-provider">${this.briefProvider}</span>`
      : '';

    return `
      <div class="insights-brief">
        <div class="insights-section-title">🌍 WORLD BRIEF ${providerBadge}</div>
        <div class="insights-brief-text">${escapeHtml(brief)}</div>
      </div>
    `;
  }

  private renderBreakingStories(
    clusters: ClusteredEvent[],
    sentiments: Array<{ label: string; score: number }> | null
  ): string {
    return clusters.map((cluster, i) => {
      const sentiment = sentiments?.[i];
      const sentimentClass = sentiment?.label === 'negative' ? 'negative' :
        sentiment?.label === 'positive' ? 'positive' : 'neutral';

      const badges: string[] = [];

      if (cluster.sourceCount >= 3) {
        badges.push(`<span class="insight-badge confirmed">✓ ${cluster.sourceCount} sources</span>`);
      } else if (cluster.sourceCount >= 2) {
        badges.push(`<span class="insight-badge multi">${cluster.sourceCount} sources</span>`);
      }

      if (cluster.velocity && cluster.velocity.level !== 'normal') {
        const velIcon = cluster.velocity.trend === 'rising' ? '↑' : '';
        badges.push(`<span class="insight-badge velocity ${cluster.velocity.level}">${velIcon}+${cluster.velocity.sourcesPerHour}/hr</span>`);
      }

      if (cluster.isAlert) {
        badges.push('<span class="insight-badge alert">⚠ ALERT</span>');
      }

      return `
        <div class="insight-story">
          <div class="insight-story-header">
            <span class="insight-sentiment-dot ${sentimentClass}"></span>
            <span class="insight-story-title">${escapeHtml(cluster.primaryTitle.slice(0, 100))}${cluster.primaryTitle.length > 100 ? '...' : ''}</span>
          </div>
          ${badges.length > 0 ? `<div class="insight-badges">${badges.join('')}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  private renderSentimentOverview(sentiments: Array<{ label: string; score: number }> | null): string {
    if (!sentiments || sentiments.length === 0) {
      return '';
    }

    const negative = sentiments.filter(s => s.label === 'negative').length;
    const positive = sentiments.filter(s => s.label === 'positive').length;
    const neutral = sentiments.length - negative - positive;

    const total = sentiments.length;
    const negPct = Math.round((negative / total) * 100);
    const neuPct = Math.round((neutral / total) * 100);
    const posPct = 100 - negPct - neuPct;

    let toneLabel = 'Mixed';
    let toneClass = 'neutral';
    if (negative > positive + neutral) {
      toneLabel = 'Negative';
      toneClass = 'negative';
    } else if (positive > negative + neutral) {
      toneLabel = 'Positive';
      toneClass = 'positive';
    }

    return `
      <div class="insights-sentiment-bar">
        <div class="sentiment-bar-track">
          <div class="sentiment-bar-negative" style="width: ${negPct}%"></div>
          <div class="sentiment-bar-neutral" style="width: ${neuPct}%"></div>
          <div class="sentiment-bar-positive" style="width: ${posPct}%"></div>
        </div>
        <div class="sentiment-bar-labels">
          <span class="sentiment-label negative">${negative}</span>
          <span class="sentiment-label neutral">${neutral}</span>
          <span class="sentiment-label positive">${positive}</span>
        </div>
        <div class="sentiment-tone ${toneClass}">Overall: ${toneLabel}</div>
      </div>
    `;
  }

  private renderStats(clusters: ClusteredEvent[]): string {
    const multiSource = clusters.filter(c => c.sourceCount >= 2).length;
    const fastMoving = clusters.filter(c => c.velocity && c.velocity.level !== 'normal').length;
    const alerts = clusters.filter(c => c.isAlert).length;

    return `
      <div class="insights-stats">
        <div class="insight-stat">
          <span class="insight-stat-value">${multiSource}</span>
          <span class="insight-stat-label">Multi-source</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-value">${fastMoving}</span>
          <span class="insight-stat-label">Fast-moving</span>
        </div>
        ${alerts > 0 ? `
        <div class="insight-stat alert">
          <span class="insight-stat-value">${alerts}</span>
          <span class="insight-stat-label">Alerts</span>
        </div>
        ` : ''}
      </div>
    `;
  }
}

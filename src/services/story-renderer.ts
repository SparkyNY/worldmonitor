import type { StoryData } from './story-data';

const W = 1080;
const H = 1920;

const LEVEL_COLORS: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', elevated: '#eab308', normal: '#22c55e', low: '#3b82f6',
};
const THREAT_COLORS: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e', info: '#3b82f6',
};

export function renderStoryToCanvas(data: StoryData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // Subtle grid pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx < W; gx += 40) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
  }
  for (let gy = 0; gy < H; gy += 40) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
  }

  let y = 0;
  const PAD = 72;
  const RIGHT = W - PAD;

  // ── HEADER ──
  y = 60;
  ctx.fillStyle = '#555';
  ctx.font = '700 30px Inter, system-ui, sans-serif';
  ctx.letterSpacing = '6px';
  ctx.fillText('WORLDMONITOR', PAD, y + 26);
  ctx.letterSpacing = '0px';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  ctx.font = '400 24px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#444';
  const dateW = ctx.measureText(dateStr).width;
  ctx.fillText(dateStr, RIGHT - dateW, y + 26);

  y += 56;
  drawSeparator(ctx, y, PAD);

  // ── COUNTRY NAME ──
  y += 70;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 82px Inter, system-ui, sans-serif';
  ctx.fillText(data.countryName.toUpperCase(), PAD, y);

  // Country code badge
  ctx.font = '700 28px Inter, system-ui, sans-serif';
  const codeLabel = data.countryCode;
  const codeLabelW = ctx.measureText(codeLabel).width + 24;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  roundRect(ctx, RIGHT - codeLabelW, y - 28, codeLabelW, 36, 6);
  ctx.fill();
  ctx.fillStyle = '#888';
  ctx.fillText(codeLabel, RIGHT - codeLabelW + 12, y - 2);

  // ── CII SCORE ──
  const levelColor = LEVEL_COLORS[data.cii?.level || 'normal'] || '#888';
  const score = data.cii?.score ?? 0;

  y += 56;
  // Large score
  ctx.fillStyle = levelColor;
  ctx.font = '800 64px Inter, system-ui, sans-serif';
  ctx.fillText(`${score}`, PAD, y);
  const scoreNumW = ctx.measureText(`${score}`).width;
  ctx.fillStyle = '#666';
  ctx.font = '400 34px Inter, system-ui, sans-serif';
  ctx.fillText('/100', PAD + scoreNumW + 4, y);
  const slashW = ctx.measureText('/100').width; // measured while font is still 400 34px
  if (data.cii?.change24h) {
    const ch = data.cii.change24h;
    const chSign = ch > 0 ? '+' : '';
    ctx.fillStyle = ch > 0 ? '#ef4444' : ch < 0 ? '#22c55e' : '#888';
    ctx.font = '600 26px Inter, system-ui, sans-serif';
    ctx.fillText(`${chSign}${ch} 24h`, PAD + scoreNumW + 4 + slashW + 16, y);
  }

  // Trend + level on same line
  const trendIcon = data.cii?.trend === 'rising' ? '▲' : data.cii?.trend === 'falling' ? '▼' : '●';
  const trendLabel = (data.cii?.trend || 'stable').toUpperCase();
  const levelLabel = (data.cii?.level || 'normal').toUpperCase();

  ctx.font = '700 26px Inter, system-ui, sans-serif';
  ctx.fillStyle = levelColor;
  const badgeText = `${trendIcon} ${trendLabel}`;
  const badgeTextW = ctx.measureText(badgeText).width + 28;
  roundRect(ctx, RIGHT - badgeTextW, y - 26, badgeTextW, 34, 6);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(badgeText, RIGHT - badgeTextW + 14, y - 3);

  // Level badge
  ctx.font = '600 22px Inter, system-ui, sans-serif';
  const lvlW = ctx.measureText(levelLabel).width + 24;
  const lvlX = RIGHT - badgeTextW - lvlW - 12;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, lvlX, y - 24, lvlW, 30, 4);
  ctx.fill();
  ctx.fillStyle = levelColor;
  ctx.fillText(levelLabel, lvlX + 12, y - 3);

  // Score bar
  y += 28;
  const barW = W - PAD * 2;
  ctx.fillStyle = '#1a1a2e';
  roundRect(ctx, PAD, y, barW, 16, 8);
  ctx.fill();
  if (score > 0) {
    ctx.fillStyle = levelColor;
    roundRect(ctx, PAD, y, barW * score / 100, 16, 8);
    ctx.fill();
  }

  // Component scores with visual bars
  if (data.cii?.components) {
    y += 40;
    const comps = [
      { label: 'UNREST', val: data.cii.components.unrest, color: '#f97316' },
      { label: 'SECURITY', val: data.cii.components.security, color: '#ef4444' },
      { label: 'INFORMATION', val: data.cii.components.information, color: '#8b5cf6' },
    ];
    const compBarW = (barW - 24) / 3;
    for (const comp of comps) {
      const cx = PAD + comps.indexOf(comp) * (compBarW + 12);
      ctx.fillStyle = '#555';
      ctx.font = '600 18px Inter, system-ui, sans-serif';
      ctx.fillText(comp.label, cx, y);
      ctx.fillStyle = comp.color;
      ctx.font = '700 18px Inter, system-ui, sans-serif';
      const valStr = comp.val.toFixed(0);
      const valW = ctx.measureText(valStr).width;
      ctx.fillText(valStr, cx + compBarW - valW, y);
      ctx.fillStyle = '#1a1a2e';
      roundRect(ctx, cx, y + 6, compBarW, 6, 3);
      ctx.fill();
      ctx.fillStyle = comp.color;
      roundRect(ctx, cx, y + 6, compBarW * Math.min(comp.val, 40) / 40, 6, 3);
      ctx.fill();
    }
    y += 20;
  }

  // ── ACTIVE SIGNALS ──
  const hasSignals = data.signals.protests + data.signals.militaryFlights + data.signals.militaryVessels + data.signals.outages > 0;
  if (hasSignals) {
    y += 36;
    drawSeparator(ctx, y, PAD);
    y += 42;
    drawSectionHeader(ctx, 'ACTIVE SIGNALS', PAD, y);

    y += 42;
    const sigItems = [
      { icon: '📢', label: 'Protests', count: data.signals.protests, color: '#f97316' },
      { icon: '✈', label: 'Military Aircraft', count: data.signals.militaryFlights, color: '#ef4444' },
      { icon: '⚓', label: 'Military Vessels', count: data.signals.militaryVessels, color: '#3b82f6' },
      { icon: '🌐', label: 'Internet Outages', count: data.signals.outages, color: '#8b5cf6' },
    ].filter(s => s.count > 0);

    const colW = (RIGHT - PAD) / Math.min(sigItems.length, 4);
    for (const sig of sigItems) {
      const sx = PAD + sigItems.indexOf(sig) * colW;
      ctx.fillStyle = sig.color;
      ctx.font = '800 36px Inter, system-ui, sans-serif';
      ctx.fillText(`${sig.count}`, sx, y);
      ctx.fillStyle = '#999';
      ctx.font = '400 18px Inter, system-ui, sans-serif';
      ctx.fillText(`${sig.icon} ${sig.label}`, sx, y + 24);
    }
    y += 24;
  }

  // ── CONVERGENCE ──
  if (data.convergence && data.convergence.score > 0) {
    y += 36;
    drawSeparator(ctx, y, PAD);
    y += 42;
    drawSectionHeader(ctx, 'SIGNAL CONVERGENCE', PAD, y);

    y += 42;
    const convScore = Math.round(data.convergence.score);
    const convColor = convScore >= 70 ? '#ef4444' : convScore >= 40 ? '#eab308' : '#22c55e';
    ctx.fillStyle = convColor;
    ctx.font = '800 42px Inter, system-ui, sans-serif';
    ctx.fillText(`${convScore}`, PAD, y);
    const convScoreW = ctx.measureText(`${convScore}`).width;
    ctx.fillStyle = '#666';
    ctx.font = '400 26px Inter, system-ui, sans-serif';
    ctx.fillText('/100 convergence', PAD + convScoreW + 8, y);

    if (data.convergence.signalTypes.length > 0) {
      y += 32;
      ctx.fillStyle = '#888';
      ctx.font = '400 20px Inter, system-ui, sans-serif';
      ctx.fillText(data.convergence.signalTypes.join('  ·  '), PAD, y);
    }

    for (const desc of data.convergence.regionalDescriptions.slice(0, 2)) {
      y += 30;
      ctx.fillStyle = '#777';
      ctx.font = '400 20px Inter, system-ui, sans-serif';
      ctx.fillText(truncateText(ctx, desc, RIGHT - PAD), PAD, y);
    }
  }

  const FOOTER_Y = H - 110;

  // ── TOP HEADLINES ──
  if (data.news.length > 0 && y < FOOTER_Y - 200) {
    y += 36;
    drawSeparator(ctx, y, PAD);
    y += 42;
    drawSectionHeader(ctx, 'TOP HEADLINES', PAD, y);

    for (const item of data.news.slice(0, 5)) {
      if (y > FOOTER_Y - 80) break;
      y += 50;
      const tc = THREAT_COLORS[item.threatLevel] || '#3b82f6';

      // Threat badge
      const label = item.threatLevel.toUpperCase();
      ctx.font = '700 18px Inter, system-ui, sans-serif';
      const labelW = ctx.measureText(label).width + 16;
      ctx.fillStyle = tc;
      ctx.globalAlpha = 0.2;
      roundRect(ctx, PAD, y - 18, labelW, 24, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = tc;
      ctx.fillText(label, PAD + 8, y);

      // Title with word wrap
      ctx.fillStyle = '#ddd';
      ctx.font = '400 24px Inter, system-ui, sans-serif';
      const titleX = PAD + labelW + 12;
      const maxTitleW = RIGHT - titleX;
      const title = truncateText(ctx, item.title, maxTitleW);
      ctx.fillText(title, titleX, y);

      // Source count
      if (item.sourceCount > 1) {
        ctx.fillStyle = '#555';
        ctx.font = '400 16px Inter, system-ui, sans-serif';
        const srcText = `${item.sourceCount} sources`;
        const srcW = ctx.measureText(srcText).width;
        ctx.fillText(srcText, RIGHT - srcW, y);
      }
    }

    y += 32;
    const totalSources = data.news.reduce((s, n) => s + (n.sourceCount || 1), 0);
    const alertCount = data.news.filter(n => n.threatLevel === 'critical' || n.threatLevel === 'high').length;
    ctx.fillStyle = '#444';
    ctx.font = '400 20px Inter, system-ui, sans-serif';
    let statsText = `${totalSources} sources across ${data.news.length} stories`;
    if (alertCount > 0) statsText += `  ·  ${alertCount} high-priority alerts`;
    ctx.fillText(statsText, PAD, y);
  }

  // ── MILITARY POSTURE ──
  if (data.theater && y < FOOTER_Y - 200) {
    y += 36;
    drawSeparator(ctx, y, PAD);
    y += 42;
    drawSectionHeader(ctx, 'MILITARY POSTURE', PAD, y);

    const postureColor = data.theater.postureLevel === 'critical' ? '#ef4444'
      : data.theater.postureLevel === 'elevated' ? '#f97316' : '#22c55e';

    y += 48;
    ctx.fillStyle = '#ddd';
    ctx.font = '600 30px Inter, system-ui, sans-serif';
    ctx.fillText(data.theater.theaterName, PAD, y);

    // Posture badge
    const pLabel = data.theater.postureLevel.toUpperCase();
    ctx.font = '700 24px Inter, system-ui, sans-serif';
    const pLabelW = ctx.measureText(pLabel).width + 24;
    ctx.fillStyle = postureColor;
    roundRect(ctx, RIGHT - pLabelW, y - 24, pLabelW, 32, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(pLabel, RIGHT - pLabelW + 12, y - 2);

    y += 44;
    ctx.font = '400 26px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`✈ ${data.theater.totalAircraft} aircraft`, PAD, y);
    const acW = ctx.measureText(`✈ ${data.theater.totalAircraft} aircraft`).width;
    ctx.fillText(`⚓ ${data.theater.totalVessels} vessels`, PAD + acW + 40, y);

    if (data.theater.fighters || data.theater.tankers || data.theater.awacs) {
      y += 36;
      ctx.fillStyle = '#666';
      ctx.font = '400 22px Inter, system-ui, sans-serif';
      const parts: string[] = [];
      if (data.theater.fighters) parts.push(`Fighters: ${data.theater.fighters}`);
      if (data.theater.tankers) parts.push(`Tankers: ${data.theater.tankers}`);
      if (data.theater.awacs) parts.push(`AWACS: ${data.theater.awacs}`);
      ctx.fillText(parts.join('   ·   '), PAD, y);
    }

    if (data.theater.strikeCapable) {
      y += 36;
      ctx.fillStyle = '#ef4444';
      ctx.font = '700 22px Inter, system-ui, sans-serif';
      ctx.fillText('⚠ STRIKE CAPABLE', PAD, y);
    }
  }

  // ── PREDICTION MARKETS ──
  if (data.markets.length > 0 && y < FOOTER_Y - 150) {
    y += 36;
    drawSeparator(ctx, y, PAD);
    y += 42;
    drawSectionHeader(ctx, 'PREDICTION MARKETS', PAD, y);

    for (const m of data.markets.slice(0, 4)) {
      y += 46;
      const title = truncateText(ctx, m.title, RIGHT - PAD - 120);
      ctx.fillStyle = '#ccc';
      ctx.font = '400 24px Inter, system-ui, sans-serif';
      ctx.fillText(title, PAD, y);

      // Percentage — yesPrice is already 0-100
      const pct = Math.round(m.yesPrice);
      const pctStr = `${pct}%`;
      const pctColor = pct >= 70 ? '#ef4444' : pct >= 40 ? '#eab308' : '#22c55e';
      ctx.fillStyle = pctColor;
      ctx.font = '700 26px Inter, system-ui, sans-serif';
      const pctW = ctx.measureText(pctStr).width;
      ctx.fillText(pctStr, RIGHT - pctW, y);
    }
  }

  // ── THREAT BREAKDOWN ──
  const hasThreats = data.threats.critical + data.threats.high + data.threats.medium > 0;
  if (hasThreats && y < FOOTER_Y - 150) {
    y += 36;
    drawSeparator(ctx, y, PAD);
    y += 42;
    drawSectionHeader(ctx, 'THREAT BREAKDOWN', PAD, y);

    y += 44;
    const threatBars = [
      { label: 'Critical', count: data.threats.critical, color: '#ef4444' },
      { label: 'High', count: data.threats.high, color: '#f97316' },
      { label: 'Medium', count: data.threats.medium, color: '#eab308' },
    ].filter(t => t.count > 0);

    const maxCount = Math.max(...threatBars.map(t => t.count));
    for (const t of threatBars) {
      ctx.fillStyle = t.color;
      ctx.font = '700 24px Inter, system-ui, sans-serif';
      ctx.fillText(`${t.count}`, PAD, y);
      ctx.fillStyle = '#aaa';
      ctx.font = '400 24px Inter, system-ui, sans-serif';
      const numW = ctx.measureText(`${t.count}`).width;
      ctx.fillText(` ${t.label}`, PAD + numW, y);

      // Visual bar
      const barStartX = PAD + 180;
      const maxBarW = RIGHT - barStartX;
      const bw = maxBarW * (t.count / maxCount);
      ctx.fillStyle = t.color;
      ctx.globalAlpha = 0.3;
      roundRect(ctx, barStartX, y - 16, bw, 22, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      y += 36;
    }

    if (data.threats.categories.length > 0) {
      y += 4;
      ctx.fillStyle = '#666';
      ctx.font = '400 22px Inter, system-ui, sans-serif';
      ctx.fillText(data.threats.categories.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join('  ·  '), PAD, y);
    }
  }

  // ── FOOTER ──
  const timeStr = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 90);
  ctx.lineTo(RIGHT, H - 90);
  ctx.stroke();

  ctx.fillStyle = '#333';
  ctx.font = '600 22px Inter, system-ui, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillText('WORLDMONITOR.APP', PAD, H - 52);
  ctx.letterSpacing = '0px';
  ctx.font = '400 20px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#444';
  const tw = ctx.measureText(timeStr).width;
  ctx.fillText(timeStr, RIGHT - tw, H - 52);

  // Subtle branding line
  ctx.fillStyle = '#333';
  ctx.font = '400 18px Inter, system-ui, sans-serif';
  ctx.fillText('Real-time global intelligence monitoring', PAD, H - 28);

  return canvas;
}

function drawSeparator(ctx: CanvasRenderingContext2D, y: number, pad: number): void {
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(W - pad, y);
  ctx.stroke();
}

function drawSectionHeader(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.fillStyle = '#555';
  ctx.font = '700 24px Inter, system-ui, sans-serif';
  ctx.letterSpacing = '4px';
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '...').width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '...';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

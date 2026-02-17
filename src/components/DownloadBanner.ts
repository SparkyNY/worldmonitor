import { isDesktopRuntime } from '@/services/runtime';
import { t } from '@/services/i18n';
import { isMobileDevice } from '@/utils';

const STORAGE_KEY = 'wm-download-banner-dismissed';
const SHOW_DELAY_MS = 12_000;
let bannerScheduled = false;

export function maybeShowDownloadBanner(): void {
  if (bannerScheduled) return;
  if (isDesktopRuntime()) return;
  if (isMobileDevice()) return;
  if (localStorage.getItem(STORAGE_KEY)) return;

  bannerScheduled = true;
  setTimeout(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const panel = buildPanel();
    document.body.appendChild(panel);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => panel.classList.add('wm-dl-show'));
    });
  }, SHOW_DELAY_MS);
}

function dismiss(panel: HTMLElement): void {
  localStorage.setItem(STORAGE_KEY, '1');
  panel.classList.remove('wm-dl-show');
  panel.addEventListener('transitionend', () => panel.remove(), { once: true });
}

type Platform = 'macos-arm64' | 'macos-x64' | 'macos' | 'windows' | 'unknown';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) {
    // WebGL renderer can reveal Apple Silicon vs Intel GPU
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') as WebGLRenderingContext | null;
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          if (/Apple M/i.test(renderer)) return 'macos-arm64';
          if (/Intel/i.test(renderer)) return 'macos-x64';
        }
      }
    } catch { /* ignore */ }
    // Can't determine architecture — show both Mac options
    return 'macos';
  }
  return 'unknown';
}

interface DlButton { cls: string; href: string; label: string }

const ALL_BUTTONS: DlButton[] = [
  { cls: 'mac', href: '/api/download?platform=macos-arm64', label: '\uF8FF macOS (Apple Silicon)' },
  { cls: 'mac', href: '/api/download?platform=macos-x64',   label: '\uF8FF macOS (Intel)' },
  { cls: 'win', href: '/api/download?platform=windows-exe',  label: '\u229E Windows (.exe)' },
];

function buttonsForPlatform(p: Platform): DlButton[] {
  switch (p) {
    case 'macos-arm64': return ALL_BUTTONS.filter(b => b.href.includes('macos-arm64'));
    case 'macos-x64':   return ALL_BUTTONS.filter(b => b.href.includes('macos-x64'));
    case 'macos':       return ALL_BUTTONS.filter(b => b.cls === 'mac');
    case 'windows':     return ALL_BUTTONS.filter(b => b.cls === 'win');
    default:            return ALL_BUTTONS;
  }
}

function renderButtons(container: HTMLElement, buttons: DlButton[], panel: HTMLElement): void {
  container.innerHTML = buttons
    .map(b => `<a class="wm-dl-btn ${b.cls}" href="${b.href}">${b.label}</a>`)
    .join('');
  container.querySelectorAll('.wm-dl-btn').forEach(btn =>
    btn.addEventListener('click', () => dismiss(panel))
  );
}

function buildPanel(): HTMLElement {
  const platform = detectPlatform();
  const primaryButtons = buttonsForPlatform(platform);
  const showToggle = platform !== 'unknown' && primaryButtons.length < ALL_BUTTONS.length;

  const el = document.createElement('div');
  el.className = 'wm-dl-panel';
  el.innerHTML = `
    <style>
      .wm-dl-panel {
        position: fixed;
        top: 48px;
        right: 0;
        z-index: 900;
        width: 230px;
        background: var(--surface);
        border-left: 3px solid var(--green);
        border-bottom: 1px solid var(--border);
        border-bottom-left-radius: 8px;
        padding: 14px;
        transform: translateX(110%);
        transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        font-family: inherit;
      }
      .wm-dl-panel.wm-dl-show { transform: translateX(0); }
      .wm-dl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .wm-dl-title {
        font-size: 11px; font-weight: 700; color: var(--green);
        text-transform: uppercase; letter-spacing: 0.5px;
        display: flex; align-items: center; gap: 5px;
      }
      .wm-dl-close {
        background: none; border: none; color: var(--text-dim);
        font-size: 14px; cursor: pointer; padding: 0 2px; line-height: 1;
      }
      .wm-dl-close:hover { color: var(--text); }
      .wm-dl-body { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin-bottom: 12px; }
      .wm-dl-btns { display: flex; flex-direction: column; gap: 5px; }
      .wm-dl-btn {
        display: flex; align-items: center; gap: 6px;
        padding: 7px 10px; border-radius: 6px;
        font-size: 10px; font-weight: 600;
        cursor: pointer; text-decoration: none;
        transition: background 0.15s;
      }
      .wm-dl-btn.mac {
        background: color-mix(in srgb, var(--green) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--green) 20%, transparent);
        color: var(--green);
      }
      .wm-dl-btn.mac:hover { background: color-mix(in srgb, var(--green) 18%, transparent); }
      .wm-dl-btn.win {
        background: color-mix(in srgb, var(--semantic-info) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--semantic-info) 18%, transparent);
        color: var(--semantic-info);
      }
      .wm-dl-btn.win:hover { background: color-mix(in srgb, var(--semantic-info) 15%, transparent); }
      .wm-dl-toggle {
        background: none; border: none; color: var(--text-dim, #888);
        font-size: 9px; cursor: pointer; padding: 4px 0 0; text-align: center;
        width: 100%;
      }
      .wm-dl-toggle:hover { color: var(--text, #e8e8e8); }
    </style>
    <div class="wm-dl-head">
      <div class="wm-dl-title">\u{1F5A5} ${t('modals.downloadBanner.title')}</div>
      <button class="wm-dl-close" aria-label="${t('modals.downloadBanner.dismiss')}">\u00D7</button>
    </div>
    <div class="wm-dl-body">${t('modals.downloadBanner.description')}</div>
    <div class="wm-dl-body">${t('modals.downloadBanner.description')}</div>
    <div class="wm-dl-btns"></div>
    ${showToggle ? '<button class="wm-dl-toggle">Show all platforms</button>' : ''}
  `;

  const btnsContainer = el.querySelector('.wm-dl-btns') as HTMLElement;
  renderButtons(btnsContainer, primaryButtons, el);

  el.querySelector('.wm-dl-close')!.addEventListener('click', () => dismiss(el));

  const toggle = el.querySelector('.wm-dl-toggle');
  if (toggle) {
    let showingAll = false;
    toggle.addEventListener('click', () => {
      showingAll = !showingAll;
      renderButtons(btnsContainer, showingAll ? ALL_BUTTONS : primaryButtons, el);
      toggle.textContent = showingAll ? 'Show less' : 'Show all platforms';
    });
  }

  return el;
}

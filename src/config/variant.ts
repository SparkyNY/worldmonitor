export const SITE_VARIANT: string = (() => {
  const env = import.meta.env.VITE_VARIANT || 'full';

  // Build-time variant takes priority for variant-specific dev/build commands.
  if (env !== 'full') return env;
  if (typeof window === 'undefined') return env;

  const host = location.hostname;
  if (host.startsWith('tech.')) return 'tech';
  if (host.startsWith('finance.')) return 'finance';
  if (host.startsWith('happy.')) return 'happy';
  if (host.startsWith('gtd.')) return 'gtd';
  if (host.startsWith('local.')) return 'local';
  if (host.startsWith('osint.')) return 'osint';

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  if (isTauri || isLocalHost) {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (
      stored === 'tech'
      || stored === 'full'
      || stored === 'gtd'
      || stored === 'finance'
      || stored === 'happy'
      || stored === 'local'
      || stored === 'osint'
    ) return stored;
  }

  return env;
})();

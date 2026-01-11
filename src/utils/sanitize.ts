const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

export function sanitizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  try {
    // Try as absolute URL first
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    // Not absolute - try as relative URL
    try {
      const base = typeof window !== 'undefined' ? window.location.origin : 'https://example.com';
      const resolved = new URL(trimmed, base);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return trimmed; // Return original relative URL, browser will resolve it
      }
    } catch {
      // Invalid URL
    }
  }
  return '';
}

export function escapeAttr(str: string): string {
  return escapeHtml(str);
}

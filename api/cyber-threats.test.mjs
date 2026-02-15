import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler, {
  __resetCyberThreatsState,
  __testDedupeThreats,
  __testParseFeodoRecords,
} from './cyber-threats.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URLHAUS_KEY = process.env.URLHAUS_AUTH_KEY;

function makeRequest(path = '/api/cyber-threats', ip = '198.51.100.10') {
  const headers = new Headers();
  headers.set('x-forwarded-for', ip);
  return new Request(`https://worldmonitor.app${path}`, { headers });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.URLHAUS_AUTH_KEY = ORIGINAL_URLHAUS_KEY;
  __resetCyberThreatsState();
});

test('Feodo parser filters offline/stale entries and normalizes dates', () => {
  const nowMs = Date.parse('2026-02-15T12:00:00.000Z');
  const records = [
    {
      ip_address: '1.2.3.4',
      status: 'online',
      first_seen: '2026-02-14 10:00:00 UTC',
      last_online: '2026-02-15 10:00:00 UTC',
      malware: 'QakBot',
    },
    {
      ip_address: '5.6.7.8',
      status: 'offline',
      first_seen: '2026-02-14 10:00:00 UTC',
      last_online: '2026-02-15 10:00:00 UTC',
      malware: 'generic',
    },
    {
      ip_address: '9.9.9.9',
      status: 'online',
      first_seen: '2025-10-01 10:00:00 UTC',
      last_online: '2025-10-02 10:00:00 UTC',
      malware: 'generic',
    },
    {
      ip_address: '2.2.2.2',
      first_seen: '2026-02-14 10:00:00 UTC',
      last_online: '2026-02-15 10:00:00 UTC',
      malware: 'generic',
    },
  ];

  const parsed = __testParseFeodoRecords(records, { nowMs, days: 14 });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].indicator, '1.2.3.4');
  assert.equal(parsed[0].severity, 'critical');
  assert.equal(parsed[0].firstSeen?.endsWith('Z'), true);
  assert.equal(parsed[0].lastSeen?.endsWith('Z'), true);
});

test('dedupes by source + indicatorType + indicator', () => {
  const deduped = __testDedupeThreats([
    {
      id: 'a',
      source: 'feodo',
      type: 'c2_server',
      indicatorType: 'ip',
      indicator: '1.2.3.4',
      severity: 'high',
      tags: ['a'],
      firstSeen: '2026-02-10T00:00:00.000Z',
      lastSeen: '2026-02-11T00:00:00.000Z',
    },
    {
      id: 'b',
      source: 'feodo',
      type: 'c2_server',
      indicatorType: 'ip',
      indicator: '1.2.3.4',
      severity: 'critical',
      tags: ['b'],
      firstSeen: '2026-02-12T00:00:00.000Z',
      lastSeen: '2026-02-13T00:00:00.000Z',
    },
    {
      id: 'c',
      source: 'urlhaus',
      type: 'malicious_url',
      indicatorType: 'domain',
      indicator: 'bad.example',
      severity: 'medium',
      tags: [],
      firstSeen: '2026-02-11T00:00:00.000Z',
      lastSeen: '2026-02-11T01:00:00.000Z',
    },
  ]);

  assert.equal(deduped.length, 2);
  const feodo = deduped.find((item) => item.source === 'feodo');
  assert.equal(feodo?.severity, 'critical');
  assert.equal(feodo?.tags.includes('a'), true);
  assert.equal(feodo?.tags.includes('b'), true);
});

test('API returns success without URLhaus key and marks URLhaus as missing_auth_key', async () => {
  delete process.env.URLHAUS_AUTH_KEY;

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('feodotracker.abuse.ch')) {
      return jsonResponse([
        {
          ip_address: '1.2.3.4',
          status: 'online',
          last_online: '2026-02-15T10:00:00.000Z',
          first_seen: '2026-02-14T10:00:00.000Z',
          malware: 'QakBot',
          country: 'GB',
          lat: 51.5,
          lon: -0.12,
        },
      ]);
    }
    throw new Error(`Unexpected fetch target: ${target}`);
  };

  const response = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.11'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Cache'), 'MISS');

  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.partial, false);
  assert.equal(body.sources.feodo.ok, true);
  assert.equal(body.sources.urlhaus.ok, false);
  assert.equal(body.sources.urlhaus.reason, 'missing_auth_key');
  assert.equal(Array.isArray(body.data), true);
  assert.equal(body.data.length, 1);
});

test('API marks partial=true when URLhaus is enabled but fails', async () => {
  process.env.URLHAUS_AUTH_KEY = 'test-key';

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('feodotracker.abuse.ch')) {
      return jsonResponse([
        {
          ip_address: '1.2.3.4',
          status: 'online',
          last_online: '2026-02-15T10:00:00.000Z',
          first_seen: '2026-02-14T10:00:00.000Z',
          malware: 'QakBot',
          country: 'GB',
          lat: 51.5,
          lon: -0.12,
        },
      ]);
    }

    if (target.includes('urlhaus-api.abuse.ch')) {
      return new Response('boom', { status: 500 });
    }

    throw new Error(`Unexpected fetch target: ${target}`);
  };

  const response = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.12'));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.partial, true);
  assert.equal(body.sources.urlhaus.ok, false);
  assert.equal(body.sources.urlhaus.reason, 'urlhaus_http_500');
});

test('API returns memory cache hit on repeated request', async () => {
  delete process.env.URLHAUS_AUTH_KEY;

  let feodoCalls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('feodotracker.abuse.ch')) {
      feodoCalls += 1;
      return jsonResponse([
        {
          ip_address: '1.2.3.4',
          status: 'online',
          last_online: '2026-02-15T10:00:00.000Z',
          first_seen: '2026-02-14T10:00:00.000Z',
          malware: 'QakBot',
          country: 'GB',
          lat: 51.5,
          lon: -0.12,
        },
      ]);
    }
    throw new Error(`Unexpected fetch target: ${target}`);
  };

  const first = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.13'));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(feodoCalls, 1);

  globalThis.fetch = async () => {
    throw new Error('network should not be hit for memory cache');
  };

  const second = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.13'));
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('X-Cache'), 'MEMORY-HIT');
  assert.equal(feodoCalls, 1);
});

test('API returns stale fallback when upstream fails after fresh cache TTL', async () => {
  delete process.env.URLHAUS_AUTH_KEY;

  const baseNow = Date.parse('2026-02-15T12:00:00.000Z');
  const originalDateNow = Date.now;
  Date.now = () => baseNow;

  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes('feodotracker.abuse.ch')) {
        return jsonResponse([
          {
            ip_address: '1.2.3.4',
            status: 'online',
            last_online: '2026-02-15T10:00:00.000Z',
            first_seen: '2026-02-14T10:00:00.000Z',
            malware: 'QakBot',
            country: 'GB',
            lat: 51.5,
            lon: -0.12,
          },
        ]);
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    };

    const first = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.14'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache'), 'MISS');

    Date.now = () => baseNow + (11 * 60 * 1000); // exceed 10m fresh TTL, still within stale horizon
    globalThis.fetch = async () => {
      throw new Error('forced upstream failure');
    };

    const stale = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.14'));
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('X-Cache'), 'STALE');

    const body = await stale.json();
    assert.equal(body.success, true);
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data.length, 1);
  } finally {
    Date.now = originalDateNow;
  }
});

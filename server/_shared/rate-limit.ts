import { Redis } from '@upstash/redis';

const RATE_LIMIT_REQUESTS = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_WINDOW_SECONDS = RATE_LIMIT_WINDOW_MS / 1000;

let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    redisClient = null;
    return redisClient;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function getClientIp(request: Request): string {
  // Vercel injects x-real-ip from the TCP connection — cannot be spoofed by clients.
  // x-forwarded-for is client-settable and MUST NOT be trusted for rate limiting.
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

export async function checkRateLimit(
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) return null;

  const ip = getClientIp(request);
  const now = Date.now();
  const windowId = Math.floor(now / RATE_LIMIT_WINDOW_MS);
  const reset = (windowId + 1) * RATE_LIMIT_WINDOW_MS;
  const key = `rl:${ip}:${windowId}`;

  try {
    const used = await redis.incr(key);
    if (used === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }

    if (used > RATE_LIMIT_REQUESTS) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(RATE_LIMIT_REQUESTS),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(reset),
          'Retry-After': String(Math.max(1, Math.ceil((reset - now) / 1000))),
          ...corsHeaders,
        },
      });
    }

    return null;
  } catch {
    return null;
  }
}

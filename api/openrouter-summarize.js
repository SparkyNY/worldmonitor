/**
 * OpenRouter API Summarization Endpoint with Redis Caching
 * Fallback when Groq is rate-limited
 * Uses Llama 3.3 70B free model
 * Free tier: 50 requests/day (20/min)
 * Server-side Redis cache for cross-user deduplication
 */

import { Redis } from '@upstash/redis';

export const config = {
  runtime: 'edge',
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const CACHE_TTL_SECONDS = 86400; // 24 hours

// Initialize Redis (lazy - only if env vars present)
let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    redis = new Redis({ url, token });
  }
  return redis;
}

// Generate cache key from headlines (same as groq endpoint)
function getCacheKey(headlines, mode) {
  const sorted = headlines.slice(0, 8).sort().join('|');
  const hash = hashString(`${mode}:${sorted}`);
  return `summary:${hash}`;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// Deduplicate similar headlines (same story from different sources)
function deduplicateHeadlines(headlines) {
  const seen = new Set();
  const unique = [];

  for (const headline of headlines) {
    // Normalize: lowercase, remove punctuation, collapse whitespace
    const normalized = headline.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract key words (4+ chars) for similarity check
    const words = new Set(normalized.split(' ').filter(w => w.length >= 4));

    // Check if this headline is too similar to any we've seen
    let isDuplicate = false;
    for (const seenWords of seen) {
      const intersection = [...words].filter(w => seenWords.has(w));
      const similarity = intersection.length / Math.min(words.size, seenWords.size);
      if (similarity > 0.6) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      seen.add(words);
      unique.push(headline);
    }
  }

  return unique;
}

export default async function handler(request) {
  // Only allow POST
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenRouter API key not configured', fallback: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { headlines, mode = 'brief' } = await request.json();

    if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
      return new Response(JSON.stringify({ error: 'Headlines array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check Redis cache first (shared with Groq endpoint)
    const redisClient = getRedis();
    const cacheKey = getCacheKey(headlines, mode);

    if (redisClient) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached && typeof cached === 'object' && cached.summary) {
          console.log('[OpenRouter] Cache hit:', cacheKey);
          return new Response(JSON.stringify({
            summary: cached.summary,
            model: cached.model || MODEL,
            provider: 'cache',
            cached: true,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch (cacheError) {
        console.warn('[OpenRouter] Cache read error:', cacheError.message);
      }
    }

    // Deduplicate similar headlines (same story from different sources)
    const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 8));
    const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

    let systemPrompt, userPrompt;

    if (mode === 'brief') {
      systemPrompt = 'You synthesize news into a single flowing paragraph. Never use bullet points, numbered lists, or "Here are". Just write the summary directly. Combine related stories. Be extremely concise.';
      userPrompt = `Synthesize these headlines into one paragraph (2-3 sentences max):\n${headlineText}`;
    } else if (mode === 'analysis') {
      systemPrompt = 'Geopolitical analyst. Write flowing prose, no bullets or lists. Identify the key pattern or risk.';
      userPrompt = `Analyze the key pattern in these headlines (2-3 sentences):\n${headlineText}`;
    } else {
      systemPrompt = 'News synthesizer. Write one flowing paragraph, no bullets. Combine similar stories.';
      userPrompt = `Synthesize into one paragraph:\n${headlineText}`;
    }

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'WorldMonitor',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 150,
        top_p: 0.9,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OpenRouter] API error:', response.status, errorText);

      // Return fallback signal for rate limiting
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limited', fallback: true }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'OpenRouter API error', fallback: true }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      return new Response(JSON.stringify({ error: 'Empty response', fallback: true }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Store in Redis cache (shared with Groq endpoint)
    if (redisClient) {
      try {
        await redisClient.set(cacheKey, {
          summary,
          model: MODEL,
          timestamp: Date.now(),
        }, { ex: CACHE_TTL_SECONDS });
        console.log('[OpenRouter] Cached:', cacheKey);
      } catch (cacheError) {
        console.warn('[OpenRouter] Cache write error:', cacheError.message);
      }
    }

    return new Response(JSON.stringify({
      summary,
      model: MODEL,
      provider: 'openrouter',
      cached: false,
      tokens: data.usage?.total_tokens || 0,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800',
      },
    });

  } catch (error) {
    console.error('[OpenRouter] Error:', error);
    return new Response(JSON.stringify({ error: error.message, fallback: true }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

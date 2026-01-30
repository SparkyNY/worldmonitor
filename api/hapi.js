// HDX HAPI (Humanitarian API) proxy
// Returns aggregated conflict event counts per country
// Source: ACLED data aggregated monthly by HDX
export const config = { runtime: 'edge' };

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

export default async function handler(req) {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return Response.json(cache.data, {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1800', 'X-Cache': 'HIT' },
    });
  }

  try {
    const response = await fetch(
      'https://hapi.humdata.org/api/v2/coordination-context/conflict-event?output_format=json&limit=1000&offset=0',
      {
        headers: {
          'Accept': 'application/json',
          'X-HDX-HAPI-APP-IDENTIFIER': 'worldmonitor-app',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HAPI API error: ${response.status}`);
    }

    const rawData = await response.json();
    const records = rawData.data || [];

    // Aggregate by country ISO3 code → most recent month's data
    const byCountry = {};
    for (const r of records) {
      const iso3 = r.location_code || r.admin1_code?.substring(0, 3) || '';
      if (!iso3) continue;

      const month = r.reference_period_start || '';
      const existing = byCountry[iso3];

      if (!existing || month > existing.month) {
        byCountry[iso3] = {
          iso3,
          locationName: r.location_name || '',
          month,
          eventsTotal: r.events || 0,
          eventsPoliticalViolence: r.events_political_violence || 0,
          eventsCivilianTargeting: r.events_civilian_targeting || 0,
          eventsDemonstrations: r.events_demonstrations || 0,
          fatalitiesTotalPoliticalViolence: r.fatalities_political_violence || 0,
          fatalitiesTotalCivilianTargeting: r.fatalities_civilian_targeting || 0,
        };
      } else if (month === existing.month) {
        // Same month — accumulate admin-level data
        existing.eventsTotal += r.events || 0;
        existing.eventsPoliticalViolence += r.events_political_violence || 0;
        existing.eventsCivilianTargeting += r.events_civilian_targeting || 0;
        existing.eventsDemonstrations += r.events_demonstrations || 0;
        existing.fatalitiesTotalPoliticalViolence += r.fatalities_political_violence || 0;
        existing.fatalitiesTotalCivilianTargeting += r.fatalities_civilian_targeting || 0;
      }
    }

    const result = {
      success: true,
      count: Object.keys(byCountry).length,
      countries: Object.values(byCountry),
      cached_at: new Date().toISOString(),
    };

    cache = { data: result, timestamp: now };

    return Response.json(result, {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1800', 'X-Cache': 'MISS' },
    });
  } catch (error) {
    if (cache.data) {
      return Response.json(cache.data, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'X-Cache': 'STALE' },
      });
    }
    return Response.json({ error: `Fetch failed: ${error.message}`, countries: [] }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// UCDP (Uppsala Conflict Data Program) proxy
// Returns conflict classification per country with intensity levels
// No auth required - public API
export const config = { runtime: 'edge' };

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (annual data)

export default async function handler(req) {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return Response.json(cache.data, {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600', 'X-Cache': 'HIT' },
    });
  }

  try {
    // Fetch active conflicts (latest version)
    const response = await fetch('https://ucdpapi.pcr.uu.se/api/ucdpprioconflict/24.1?pagesize=100&page=0', {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`UCDP API error: ${response.status}`);
    }

    const rawData = await response.json();
    const conflicts = rawData.Result || [];

    // Extract most recent year per country with intensity level
    const countryConflicts = {};
    for (const c of conflicts) {
      const locations = c.GWNoLoc || c.SideAID || '';
      const name = c.Location || '';
      const year = c.Year || 0;
      const intensity = c.IntensityLevel || 0;

      // UCDP uses country names, map to entries
      const entry = {
        conflictId: c.ConflictId,
        conflictName: c.SideBID || c.SideB || '',
        location: name,
        year,
        intensityLevel: intensity, // 1=Minor (25-999 deaths/yr), 2=War (1000+ deaths/yr)
        typeOfConflict: c.TypeOfConflict, // 1=extrasystemic, 2=interstate, 3=intrastate, 4=internationalized intrastate
        startDate: c.StartDate,
        startDate2: c.StartDate2,
        sideA: c.SideA,
        sideB: c.SideB || c.SideBID,
        region: c.Region,
      };

      // Keep most recent / highest intensity per location
      if (!countryConflicts[name] || year > countryConflicts[name].year ||
          (year === countryConflicts[name].year && intensity > countryConflicts[name].intensityLevel)) {
        countryConflicts[name] = entry;
      }
    }

    const result = {
      success: true,
      count: Object.keys(countryConflicts).length,
      conflicts: Object.values(countryConflicts),
      cached_at: new Date().toISOString(),
    };

    cache = { data: result, timestamp: now };

    return Response.json(result, {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600', 'X-Cache': 'MISS' },
    });
  } catch (error) {
    // Return stale cache on error
    if (cache.data) {
      return Response.json(cache.data, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'X-Cache': 'STALE' },
      });
    }
    return Response.json({ error: `Fetch failed: ${error.message}`, conflicts: [] }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

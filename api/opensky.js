export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);

  // Build OpenSky API URL with bounding box params
  const params = new URLSearchParams();
  ['lamin', 'lomin', 'lamax', 'lomax'].forEach(key => {
    const val = url.searchParams.get(key);
    if (val) params.set(key, val);
  });

  const openskyUrl = `https://opensky-network.org/api/states/all${params.toString() ? '?' + params.toString() : ''}`;

  try {
    // Simple fetch without auth (anonymous access: 400 credits/day)
    const response = await fetch(openskyUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'WorldMonitor/1.0',
      },
    });

    if (response.status === 429) {
      return Response.json({ error: 'Rate limited', time: Date.now(), states: null }, {
        status: 429,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const data = await response.json();
    return Response.json(data, {
      status: response.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (error) {
    return Response.json({
      error: `OpenSky error: ${error.message}`,
      time: Date.now(),
      states: null
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

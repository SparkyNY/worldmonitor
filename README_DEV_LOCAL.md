# World Monitor Local Dev (macOS)

## 1) Prerequisites

```bash
# Node.js 20+ (includes npm)
brew install node

# Vercel CLI (for frontend + API edge function emulation)
npm install -g vercel
```

## 2) Project setup

```bash
cd /Users/scottbauman/Desktop/worldmonitor-main
cp .env.example .env.local
npm install
```

Optional MBTA key (higher quota, not required):

```bash
echo 'VITE_MBTA_API_KEY=your_mbta_key_here' >> .env.local
```

Optional Amtrak RSS override (if default feed is blocked/timeouts):

```bash
echo 'VITE_AMTRAK_ALERTS_RSS_URL=https://your-working-amtrak-feed.xml' >> .env.local
```

## 3) Run locally (full app with API routes)

```bash
vercel dev
```

Open: http://localhost:3000

## 4) Frontend-only modes (optional)

```bash
npm run dev
npm run dev:local
```

Open: http://localhost:5173

Note: frontend-only mode does not run `api/` edge handlers.

## 5) Boston + Transit smoke test

```bash
npm run test:boston-smoke
```

This checks Boston datasets plus MBTA endpoints once and prints a short pass/fail report.

## 6) Manual Boston workflow

1. Open the `Boston Open Data` panel.
2. Click `Refresh Boston` for a full manual fetch (incidents, layers, transit).
3. Use per-layer `Refresh` for `Police Districts`, `Fire Hydrants`, `Fire Departments`, `Community Centers`, and `Transit Vehicles`.
4. Use `Refresh Transit` in the `Transit Status` section for transit-only updates.
5. Use `Refresh` inside `Crime Incidents` and `Fire Incidents` sections for incident-only updates.
6. Open `Show Provenance` to inspect source URL, fetched time, count, query parameters, and warnings per dataset.

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

## 3) Run locally (full app with API routes)

```bash
vercel dev
```

Open: http://localhost:3000

## 4) Frontend-only mode (optional)

```bash
npm run dev
```

Open: http://localhost:5173

Note: frontend-only mode does not run `api/` edge handlers.

## 5) Boston smoke test

```bash
npm run test:boston-smoke
```

This checks each Boston dataset endpoint once and prints a short pass/fail report.

## 6) Manual Boston workflow

1. Open the `Boston Open Data` panel.
2. Click `Refresh Boston` for full Boston refresh.
3. Use per-layer `Refresh` buttons for `Police Districts`, `Fire Hydrants`, `Fire Departments`, `Community Centers`.
4. Use `Refresh` inside `Crime Incidents` and `Fire Incidents` sections.
5. Open `Show Provenance` to inspect source URL, fetched time, count, query parameters, and warnings per dataset.

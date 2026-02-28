# How To Add A New Boston Layer

## 1) Add dataset config

Edit:
- `src/services/boston-open-data.ts`

Add a `BostonDatasetId` entry and a config in `DATASETS`.

For ArcGIS FeatureServer use:
- `sourceUrl`: `.../FeatureServer/<layer>/query`
- `mode`: `"layer"`
- `queryParams`: `{ where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326 }`

## 2) Wire into refresh flow

Edit:
- `src/app/data-loader.ts`

Update:
- `ingestBostonPayload()` to route the dataset to map setters and provenance state.
- `pushBostonStateToUi()` if panel needs extra fields.

## 3) Add map rendering hooks

Edit:
- `src/components/DeckGLMap.ts`
- `src/components/MapContainer.ts`
- `src/components/Map.ts` (mobile fallback stub or implementation)

Add:
- map setter methods
- build-layer rendering logic in `DeckGLMap.buildLayers()`

## 4) Add panel controls (optional)

Edit:
- `src/components/BostonPanel.ts`

Add:
- toggle UI
- per-layer refresh button
- provenance display row

## 5) Add smoke coverage

Edit:
- `scripts/boston-smoke-test.mjs`

Add the new dataset URL and required flag.

# Traffic Intelligence System — Dashboard (Phase 9F-1)

Frontend foundation for the Traffic Intelligence System. A React + Vite
prototype dashboard that displays the existing, protected processed outputs
of Phase 8 and Phase 9A–9E.

> This is a **prototype**, not a production system. Mock data is always shown
> as MOCK and never presented as live or real.

## Structure

```
frontend/
  package.json          React + Vite project definition
  vite.config.js
  index.html
  README.md
  scripts/
    prepare_data.mjs    READ-ONLY: converts processed CSVs into JSON copies
    smoke_test.mjs      node:test smoke test for the prepared data
  public/
    level8/             unchanged copies of Phase 8 visualisation PNGs
  src/
    App.jsx
    main.jsx
    index.css
    services/
      dataService.js    central data-access layer
    components/         UI components (sections, cards, badges, tables)
    data/               prepared JSON copies (generated, do not edit by hand)
    utils/
      formatting.js
```

## Data source

The UI never reads the protected outputs directly. `scripts/prepare_data.mjs`
copies `data/processed/phase9a_* … phase9e_*` and `level8_*` into
`src/data/*.json`, preserving original values, `data_mode`, `is_mock` and
`source` information. It also copies the Phase 8 PNGs into `public/level8/`.

Regenerate after a data change:

```
npm run prepare:data
```

## Run

```
npm install
npm run prepare:data
npm run dev        # http://localhost:5173
```

## Build & test

```
npm run build      # production build into frontend/dist
npm test           # smoke test for prepared data (node:test)
```

## Safety notes

- No YOLO / ByteTrack re-run, no model training, no raw-video processing.
- Protected Phase 8 / Phase 9A–9E outputs are never modified.
- MOCK / STATIC / LIVE / UNKNOWN statuses are preserved and visible in the UI.
- Phase 9F-2 has **not** been started at the time of writing.
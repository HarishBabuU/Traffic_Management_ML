# Deployment notes — demo CCTV recordings

Status: **not yet migrated.** Prepared during Step 5B, configuration mechanism
added in Step 5C. No bucket exists, nothing has been uploaded, and no video was
moved, deleted or rewritten.

## Configuration mechanism (Step 5C, no bucket created)

`VITE_DEMO_CCTV_BASE_URL` is now the single optional switch for external clip
hosting, read in `controlCenter.js` via `demoCctvBaseUrl(import.meta.env)`.

- **Unset or blank** → `demoCctvBaseUrl()` returns `undefined` and every generated
  URL is byte-identical to before. Local `npm run dev`, `vite preview` and the
  6-second-clip test all behave exactly as they did.
- **Set** → the value (trailing slashes trimmed) is prefixed onto
  `recordings/<file>` and `/demo-cctv/<route>/<file>`. The route folder and the
  URL-encoded filename are preserved; only the origin is added.

No R2 endpoint is hardcoded anywhere in `src/`. The registry
(`ROUTE_CCTV_CONTRACT`, 9 slots / 3 per route) is unchanged, and the
`RECORDED DEMO` / not-live / not-geographically-mapped labelling is untouched.

Both call sites pass the base through:
`CctvInvestigationSection.jsx` and `VideoInvestigationPanel.jsx`.

## What the recordings are

The nine clips under `data/demo_cctv/` (`route_a/CCTV-A01..A03`,
`route_b/CCTV-B01..B03`, `route_c/CCTV-C01..C03`, ≈266.56 MB total) and the
three clips under `frontend/public/recordings/` (≈33.72 MB total) are
**recorded demo resources**. They are not live CCTV feeds, and they carry no
geographic camera position. That claim is unchanged by deployment and must not
change.

## Why playback breaks after deployment

`frontend/vite.config.js` registers a `demoCctvVideos()` Vite plugin that streams
`data/demo_cctv/<route>/<file>` at `/demo-cctv/<route>/<file>` with HTTP Range
support. It hooks `configureServer` and `configurePreviewServer`, so it runs
only while `vite` or `vite preview` is serving the app.

A static host (Cloudflare Pages) serves `frontend/dist/` as finished files. There
is no Node process and no plugin, so:

- the plugin never executes;
- the clips are deliberately **not** copied into `dist/` (an existing test,
  `step4_videoStream_test.mjs`, asserts this);
- `<video src="/demo-cctv/...">` therefore resolves to the SPA fallback and the
  player shows nothing.

This is a hosting limitation, not a bug in the CCTV logic, and no CCTV
functionality should be changed to work around it.

## Options for a later step

1. **Cloudflare R2 + `VITE_DEMO_CCTV_BASE_URL` (recommended, decision made).**
   Create a public bucket, upload the clips preserving their relative paths, then
   set `VITE_DEMO_CCTV_BASE_URL` to the bucket's public base URL and rebuild the
   frontend. No code change is needed — the mechanism exists. Range requests work
   natively on R2, so seeking and playback stay correct.
2. **Bundle the clips into the static site.** Simplest, but adds ≈266 MB to the
   deploy and every visitor download. Cloudflare Pages also caps individual file
   size, and `CCTV-A03.mp4` (78.56 MB) and `CCTV-C02.mp4` (75.13 MB) are large.
3. **Ship the demo without recorded playback.** Leave the CCTV registry and its
   evidence panels intact and state plainly that the recorded clips require a
   local run. Honest, but weakens the demonstration.

Until one of these is chosen, the CCTV view renders correctly on a local run and
its recorded clips simply do not play on the deployed static site.

## Explicitly not done in this step

- No bucket was created and no video was uploaded, moved, deleted or transcoded.
- No video URL was faked, stubbed or pointed at a placeholder host. The R2 base
  appears only as `https://REPLACE-WITH-YOUR-PUBLIC-DEMO-VIDEO-BASE` in
  `frontend/.env.production.example`.
- `vite.config.js` and the CCTV registry are unchanged. `controlCenter.js` and the
  two CCTV components gained only the optional, unset-by-default base-URL
  parameter — with no env var set, generated URLs are identical to before.
- `frontend/.env.development` is unmodified.

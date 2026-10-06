# API hardening — upload size, memory and concurrency

Raised during the Step 5A deployment audit. **Partially addressed in Step 5C.**

| Item | Status |
|---|---|
| `MAX_UPLOAD_MB` default lowered 500 → 50 | **Done in Step 5C** |
| One analysis at a time (`asyncio.Semaphore(1)`, HTTP 429) | **Done in Step 5C** |
| Stream upload to disk instead of buffering | Still open |
| Bound video length (frame count / duration) | Still open |
| `202` + polling for long analyses | Still open (design change) |

## The problem

`api/main.py` reads the whole upload into memory before inference:

```python
content = await file.read()          # api/main.py — entire file in RAM
size_mb = len(content) / (1024 * 1024)
if size_mb > MAX_UPLOAD_MB:          # default MAX_UPLOAD_MB = 50 (was 500)
    raise HTTPException(status_code=413, ...)
```

The ceiling was originally **500 MB**, which was unsafe on any Render instance:
a single upload close to that limit exhausted memory before a single frame was
decoded, because the file is held in RAM in full. Measured peak RSS for the
workload is ~515 MB (model load ≈265 MB, peak during inference ≈515 MB).

**Step 5C changes** (smallest safe change only — the upload mechanism and the ML
pipeline are untouched):

1. `MAX_UPLOAD_MB` now defaults to **50**. `render.yaml` sets `MAX_UPLOAD_MB=50`
   explicitly so the deployed value is visible rather than implicit. The upload
   path is unchanged: still `await file.read()`, still the same `413`, still the
   same temp-file handling.
2. A module-level `asyncio.Semaphore(1)` (`ANALYSIS_SLOTS`) allows **one**
   analysis at a time. A second simultaneous request is rejected with HTTP
   **429** and a clear message instead of competing for RAM. The slot is released
   in the existing `finally` block, so it is freed on success, on failure and on
   a raised `HTTPException`; temp-file cleanup is unchanged.

With Standard (2 GB) selected and the ceiling at 50 MB, two analyses plus their
buffers fit comfortably. The remaining risk is a single long video still holding
its buffer for the whole run — see options 2 and 4 below.

## Options, cheapest first

1. ~~**Lower `MAX_UPLOAD_MB` via the environment**~~ — **done in Step 5C**:
   default is now 50, and `render.yaml` sets it explicitly.
2. ~~**Add a concurrency guard**~~ — **done in Step 5C**: `asyncio.Semaphore(1)`
   with HTTP 429 for a simultaneous second request.
3. **Stream to disk instead of buffering** — read the upload in chunks straight
   to the already-existing `tempfile.mkstemp` target, tracking the running byte
   count and aborting past the limit. Removes the largest allocation entirely.
   The temporary-file cleanup in the `finally` block already covers this path.
4. **Bound video length, not just size** — frame count and duration caps, so a
   short-but-huge or long-but-tiny file cannot produce a multi-hour synchronous
   request.
5. **Consider returning `202` + polling** if long analyses need to be supported
   at all. This is a larger design change; the current synchronous contract is
   what the frontend panel and the E2E test expect, so it should be a
   deliberate, separate decision.

## Constraint

The ML pipeline itself must not change. Every option above is confined to
`api/main.py` (request handling and resource limits). `src/track_and_count.py`,
the YOLO settings, the ByteTrack configuration and the traffic-condition engine
stay exactly as they are.

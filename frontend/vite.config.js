import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Demo CCTV footage lives at the original location (data/demo_cctv/<route>/…)
 * OUTSIDE the Vite root. Instead of copying or duplicating the files, a tiny
 * middleware streams them at /demo-cctv/<route_id>/<source_video> for both the
 * dev server and the preview server. Nothing is copied into dist.
 */
const DEMO_CCTV_BASE = fileURLToPath(new URL('../data/demo_cctv/', import.meta.url));
const DEMO_CCTV_ROUTES = new Set(['route_a', 'route_b', 'route_c']);
const CCTV_FILE_RE = /^CCTV-[A-Z]\d{2}\.mp4$/;

function demoCctvVideos() {
  const streamVideo = (req, res, file) => {
    const size = statSync(file).size;
    const range = typeof req.headers.range === 'string' ? req.headers.range : null;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < size) {
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          });
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  };

  const handler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = decodeURIComponent((req.url || '').split('?')[0]);
    const match = /^\/demo-cctv\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (!match) return next();
    const routeDir = match[1];
    if (!DEMO_CCTV_ROUTES.has(routeDir)) return next();
    if (!CCTV_FILE_RE.test(match[2])) return next();
    const base = resolve(DEMO_CCTV_BASE, routeDir);
    const file = resolve(base, match[2]);
    if (!file.startsWith(base + sep)) return next();
    if (!existsSync(file)) return next();
    streamVideo(req, res, file);
  };

  return {
    name: 'demo-cctv-videos',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), demoCctvVideos()],
  base: './',
  server: {
    port: 5173,
    open: false,
  },
});
// serve.js — zero-dependency static file server for Overtaker.
// Uses only Node's built-in http, fs, path, and os modules. No npm install required.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = process.env.PORT || 8787;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// manifest.json is served with the PWA manifest content-type even though its
// extension is .json, since browsers look for application/manifest+json.
function contentTypeFor(filePath) {
  if (path.basename(filePath) === 'manifest.json') {
    return MIME_TYPES['.webmanifest'];
  }
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function safeResolve(urlPath) {
  // Strip query string / hash, decode, and prevent directory traversal outside ROOT.
  const cleanPath = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const relative = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(ROOT, relative));
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const targetPath = safeResolve(req.url || '/');

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  fs.stat(targetPath, (err, stats) => {
    let filePath = targetPath;

    if (err || !stats.isFile()) {
      // Fall back to index.html for directory-style / unknown routes (SPA-friendly),
      // but only when the request didn't look like it wanted a specific asset file.
      if (!err && stats && stats.isDirectory()) {
        filePath = path.join(targetPath, 'index.html');
      } else if (path.extname(targetPath) === '') {
        filePath = path.join(ROOT, 'index.html');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\nOvertaker dev server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  Network: http://${iface.address}:${PORT}  (same-WiFi devices, e.g. your phone)`);
      }
    }
  }

  console.log(
    `\nNote: camera access requires a secure context (https, or exactly "localhost").` +
      `\n      A plain http://<lan-ip> origin will NOT be allowed to use the camera —` +
      `\n      for real phone testing, deploy this static app to Vercel/Netlify/GitHub Pages,` +
      `\n      or tunnel this dev server with ngrok/localtunnel to get a temporary https URL.\n`
  );
});

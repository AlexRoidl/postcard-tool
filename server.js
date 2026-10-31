#!/usr/bin/env node
// Postcard Printer — tiny zero-dependency local server.
// Serves the editor and prints the rendered postcard to a Phomemo (PM-241/PM643,
// 4x6" / 300dpi, AirPrint) through macOS CUPS (`lp`) — no browser popups.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// --- helpers ---------------------------------------------------------------

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- printer discovery -----------------------------------------------------

// Parse `lpstat -p` + `lpstat -v` into a list of installed CUPS queues.
async function listInstalledPrinters() {
  const [p, v, d] = await Promise.all([
    run('lpstat', ['-p']),
    run('lpstat', ['-v']),
    run('lpstat', ['-d']),
  ]);

  const uriByName = {};
  v.stdout.split('\n').forEach((line) => {
    // "device for NAME: ipp://..."
    const m = line.match(/^device for (.+?):\s*(.+)$/);
    if (m) uriByName[m[1]] = m[2].trim();
  });

  const defaultName = (d.stdout.match(/system default destination:\s*(.+)$/m) || [])[1] || null;

  const printers = [];
  p.stdout.split('\n').forEach((line) => {
    const m = line.match(/^printer (\S+) is (\w+)/);
    if (m) {
      const name = m[1];
      const uri = uriByName[name] || '';
      printers.push({
        name,
        state: m[2],
        uri,
        kind: uri.startsWith('usb') ? 'usb' : (uri.startsWith('ipp') || uri.startsWith('dnssd') || uri.startsWith('socket') ? 'network' : 'other'),
        isDefault: name === defaultName,
      });
    }
  });
  return { printers, defaultName };
}

// Quick network scan for AirPrint / IPP devices via `ippfind`.
async function discoverNetworkPrinters() {
  const r = await run('ippfind', ['--timeout', '4'], { timeout: 7000 });
  if (!r.ok && !r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((uri) => ({ uri }));
}

// Add a WiFi printer by IP as a driverless (IPP Everywhere / AirPrint) queue.
async function addWifiPrinter(ip, name) {
  const safeName = (name || `Phomemo_${ip}`).replace(/[^A-Za-z0-9_.-]/g, '_');
  const uri = `ipp://${ip}/ipp/print`;
  // -m everywhere => driverless, auto-negotiates media (incl. 4x6) and resolution.
  const add = await run('lpadmin', ['-p', safeName, '-E', '-v', uri, '-m', 'everywhere'], { timeout: 30000 });
  if (!add.ok) {
    return { ok: false, error: (add.stderr || add.stdout || 'lpadmin failed').trim() };
  }
  await run('cupsenable', [safeName]);
  await run('cupsaccept', [safeName]);
  return { ok: true, name: safeName, uri };
}

// --- printing --------------------------------------------------------------

async function printImage({ pngBuffer, printer, lpOptions }) {
  if (!printer) return { ok: false, error: 'No printer selected.' };
  const tmp = path.join(os.tmpdir(), `postcard_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmp, pngBuffer);

  // Build lp args. lpOptions is an array of ["-o","key=value", ...] style tokens
  // already split by the client; we only pass through -o options plus -n copies.
  const args = ['-d', printer];
  (lpOptions || []).forEach((opt) => {
    // allow only -o / -n with their following value
    args.push(opt);
  });
  args.push(tmp);

  const r = await run('lp', args, { timeout: 30000 });
  try { fs.unlinkSync(tmp); } catch (_) {}

  if (!r.ok) {
    return { ok: false, error: (r.stderr || r.stdout || 'lp failed').trim(), args };
  }
  const job = (r.stdout.match(/request id is (\S+)/) || [])[1] || null;
  return { ok: true, job, stdout: r.stdout.trim() };
}

// --- static files ----------------------------------------------------------

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- router ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/api/printers') {
      const installed = await listInstalledPrinters();
      let discovered = [];
      try { discovered = await discoverNetworkPrinters(); } catch (_) {}
      return sendJSON(res, 200, { ...installed, discovered });
    }

    if (req.method === 'GET' && url === '/api/printer-state') {
      const name = new URL(req.url, 'http://x').searchParams.get('name');
      if (!name) return sendJSON(res, 400, { ok: false, error: 'name required' });
      const r = await run('lpstat', ['-p', name]);
      return sendJSON(res, 200, { ok: r.ok, state: r.stdout.trim() || r.stderr.trim() });
    }

    if (req.method === 'POST' && url === '/api/add-wifi') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.ip || !/^[0-9a-fA-F:.]+$/.test(body.ip)) {
        return sendJSON(res, 400, { ok: false, error: 'valid ip required' });
      }
      const r = await addWifiPrinter(body.ip, body.name);
      return sendJSON(res, r.ok ? 200 : 500, r);
    }

    if (req.method === 'POST' && url === '/api/print') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.image) return sendJSON(res, 400, { ok: false, error: 'image required' });
      const b64 = body.image.replace(/^data:image\/\w+;base64,/, '');
      const pngBuffer = Buffer.from(b64, 'base64');
      const r = await printImage({ pngBuffer, printer: body.printer, lpOptions: body.lpOptions });
      return sendJSON(res, r.ok ? 200 : 500, r);
    }

    if (url.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'unknown endpoint' });

    return serveStatic(req, res);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

// Bind localhost-only by default (safe for the local print server on your Mac);
// containers/remote hosts set HOST=0.0.0.0 so the reverse proxy can reach it.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Postcard Printer running → ${url}  (bind ${HOST}:${PORT})\n`);
});

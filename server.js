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

// --- workshop print queue config ------------------------------------------
// ROLE 'queue' = the public server that collects designs (no printer attached).
// ROLE 'local' = your Mac, which prints directly and/or runs the pull agent.
const ROLE = process.env.ROLE || 'local';
const JOBS_DIR = process.env.JOBS_DIR || path.join(__dirname, 'jobs');
const ROOM_CODE = process.env.ROOM_CODE || '';     // required to submit a job, if set
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // required to list/fetch/manage jobs, if set
const DEFAULT_LP = '-o PageSize=w288h432 -o print-color-mode=monochrome';

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

// --- print queue (store) ---------------------------------------------------

function ensureJobsDir() { try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {} }
function jobMetaPath(id) { return path.join(JOBS_DIR, id + '.json'); }
function jobPngPath(id)  { return path.join(JOBS_DIR, id + '.png'); }
function validId(id) { return /^[A-Za-z0-9_-]{6,80}$/.test(id); }

function listJobs() {
  ensureJobsDir();
  return fs.readdirSync(JOBS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')); } catch (_) { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Facilitator/agent auth. Open when ADMIN_TOKEN is unset (local/dev).
function adminOK(req) {
  if (!ADMIN_TOKEN) return true;
  const tok = req.headers['x-print-token'] || new URL(req.url, 'http://x').searchParams.get('token') || '';
  return tok === ADMIN_TOKEN;
}

// --- pull agent (runs on the Mac: fetch approved jobs, print them) ----------

async function runAgent() {
  const base = (process.env.QUEUE_URL || '').replace(/\/+$/, '');
  const token = ADMIN_TOKEN;
  const auto = process.argv.includes('--auto') || process.env.AUTO === '1';
  const dry = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
  const backlog = process.argv.includes('--backlog') || process.env.PRINT_BACKLOG === '1';
  const pollMs = Math.max(1000, Number(process.env.POLL_MS || 4000));
  // In AUTO we print 'pending' jobs on sight; we ALSO take 'approved', so pressing
  // "print" in /overview (which approves) still prints instead of stranding the job.
  // Without AUTO we only print what the facilitator explicitly approved.
  const wantSet = auto ? ['pending', 'approved'] : ['approved'];
  const dryDir = process.env.DRY_DIR || path.join(__dirname, 'dryrun');
  // Print profile, auto-picked from the printer NAME (override with PRINTER_PROFILE
  // or --selphy). The chosen profile's lp options OVERRIDE whatever the participant
  // submitted, so the Phomemo's monochrome default never leaks onto the colour Selphy
  // and vice versa:
  //   selphy  -> 100x148 mm postcard, borderless (print-scaling=fill), colour
  //   phomemo -> 6x4" thermal label (w288h432), monochrome  [= DEFAULT_LP / LP_OPTIONS]
  // print-scaling=fill => borderless: the image fills the whole sheet, cropping the
  // tiny 4x6-vs-100x148 overflow (~0.6 mm) instead of leaving a white hairline.
  const SELPHY_LP = (process.env.SELPHY_LP_OPTIONS || '-o media=jpn_hagaki_100x148mm -o print-scaling=fill -o print-color-mode=color').trim().split(/\s+/);
  const defLp = (process.env.LP_OPTIONS || DEFAULT_LP).trim().split(/\s+/);
  const forcedProfile = (process.argv.includes('--selphy') || process.env.PRINTER_PROFILE === 'selphy') ? 'selphy'
                      : (process.env.PRINTER_PROFILE === 'phomemo') ? 'phomemo' : '';
  const printer = process.env.PRINTER || (forcedProfile === 'selphy' ? 'Canon_SELPHY_CP1500' : '');
  const detectProfile = (name) => /selphy|cp-?1500/i.test(name) ? 'selphy'
                                 : /pm-?643|pm-?241|phomemo/i.test(name) ? 'phomemo' : '';
  const profile = forcedProfile || detectProfile(printer);
  const profileLp = profile === 'selphy' ? SELPHY_LP : profile === 'phomemo' ? defLp : null;
  // Don't AUTO-pick-up pending jobs submitted before the agent started (that would
  // drain the persisted backlog on the first tick). This only gates auto-pickup of
  // 'pending' — an 'approved' job is an explicit facilitator decision and always
  // prints regardless of age. --backlog opts out and auto-prints old pending too.
  const startedAt = Date.now();
  const jobTime = (job) => job.createdAt || parseInt(String(job.id || '').split('-')[0], 36) || 0;

  if (!base)            { console.error('ERROR: set QUEUE_URL (e.g. https://tool.poetic.software)'); process.exit(1); }
  if (!printer && !dry) { console.error('ERROR: set PRINTER (your CUPS queue, e.g. PM643_usb)');     process.exit(1); }
  if (dry) { try { fs.mkdirSync(dryDir, { recursive: true }); } catch (_) {} }

  const hdr = token ? { 'x-print-token': token } : {};
  console.log(`\n  Print agent → ${base}`);
  if (dry) console.log(`  DRY RUN — no printer; approved jobs are fetched and saved to ${dryDir} (marked done, nothing prints)`);
  console.log(`  printing ${wantSet.join('+')} jobs ${dry ? '(dry-run)' : `on "${printer}"`} ${auto ? '(AUTO)' : '(approve-each via /overview)'} every ${pollMs}ms`);
  if (profile) console.log(`  profile: ${profile} ${forcedProfile ? '(forced)' : '(from printer name)'} → forcing ${profileLp.join(' ')}`);
  else console.log(`  profile: none (printer name unrecognised) → using each job's own lp options`);
  console.log(backlog ? '  including the existing backlog (--backlog)\n' : '  only jobs submitted from now on (use --backlog to also print the existing queue)\n');

  let skippedOld = 0;
  async function tick() {
    try {
      const r = await fetch(`${base}/api/jobs`, { headers: hdr });
      if (!r.ok) { console.error('  poll failed:', r.status, r.statusText); return; }
      const { jobs = [] } = await r.json();
      const queue = jobs.filter(j => wantSet.includes(j.status)).sort((a, b) => jobTime(a) - jobTime(b));
      for (const job of queue) {
        // backlog filter applies only to auto-pickup of pending; approved always prints
        if (!backlog && job.status === 'pending' && jobTime(job) < startedAt) {
          if (!(job.id in (tick._seen || (tick._seen = {})))) { tick._seen[job.id] = 1; skippedOld++;
            console.log(`  (skipping backlog job ${job.id}${job.name ? ` — ${job.name}` : ''}; approve it in /overview to print anyway; ${skippedOld} old pending ignored)`); }
          continue;
        }
        const who = job.name ? ` (${job.name})` : '';
        console.log(`  → printing ${job.id}${who} …`);
        const pr = await fetch(`${base}/api/jobs/${job.id}/png`, { headers: hdr });
        if (!pr.ok) { console.error('    fetch png failed:', pr.status); continue; }
        const buf = Buffer.from(await pr.arrayBuffer());
        let result;
        if (dry) {
          try { fs.writeFileSync(path.join(dryDir, job.id + '.png'), buf); result = { ok: true, job: '(dry-run, not printed)' }; }
          catch (e) { result = { ok: false, error: 'dry-run save failed: ' + e.message }; }
        } else {
          const lpOptions = profileLp || ((job.lpOptions && job.lpOptions.length) ? job.lpOptions : defLp);
          result = await printImage({ pngBuffer: buf, printer, lpOptions });
        }
        if (result.ok) {
          await fetch(`${base}/api/jobs/${job.id}/done`, { method: 'POST', headers: hdr });
          console.log(`    ✓ printed ${job.id} ${result.job || ''}`);
        } else {
          await fetch(`${base}/api/jobs/${job.id}/fail`, { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: result.error }) });
          console.error(`    ✗ failed ${job.id}: ${result.error}`);
        }
      }
    } catch (e) { console.error('  agent error:', e.message); }
  }
  await tick();
  setInterval(tick, pollMs);
}

// --- static files ----------------------------------------------------------

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/overview' || urlPath === '/overview/') urlPath = '/overview.html';
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

    // ---- workshop print queue ----
    if (req.method === 'GET' && url === '/api/config') {
      return sendJSON(res, 200, { role: ROLE, roomRequired: !!ROOM_CODE });
    }

    // participant submits a finished design (open; gated by room code if set)
    if (req.method === 'POST' && url === '/api/jobs') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (ROOM_CODE && body.room !== ROOM_CODE) return sendJSON(res, 403, { ok: false, error: 'wrong or missing room code' });
      if (!body.image) return sendJSON(res, 400, { ok: false, error: 'image required' });
      const png = Buffer.from(body.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (!png.length) return sendJSON(res, 400, { ok: false, error: 'empty image' });
      ensureJobsDir();
      const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(jobPngPath(id), png);
      const meta = {
        id,
        name: String(body.name || '').slice(0, 60),
        orient: body.orient === 'landscape' ? 'landscape' : 'portrait',
        lpOptions: Array.isArray(body.lpOptions) ? body.lpOptions.slice(0, 20).map(String) : null,
        bytes: png.length,
        status: 'pending',
        createdAt: Date.now(),
      };
      fs.writeFileSync(jobMetaPath(id), JSON.stringify(meta));
      return sendJSON(res, 200, { ok: true, id });
    }

    // facilitator/agent: list jobs (optionally ?status=pending|approved|done)
    if (req.method === 'GET' && url === '/api/jobs') {
      if (!adminOK(req)) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      const status = new URL(req.url, 'http://x').searchParams.get('status');
      let jobs = listJobs();
      if (status) jobs = jobs.filter(j => j.status === status);
      return sendJSON(res, 200, { ok: true, jobs });
    }

    // facilitator/agent: fetch a job's PNG (token via header or ?token= for <img>)
    if (req.method === 'GET' && /^\/api\/jobs\/[^/]+\/png$/.test(url)) {
      if (!adminOK(req)) { res.writeHead(401); return res.end('unauthorized'); }
      const id = url.split('/')[3];
      if (!validId(id) || !fs.existsSync(jobPngPath(id))) { res.writeHead(404); return res.end('not found'); }
      const data = fs.readFileSync(jobPngPath(id));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length });
      return res.end(data);
    }

    // facilitator/agent: approve / reject / done / fail
    if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/(approve|reject|done|fail)$/.test(url)) {
      if (!adminOK(req)) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      const [, , , id, action] = url.split('/');
      if (!validId(id) || !fs.existsSync(jobMetaPath(id))) return sendJSON(res, 404, { ok: false, error: 'not found' });
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (_) {}
      const meta = JSON.parse(fs.readFileSync(jobMetaPath(id), 'utf8'));
      meta.status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'done' ? 'done' : 'error';
      if (action === 'fail') meta.error = String(body.error || '').slice(0, 300);
      meta.updatedAt = Date.now();
      fs.writeFileSync(jobMetaPath(id), JSON.stringify(meta));
      return sendJSON(res, 200, { ok: true, status: meta.status });
    }

    if (url.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'unknown endpoint' });

    return serveStatic(req, res);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

// Run as the Mac-side pull agent (`node server.js --agent`) instead of the server.
if (process.argv.includes('--agent')) {
  runAgent();
} else {
  // Bind localhost-only by default (safe for the local print server on your Mac);
  // containers/remote hosts set HOST=0.0.0.0 so the reverse proxy can reach it.
  const HOST = process.env.HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Postcard Printer (${ROLE}) running → ${url}  (bind ${HOST}:${PORT})\n`);
  });
}

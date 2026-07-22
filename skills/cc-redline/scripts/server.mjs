#!/usr/bin/env node
// cc-redline local review server. Zero runtime dependencies.
// Usage: node server.mjs <markdown-file> --state-dir DIR [--port N] [--no-open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSETS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function scanMaxSeq(stateDir) {
  let max = 0;
  for (const name of fs.readdirSync(stateDir)) {
    const m = /^submission-(\d+)\.json(\.consumed)?$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export function createApp({ file, stateDir, exit = (code) => process.exit(code), doneExitDelayMs = 2000, watchIntervalMs = 500 }) {
  const docFile = path.resolve(file);
  fs.accessSync(docFile, fs.constants.R_OK);
  if (!fs.statSync(docFile).isFile()) throw new Error(`not a file: ${docFile}`);
  const docDir = path.dirname(docFile);
  fs.mkdirSync(stateDir, { recursive: true });

  let content = fs.readFileSync(docFile, 'utf8');
  let version = 1;
  let submitSeq = scanMaxSeq(stateDir);
  const sseClients = new Set();

  function broadcast(event, data) {
    for (const res of sseClients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Detect each round's outcome-<seq>.json without a standing poll loop: watch
  // the specific known path (reuses fs.watchFile, same as the doc watcher),
  // broadcast once, then stop watching. A missed broadcast self-heals via the
  // client's /api/history reconciliation.
  const announcedOutcomes = new Set();
  const watchedOutcomeSeqs = new Set();
  function watchOutcome(seq) {
    if (announcedOutcomes.has(seq) || watchedOutcomeSeqs.has(seq)) return;
    const file = path.join(stateDir, `outcome-${seq}.json`);
    const announce = () => {
      announcedOutcomes.add(seq);
      if (watchedOutcomeSeqs.delete(seq)) fs.unwatchFile(file);
      broadcast('outcome', { seq });
    };
    // Already on disk (stale STATE_DIR / outcome landed while we were down):
    // fs.watchFile would never fire for a file that does not change again.
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      announcedOutcomes.add(seq);
      return; // nothing to broadcast to: no client can be waiting on a pre-existing file
    } catch { /* not there yet → watch for it */ }
    watchedOutcomeSeqs.add(seq);
    // watchFile's first fire is an immediate ENOENT baseline (curr is a
    // zeroed Stats, so curr.isFile() is false) — libuv stats the path right
    // away, before the first interval, purely to seed comparison state. A
    // live readFileSync there is not a safe filter: it re-checks the disk
    // *now*, which can race ahead of the baseline stat and false-positive if
    // the file lands in between (observed: immediate re-arm-on-restart watches
    // can otherwise "detect" and broadcast before any SSE client has
    // reconnected). Trusting curr.isFile() ignores that baseline deterministically
    // and only acts on a real, later stat transition to a genuine file.
    fs.watchFile(file, { interval: watchIntervalMs }, (curr) => {
      if (announcedOutcomes.has(seq) || !curr.isFile()) return;
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
      announce();
    });
  }
  // Re-arm watches for any submitted round still lacking an outcome — survives a
  // restart with the same STATE_DIR.
  for (const name of (fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [])) {
    const m = /^submission-(\d+)\.json(\.consumed)?$/.exec(name);
    if (m) watchOutcome(Number(m[1]));
  }

  // fs.watchFile (stat polling) is deliberate: editors and agents often
  // save via temp-file + rename, which fs.watch tends to misreport on Windows.
  fs.watchFile(docFile, { interval: watchIntervalMs }, () => {
    try {
      const next = fs.readFileSync(docFile, 'utf8');
      if (next !== content) {
        content = next;
        version++;
        broadcast('doc-changed', { version });
      }
    } catch {
      // File briefly unreadable mid-save; next poll retries.
    }
  });

  function serveStatic(res, root, rel) {
    if (rel.includes('\0')) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const target = path.normalize(path.join(root, rel));
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(target, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    try {
      if (req.method === 'GET' && pathname === '/') return serveStatic(res, ASSETS_ROOT, 'app.html');
      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        return serveStatic(res, ASSETS_ROOT, pathname.slice('/assets/'.length));
      }
      if (req.method === 'GET' && pathname.startsWith('/doc-assets/')) {
        return serveStatic(res, docDir, pathname.slice('/doc-assets/'.length));
      }
      if (req.method === 'GET' && pathname === '/api/doc') {
        return json(res, 200, { file: docFile, content, version });
      }
      if (req.method === 'GET' && pathname === '/api/history') {
        let names = [];
        try { names = fs.readdirSync(stateDir); } catch { /* dir not there yet */ }
        const seqs = new Set();
        for (const name of names) {
          const m = /^submission-(\d+)\.json(\.consumed)?$/.exec(name) || /^outcome-(\d+)\.json$/.exec(name);
          if (m) seqs.add(Number(m[1]));
        }
        const readJson = (f) => {
          try { return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); } catch { return null; }
        };
        const rounds = [];
        for (const seq of [...seqs].sort((a, b) => a - b)) {
          // .json may be renamed to .consumed mid-read (wait script); try both.
          const s = readJson(`submission-${seq}.json`) || readJson(`submission-${seq}.json.consumed`);
          const o = readJson(`outcome-${seq}.json`);
          rounds.push({
            seq,
            submittedAt: s?.submittedAt ?? null,
            docVersion: s?.docVersion ?? null,
            globalComment: s?.globalComment ?? null,
            annotations: Array.isArray(s?.annotations) ? s.annotations : [],
            outcome: o,
          });
        }
        return json(res, 200, { currentVersion: version, rounds });
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/submit') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
        const globalComment =
          typeof payload.globalComment === 'string' && payload.globalComment.trim()
            ? payload.globalComment.trim()
            : null;
        if (!annotations.length && !globalComment) return json(res, 400, { error: 'empty submission' });
        submitSeq++;
        const record = {
          type: 'submission',
          seq: submitSeq,
          file: docFile,
          docVersion: payload.docVersion ?? version,
          submittedAt: new Date().toISOString(),
          globalComment,
          annotations,
        };
        const target = path.join(stateDir, `submission-${submitSeq}.json`);
        fs.writeFileSync(target + '.tmp', JSON.stringify(record, null, 2));
        fs.renameSync(target + '.tmp', target); // atomic: the wait script never sees partial JSON
        watchOutcome(submitSeq);
        return json(res, 200, { ok: true, seq: submitSeq });
      }
      if (req.method === 'POST' && pathname === '/api/done') {
        const record = { type: 'done', finishedAt: new Date().toISOString(), rounds: submitSeq };
        const target = path.join(stateDir, 'done.json');
        fs.writeFileSync(target + '.tmp', JSON.stringify(record, null, 2));
        fs.renameSync(target + '.tmp', target); // atomic: the wait script never sees partial JSON
        json(res, 200, { ok: true });
        setTimeout(() => exit(0), doneExitDelayMs);
        return;
      }
      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    fs.unwatchFile(docFile);
    for (const seq of watchedOutcomeSeqs) fs.unwatchFile(path.join(stateDir, `outcome-${seq}.json`));
    watchedOutcomeSeqs.clear();
  });

  return { server, docFile, stateDir, getState: () => ({ version, submitSeq }) };
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {}); // failure is non-fatal; the URL is in server-info.json
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  let file;
  let stateDir;
  let port = 0;
  let noOpen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir') stateDir = args[++i];
    else if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--no-open') noOpen = true;
    else if (!args[i].startsWith('--')) file = args[i];
  }
  if (!file || !stateDir) {
    console.error('usage: node server.mjs <markdown-file> --state-dir DIR [--port N] [--no-open]');
    process.exit(1);
  }
  let app;
  try {
    app = createApp({ file, stateDir });
  } catch (e) {
    console.error(`[cc-redline] cannot start: ${e.message}`);
    process.exit(1);
  }
  app.server.listen(port, '127.0.0.1', () => {
    const actualPort = app.server.address().port;
    const url = `http://127.0.0.1:${actualPort}/`;
    const info = { url, port: actualPort, pid: process.pid, file: app.docFile, startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(app.stateDir, 'server-info.json'), JSON.stringify(info, null, 2));
    console.log(`[cc-redline] serving ${app.docFile} at ${url}`);
    if (!noOpen) openBrowser(url);
  });
}

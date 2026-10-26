'use strict';
/*
 * codex-bridge  跨 agent 驱动桥
 *
 * 通道：
 *   1) 回环 HTTP      127.0.0.1:PORT
 *   2) 文件信箱        mailbox/inbox/*.json  ->  mailbox/results/*.json
 *
 * 操作（HTTP 路由 / 信箱的 op 字段）：
 *   run    新开一次性会话         codex exec ...
 *   resume 续接历史会话           codex exec resume <id> <prompt>
 *   queue  投递消息到已有会话     codex queue --thread <id> --message <text>
 *   codex  透传任意参数           codex <args...>        （用于探测）
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn, spawnSync } = require('child_process');

const BRIDGE_DIR  = __dirname;
const LOG_FILE    = path.join(BRIDGE_DIR, 'bridge.log');
const CONFIG_FILE = path.join(BRIDGE_DIR, 'bridge.config.json');
const PROBE_FILE  = path.join(BRIDGE_DIR, 'probe.json');
const MAILBOX     = path.join(BRIDGE_DIR, 'mailbox');
const INBOX       = path.join(MAILBOX, 'inbox');
const RESULTS     = path.join(MAILBOX, 'results');
const QUARANTINE  = path.join(MAILBOX, 'bad');

for (const dir of [MAILBOX, INBOX, RESULTS, QUARANTINE]) fs.mkdirSync(dir, { recursive: true });

function log() {
  const line = '[' + new Date().toISOString() + '] ' +
               Array.prototype.slice.call(arguments).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function findCodex() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base  = path.join(local, 'OpenAI', 'Codex', 'bin');
  const cands = [];
  if (process.env.CODEX_CLI_PATH) cands.push(process.env.CODEX_CLI_PATH);
  try {
    for (const ver of fs.readdirSync(base)) cands.push(path.join(base, ver, 'codex.exe'));
  } catch (_) {}
  cands.push(path.join(os.homedir(), '.codex', '.sandbox-bin', 'codex.exe'));
  cands.push('codex');
  for (const c of cands) {
    try { if (c === 'codex' || fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  return 'codex';
}

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  codexPath: findCodex(),
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  execArgs: null,
  resumeArgs: null,
  modelArgs: ['-m', '{model}'],
  defaultCwd: BRIDGE_DIR,
  defaultTimeoutMs: 600000,
  pollMs: 1000,
  extraEnv: {}
};

function loadConfig() {
  let user = {};
  try { user = JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (_) {}
  const cfg = Object.assign({}, DEFAULTS, user);
  if (!cfg.codexPath) cfg.codexPath = findCodex();
  return cfg;
}

/* ---------------- 参数拼装 ---------------- */

function modelArgs(cfg, req) {
  const out = [];
  if (req.model && Array.isArray(cfg.modelArgs)) {
    for (const raw of cfg.modelArgs) out.push(String(raw) === '{model}' ? req.model : String(raw));
  }
  return out;
}

function buildArgs(cfg, req) {
  const template = cfg.execArgs || ['exec', '--skip-git-repo-check', '-C', '{cwd}', '{prompt}'];
  const out = [];
  for (const raw of template) {
    const a = String(raw);
    if (a === '{prompt}') { out.push(req.prompt); continue; }
    out.push(a.replace('{cwd}', req.cwd || cfg.defaultCwd));
  }
  return out.concat(modelArgs(cfg, req));
}

function buildResumeArgs(cfg, req) {
  const out = ['exec', 'resume'];
  if (req.skipGitCheck !== false) out.push('--skip-git-repo-check');
  if (req.all) out.push('--all');
  if (req.thread) out.push(req.thread);
  if (req.thread === undefined && req.last) out.push('--last');
  if (req.prompt) out.push(req.prompt);
  return out.concat(modelArgs(cfg, req));
}

function buildQueueArgs(cfg, req) {
  const msg = req.message === undefined ? req.prompt : req.message;
  const out = ['queue', '--thread', req.thread, '--message', msg === undefined ? '' : String(msg)];
  return out.concat(modelArgs(cfg, req));
}

function buildRawArgs(cfg, req) {
  const argv = Array.isArray(req.args) ? req.args.map(String) : [];
  return argv.map(function (a) {
    if (a === '{prompt}') return req.prompt === undefined ? '' : req.prompt;
    return a.replace('{cwd}', req.cwd || cfg.defaultCwd);
  }).concat(modelArgs(cfg, req));
}

/* ---------------- 执行器 ---------------- */

const tasks = new Map();

function runArgv(opts) {
  const cfg = loadConfig();
  const id  = opts.id || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  const cwd = opts.cwd || cfg.defaultCwd;
  const argv = opts.argv;
  const op = opts.op || 'run';

  const rec = {
    id: id, op: op, status: 'running', argv: argv, cwd: cwd,
    startedAt: new Date().toISOString(), startedAtMs: Date.now(),
    stdout: '', stderr: ''
  };
  tasks.set(id, rec);
  log('TASK ' + id + ' [' + op + '] START cwd=' + cwd);
  log('TASK ' + id + ' [' + op + '] ARGV ' + cfg.codexPath + ' ' +
      argv.map(function (a) { return JSON.stringify(a); }).join(' '));

  return new Promise(function (resolve) {
    let child;

    function finish(status, extra) {
      if (rec.settled) return;
      rec.settled = true;
      clearTimeout(rec.timer);
      rec.status = status;
      rec.finishedAt = new Date().toISOString();
      rec.durationMs = Date.now() - rec.startedAtMs;
      if (extra) Object.assign(rec, extra);

      const payload = {
        id: rec.id, op: rec.op, status: rec.status,
        exitCode: rec.exitCode === undefined ? null : rec.exitCode,
        durationMs: rec.durationMs,
        stdout: rec.stdout, stderr: rec.stderr,
        error: rec.error || null,
        argv: rec.argv, cwd: cwd
      };
      try {
        fs.writeFileSync(path.join(RESULTS, id + '.json'),
                         JSON.stringify(payload, null, 2), 'utf8');
      } catch (e) { log('TASK ' + id + ' RESULT-WRITE-FAIL ' + e.message); }
      log('TASK ' + id + ' ' + status.toUpperCase() + ' exit=' +
          payload.exitCode + ' ms=' + rec.durationMs);
      resolve(payload);
    }

    try {
      child = spawn(cfg.codexPath, argv, {
        cwd: cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { CODEX_HOME: cfg.codexHome }, cfg.extraEnv)
      });
    } catch (e) {
      rec.error = 'spawn threw: ' + e.message;
      return finish('error');
    }

    rec.pid = child.pid;
    child.stdout.on('data', function (c) { rec.stdout += c.toString('utf8'); });
    child.stderr.on('data', function (c) { rec.stderr += c.toString('utf8'); });
    child.on('error', function (e) { rec.error = String(e.message || e); finish('error'); });

    const timeoutMs = Number(opts.timeoutMs || cfg.defaultTimeoutMs);
    if (timeoutMs > 0) {
      rec.timer = setTimeout(function () {
        rec.error = 'timeout after ' + timeoutMs + 'ms';
        try { child.kill(); } catch (_) {}
        finish('timeout');
      }, timeoutMs);
    }

    child.on('close', function (code) {
      rec.exitCode = code;
      if (code === 0) finish('done');
      else finish('failed', { error: rec.error || ('exit code ' + code) });
    });
  });
}

function dispatch(req) {
  const cfg = loadConfig();
  const opts = { id: req.id, cwd: req.cwd, timeoutMs: req.timeoutMs, op: req.op || 'run' };

  switch (opts.op) {
    case 'resume':
      if (!req.thread && !req.last) throw new Error('resume 需要 thread 或 last');
      opts.argv = buildResumeArgs(cfg, req);
      break;
    case 'queue':
      if (!req.thread) throw new Error('queue 需要 thread');
      opts.argv = buildQueueArgs(cfg, req);
      break;
    case 'codex':
      if (!Array.isArray(req.args) || !req.args.length) throw new Error('codex 需要 args 数组');
      opts.argv = buildRawArgs(cfg, req);
      break;
    default:
      if (!req.prompt) throw new Error('run 需要 prompt');
      opts.argv = buildArgs(cfg, req);
  }
  return runArgv(opts);
}

/* ---------------- 探测 ---------------- */

function probe() {
  const cfg = loadConfig();
  const jobs = [
    ['version',   ['--version']],
    ['help',      ['--help']],
    ['execHelp',  ['exec', '--help']],
    ['resumeHelp',['exec', 'resume', '--help']],
    ['queueHelp', ['queue', '--help']],
    ['agentsHelp',['agents', '--help']]
  ];
  const out = { when: new Date().toISOString(), codexPath: cfg.codexPath, results: {} };
  for (const job of jobs) {
    const name = job[0], args = job[1];
    let r;
    try {
      r = spawnSync(cfg.codexPath, args, {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: Object.assign({}, process.env, { CODEX_HOME: cfg.codexHome })
      });
    } catch (e) {
      out.results[name] = { error: String(e.message || e) };
      continue;
    }
    out.results[name] = {
      status: r.status,
      error: r.error ? String(r.error.message || r.error) : null,
      stdout: (r.stdout || '').slice(0, 20000),
      stderr: (r.stderr || '').slice(0, 20000)
    };
    log('PROBE ' + name + ' -> status=' + r.status +
        ' err=' + (out.results[name].error || '-'));
  }
  try { fs.writeFileSync(PROBE_FILE, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {}
  return out;
}

function readSessions() {
  const cfg = loadConfig();
  const idx = path.join(cfg.codexHome, 'session_index.jsonl');
  const rows = [];
  try {
    for (const line of fs.readFileSync(idx, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(stripBom(t))); } catch (_) {}
    }
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  rows.sort(function (a, b) {
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  return { ok: true, count: rows.length, sessions: rows.slice(0, 300) };
}

/* ---------------- HTTP ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let b = '';
    req.on('data', function (c) { b += c; if (b.length > 8e6) req.destroy(); });
    req.on('end', function () {
      try { resolve(b ? JSON.parse(stripBom(b)) : {}); }
      catch (e) { resolve({ _parseError: String(e.message) }); }
    });
  });
}

async function handle(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') {
    const cfg = loadConfig();
    return json(res, 200, {
      ok: true, service: 'codex-bridge', pid: process.pid,
      codexPath: cfg.codexPath, port: cfg.port, node: process.version,
      tasks: tasks.size, ops: ['run', 'resume', 'queue', 'codex']
    });
  }
  if (req.method === 'GET' && p === '/probe') return json(res, 200, probe());
  if (req.method === 'GET' && p === '/sessions') return json(res, 200, readSessions());
  if (req.method === 'GET' && p === '/threads') return json(res, 200, readSessions());

  if (req.method === 'GET' && p === '/tasks') {
    return json(res, 200, {
      ok: true,
      tasks: Array.from(tasks.values()).map(function (t) {
        return { id: t.id, op: t.op, status: t.status, pid: t.pid,
                 startedAt: t.startedAt, durationMs: t.durationMs || null };
      })
    });
  }

  if (req.method === 'GET' && p === '/task') {
    const id = url.searchParams.get('id');
    const t = tasks.get(id);
    if (t) {
      return json(res, 200, {
        id: t.id, op: t.op, status: t.status,
        exitCode: t.exitCode === undefined ? null : t.exitCode,
        stdout: t.stdout, stderr: t.stderr,
        durationMs: t.durationMs || null
      });
    }
    const f = path.join(RESULTS, id + '.json');
    if (fs.existsSync(f)) return json(res, 200, JSON.parse(stripBom(fs.readFileSync(f, 'utf8'))));
    return json(res, 404, { ok: false, error: 'no such task', id: id });
  }

  const posts = { '/run': 'run', '/resume': 'resume', '/queue': 'queue', '/codex': 'codex', '/start': 'run' };
  if (req.method === 'POST' && posts[p]) {
    const body = await readBody(req);
    if (body._parseError) return json(res, 400, { ok: false, error: body._parseError });
    body.op = posts[p];

    if (p === '/start') {
      const pr = dispatch(body);
      const id = Array.from(tasks.keys()).pop();
      pr.then(function () {});
      return json(res, 202, { ok: true, id: id });
    }
    const out = await dispatch(body);
    return json(res, out.status === 'done' ? 200 : 500,
                Object.assign({ ok: out.status === 'done' }, out));
  }

  return json(res, 404, { ok: false, error: 'no route', path: p });
}

function startServer() {
  const cfg = loadConfig();
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    handle(req, res, url).catch(function (e) {
      log('HTTP-ERROR ' + (e && e.stack || e));
      try { json(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (_) {}
    });
  });
  server.listen(cfg.port, cfg.host, function () {
    log('HTTP listening on http://' + cfg.host + ':' + cfg.port);
  });
  server.on('error', function (e) { log('HTTP-SERVER-ERROR ' + e.message); });
  return server;
}

/* ---------------- 文件信箱 ---------------- */

function startMailbox() {
  setInterval(function () {
    let files = [];
    try { files = fs.readdirSync(INBOX).filter(function (f) { return f.endsWith('.json'); }); }
    catch (_) { return; }

    for (const f of files) {
      const full = path.join(INBOX, f);
      let reqObj;
      try {
        reqObj = JSON.parse(stripBom(fs.readFileSync(full, 'utf8')));
      } catch (e) {
        log('MAILBOX bad json ' + f + ': ' + e.message + ' -> quarantined');
        try { fs.renameSync(full, path.join(QUARANTINE, f)); }
        catch (_) { try { fs.unlinkSync(full); } catch (_) {} }
        continue;
      }
      try { fs.unlinkSync(full); } catch (_) {}
      reqObj.id = reqObj.id || f.replace(/\.json$/, '');
      if (!reqObj.op) reqObj.op = 'run';
      log('MAILBOX picked ' + f + ' op=' + reqObj.op + ' id=' + reqObj.id);
      try {
        dispatch(reqObj).then(function (p) {
          log('MAILBOX done ' + p.id + ' status=' + p.status);
        });
      } catch (e) {
        log('MAILBOX dispatch failed ' + f + ': ' + e.message);
        try {
          fs.writeFileSync(path.join(RESULTS, reqObj.id + '.json'),
            JSON.stringify({ id: reqObj.id, status: 'error', error: String(e.message) }, null, 2), 'utf8');
        } catch (_) {}
      }
    }
  }, loadConfig().pollMs || 1000);
  log('mailbox watching ' + INBOX);
}

/* ---------------- main ---------------- */

log('=== codex-bridge start  pid=' + process.pid + ' node=' + process.version + ' ===');
log('codexPath = ' + loadConfig().codexPath);
probe();
startServer();
startMailbox();
log('ready. ops = run | resume | queue | codex');
/* ============================================================
   ScènePro — POSTE DIFFUSION
   Tourne sur un autre ordinateur (ou sur le même) que la régie.
   - reçoit le programme du bus WEB envoyé par la régie (WebM via le réseau local)
   - gère lui-même la diffusion en ligne (ffmpeg → RTMP/RTMPS, plusieurs plateformes)
   - enregistre le programme sur disque (REC, fichier MP4)
   - sert l'interface de contrôle (diffusion.html) sur http://localhost:7360
   Utilisé par l'application (main.js --diffusion) ou seul : `node station.js`
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '0.0.0'; } })();
const RES = { '480': [854, 480], '720': [1280, 720], '1080': [1920, 1080] };
const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

function log(s) { console.log(new Date().toLocaleTimeString('fr-FR') + '  [diffusion] ' + s); }
function clampInt(v, a, b, def) { v = parseInt(v, 10); return isFinite(v) ? Math.max(a, Math.min(b, v)) : def; }
const mask = s => String(s).replace(/(rtmps?:\/\/[^\s/]+\/[^\s]*?\/)([^\s/]{4})[^\s/]*/gi, '$1$2••••••');
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}`;

function findFfmpeg(root) {
  const local = path.join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) return local;
  try {
    let p = require('ffmpeg-static');
    if (p) p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  return 'ffmpeg';
}

/* ---------- arguments ffmpeg ---------- */
function encodeArgs(cfg, kbps) {
  const fps = clampInt(cfg.fps, 15, 60, 30);
  const akbps = clampInt(cfg.akbps, 64, 320, 160);
  const [w, h] = RES[cfg.res] || RES['720'];
  const preset = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(cfg.preset) ? cfg.preset : 'veryfast';
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostats',
    '-fflags', '+genpts+nobuffer+discardcorrupt', '-thread_queue_size', '2048',
    '-probesize', '1000000', '-analyzeduration', '1500000',
    '-f', 'webm', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-fps_mode', 'cfr', '-r', String(fps),
    '-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency', '-profile:v', 'high',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', `${akbps}k`, '-ar', '48000', '-ac', '2',
    '-progress', 'pipe:1', '-stats_period', '1',
  ];
}
function destUrl(d) {
  const s = String(d.server || '').trim(), k = String(d.key || '').trim();
  if (!k) return s; if (!s) return k;
  return s.replace(/\/+$/, '') + '/' + k.replace(/^\/+/, '');
}
function streamArgs(cfg) {
  const dests = (cfg.dests || []).filter(d => d.enabled && (d.server || d.key)).map(d => ({ name: d.name, url: destUrl(d) }))
    .filter(d => /^(rtmps?|srt|rtsp):\/\//i.test(d.url));
  if (!dests.length) throw new Error('Aucune plateforme active avec une adresse valide (rtmp:// ou rtmps://).');
  const args = encodeArgs(cfg, clampInt(cfg.kbps, 300, 20000, 4500));
  if (dests.length === 1) args.push('-f', 'flv', dests[0].url);
  else args.push('-flags', '+global_header', '-f', 'tee', dests.map(d => `[f=flv:onfail=ignore]${d.url.replace(/\|/g, '%7C')}`).join('|'));
  return { args, dests };
}
function recArgs(cfg, file) {
  const args = encodeArgs(cfg, clampInt(cfg.rkbps, 1000, 50000, 12000));
  args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', file);
  return args;
}
function previewArgs() {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-fflags', '+genpts+nobuffer+discardcorrupt', '-probesize', '500000', '-analyzeduration', '500000',
    '-f', 'webm', '-i', 'pipe:0',
    '-filter_complex', '[0:v]fps=10,scale=640:-2[v];[0:a]aresample=48000,asetnsamples=n=4800,' +
      'astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=Peak_level,ametadata=mode=print:direct=1:file=pipe\\\\:2[a]',
    '-map', '[v]', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:1',
    '-map', '[a]', '-f', 'null', '-',
  ];
}

/* ---------- découpe du flux WebM ----------
   Chaque processus ffmpeg qui démarre en cours de route reçoit l'en-tête (EBML + pistes)
   puis le flux à partir du prochain « Cluster » (qui commence par une image clé). */
function findCluster(buf, from) {
  let i = from || 0;
  while ((i = buf.indexOf(CLUSTER, i)) >= 0) {
    const sb = buf[i + 4];
    if (sb === undefined) return i;
    let len = 1; while (len <= 8 && !(sb & (0x80 >> (len - 1)))) len++;
    const next = buf[i + 4 + len];
    if (len <= 8 && (next === undefined || next === 0xe7)) return i; // Cluster suivi de son Timecode
    i++;
  }
  return -1;
}

class Consumer {
  constructor(name, args, ffmpeg, handlers) {
    this.name = name; this.waiting = true; this.tail = Buffer.alloc(0); this.stopping = false; this.bytes = 0;
    this.proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', e => handlers.onError && handlers.onError(e));
    this.proc.on('close', code => handlers.onClose && handlers.onClose(code, this.stopping));
    if (handlers.onStdout) this.proc.stdout.on('data', handlers.onStdout); else this.proc.stdout.resume();
    let ebuf = '';
    this.proc.stderr.on('data', d => {
      ebuf += d.toString(); let i;
      while ((i = ebuf.indexOf('\n')) >= 0) { const line = ebuf.slice(0, i).trim(); ebuf = ebuf.slice(i + 1); if (line && handlers.onLine) handlers.onLine(line); }
    });
  }
  write(header, chunk) {
    if (this.stopping || !this.proc.stdin.writable) return;
    if (this.waiting) {
      const buf = Buffer.concat([this.tail, chunk]);
      const p = findCluster(buf, 0);
      if (p < 0) { this.tail = buf.subarray(Math.max(0, buf.length - 16)); return; }
      this.waiting = false; this.tail = null;
      this.proc.stdin.write(header);
      chunk = buf.subarray(p);
    }
    this.bytes += chunk.length;
    if (this.proc.stdin.writableLength > 64e6) return; // ffmpeg bloqué : on n'empile pas indéfiniment
    this.proc.stdin.write(chunk);
  }
  stop() {
    if (this.stopping) return; this.stopping = true;
    try { this.proc.stdin.end(); } catch (e) {}
    const p = this.proc; setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 5000);
  }
  kill() { this.stopping = true; try { this.proc.kill('SIGKILL'); } catch (e) {} }
}

function parseProgress(onStats) {
  let buf = '', cur = {};
  return d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const eq = line.indexOf('='); if (eq < 0) continue;
      cur[line.slice(0, eq)] = line.slice(eq + 1);
      if (line.slice(0, eq) === 'progress') {
        onStats({ frame: +cur.frame || 0, fps: parseFloat(cur.fps) || 0, bitrate: parseFloat(cur.bitrate) || 0, totalSize: +cur.total_size || 0,
          dup: +cur.dup_frames || 0, drop: +cur.drop_frames || 0, speed: parseFloat(cur.speed) || 0 });
        cur = {};
      }
    }
  };
}

/**
 * Démarre le poste Diffusion. Options : port (7360), root, confDir, recDir, openPath(dir)
 */
function startStation(opts = {}) {
  const root = opts.root || __dirname;
  const confDir = opts.confDir || path.join(process.env.LOCALAPPDATA || root, 'ScenePro-Diffusion');
  const FFMPEG = findFfmpeg(root);
  let ffmpegOk = false, ffmpegVersion = 'introuvable';
  try { ffmpegVersion = execFileSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).split('\n')[0].trim(); ffmpegOk = true; } catch (e) {}

  /* ----- configuration (clés de stream : uniquement sur cet ordinateur) ----- */
  const cfgFile = path.join(confDir, 'diffusion.json');
  const cfg = {
    regie: { host: '127.0.0.1', port: 7350, code: '' },
    res: '720', fps: 30, kbps: 4500, akbps: 160, preset: 'veryfast', rkbps: 12000,
    recDir: opts.recDir || path.join(os.homedir(), 'Videos', 'ScenePro'),
    dests: [],
  };
  try { const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); Object.assign(cfg, j, { regie: Object.assign(cfg.regie, j.regie || {}) }); } catch (e) {}
  const saveCfg = () => { try { fs.mkdirSync(confDir, { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch (e) { addLog('Impossible d\'enregistrer la configuration : ' + e.message); } };

  const logs = [];
  const uiClients = new Set();
  function broadcast(o) { const m = typeof o === 'string' ? o : JSON.stringify(o); uiClients.forEach(c => { if (c.readyState === 1) c.send(m); }); }
  function addLog(line) {
    line = new Date().toLocaleTimeString('fr-FR') + '  ' + mask(line);
    logs.push(line); if (logs.length > 300) logs.shift();
    broadcast({ type: 'log', line });
  }

  /* ----- liaison avec la régie ----- */
  const feed = {
    status: 'off',   // off | connecting | auth | noregie | waiting | live | error
    ws: null, retryT: null, info: null, header: null, headerDone: false, headerParts: [], lastData: 0, bytes: 0,
    kbpsIn: 0, prevBytes: 0, prevT: 0, regie: {}, err: '', gen: 0,
  };
  function feedConnect() {
    clearTimeout(feed.retryT); feed.retryT = null;
    if (feed.ws) { const w = feed.ws; feed.ws = null; try { w.terminate(); } catch (e) {} }
    const r = cfg.regie;
    if (!r.host) { feed.status = 'off'; return; }
    feed.status = 'connecting'; feed.err = '';
    const url = `ws://${r.host.trim()}:${clampInt(r.port, 1, 65535, 7350)}/feed?role=diffusion&k=${encodeURIComponent(r.code || '')}`;
    let ws;
    try { ws = new WebSocket(url, { handshakeTimeout: 5000, headers: { 'User-Agent': 'ScenePro-Diffusion/' + VERSION } }); }
    catch (e) { feed.status = 'error'; feed.err = e.message; feedRetry(); return; }
    feed.ws = ws;
    ws.on('open', () => { if (feed.ws !== ws) return; feed.status = 'noregie'; addLog(`Connecté au serveur de la régie ${r.host}:${r.port}.`); sendWant(); });
    ws.on('message', (data, isBinary) => {
      if (feed.ws !== ws) return;
      if (isBinary) return onFeedData(data);
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m.type === 'hello' || m.type === 'regie-status') { feed.status = m.regie ? (feed.headerDone ? 'live' : 'waiting') : 'noregie'; if (!m.regie) feedLost('la régie est fermée'); }
      else if (m.type === 'init') onFeedInit(m);
      else if (m.type === 'regie') feed.regie = m.state || {};
      else if (m.type === 'cmd') runCmd(m.cmd);
    });
    ws.on('close', (code, reason) => {
      if (feed.ws !== ws) return;
      feed.ws = null;
      if (code === 4401) { feed.status = 'auth'; feed.err = 'Code d\'accès refusé'; addLog('Code d\'accès refusé par la régie : vérifiez le code à 6 chiffres.'); }
      else if (code === 4403) { feed.status = 'auth'; feed.err = 'Accès réseau bloqué'; addLog('La régie refuse la connexion (accès réseau désactivé ou trop d\'essais).'); }
      else { feed.status = 'error'; feed.err = 'Régie injoignable'; }
      feedLost('liaison réseau coupée');
      feedRetry();
    });
    ws.on('error', e => { if (feed.ws === ws) feed.err = e.code === 'ECONNREFUSED' ? 'Régie injoignable (ScènePro est-il lancé ?)' : e.message; });
  }
  function feedRetry() { clearTimeout(feed.retryT); feed.retryT = setTimeout(feedConnect, feed.status === 'auth' ? 15000 : 3000); }
  function sendFeed(o) { if (feed.ws && feed.ws.readyState === 1) feed.ws.send(JSON.stringify(o)); }
  function sendWant() { sendFeed({ type: 'want', res: cfg.res, fps: clampInt(cfg.fps, 15, 60, 30) }); }

  function onFeedInit(m) {
    feed.info = m; feed.header = null; feed.headerDone = false; feed.headerParts = []; feed.gen++;
    feed.status = 'waiting';
    addLog(`Programme reçu de la régie : ${m.w}×${m.h} ${m.fps} i/s (${m.mime || 'webm'}).`);
    // nouvel en-tête = nouvelle chronologie : les encodeurs en cours redémarrent
    [stream, rec].forEach(x => { if (x.proc) { x.restarting = true; x.proc.stop(); } });
    stopPreview();
  }
  function onFeedData(chunk) {
    feed.lastData = Date.now(); feed.bytes += chunk.length;
    if (!feed.headerDone) {
      feed.headerParts.push(chunk);
      const all = Buffer.concat(feed.headerParts);
      const p = findCluster(all, 0);
      if (p < 0) { if (all.length > 4e6) { feed.headerParts = []; } return; }
      feed.header = all.subarray(0, p); feed.headerDone = true; feed.headerParts = null;
      feed.status = 'live';
      chunk = all.subarray(p);
      ensureConsumers();
    }
    for (const x of [stream, rec]) if (x.proc) x.proc.write(feed.header, chunk);
    if (preview.proc) preview.proc.write(feed.header, chunk);
  }
  function feedLost(why) {
    const was = feed.headerDone;
    feed.headerDone = false; feed.header = null; feed.headerParts = []; feed.info = null;
    if (feed.status === 'live' || feed.status === 'waiting') feed.status = feed.ws ? 'noregie' : 'error';
    stopPreview();
    [stream, rec].forEach(x => { if (x.proc) { x.restarting = true; x.proc.stop(); } });
    if (was) addLog('Programme interrompu (' + why + ').' + (stream.want || rec.want ? ' Reprise automatique dès son retour.' : ''));
  }

  /* ----- aperçu (vignette + vumètres) ----- */
  const preview = { proc: null, levels: [-90, -90], lastFrame: 0 };
  function startPreview() {
    if (preview.proc || !ffmpegOk || !uiClients.size) return;
    let jbuf = Buffer.alloc(0);
    const proc = new Consumer('aperçu', previewArgs(), FFMPEG, {
      onStdout: d => {
        jbuf = jbuf.length ? Buffer.concat([jbuf, d]) : d;
        let e;
        while ((e = jbuf.indexOf(Buffer.from([0xff, 0xd9]))) >= 0) {
          const frame = jbuf.subarray(0, e + 2); jbuf = jbuf.subarray(e + 2);
          if (frame[0] === 0xff && frame[1] === 0xd8) { preview.lastFrame = Date.now(); uiClients.forEach(c => { if (c.readyState === 1 && c.bufferedAmount < 2e6) c.send(frame); }); }
        }
        if (jbuf.length > 8e6) jbuf = Buffer.alloc(0);
      },
      onLine: line => {
        const m = line.match(/lavfi\.astats\.(\d)\.Peak_level=(-?[\d.]+|-inf)/);
        if (m) preview.levels[+m[1] - 1] = m[2] === '-inf' ? -90 : Math.max(-90, parseFloat(m[2]));
      },
      onClose: () => { if (preview.proc === proc) preview.proc = null; preview.levels = [-90, -90]; },
    });
    preview.proc = proc;
  }
  function stopPreview() { if (preview.proc) { preview.proc.kill(); preview.proc = null; } preview.levels = [-90, -90]; }

  /* ----- diffusion et enregistrement ----- */
  const stream = { want: false, proc: null, restarting: false, startedAt: 0, retry: 0, retryT: null, stats: null, prev: null, kbps: 0, hist: [], dropHist: [], err: '', dests: [], status: 'idle' };
  const rec = { want: false, proc: null, restarting: false, startedAt: 0, file: '', files: [], stats: null, err: '', status: 'idle', part: 0 };

  function ensureConsumers() {
    if (!feed.headerDone) return;
    if (uiClients.size) startPreview();
    if (stream.want && !stream.proc && !stream.retryT) launchStream();
    if (rec.want && !rec.proc) launchRec();
  }

  function launchStream() {
    let built;
    try { built = streamArgs(cfg); } catch (e) { stream.err = e.message; stream.want = false; stream.status = 'error'; addLog('ERREUR : ' + e.message); return; }
    stream.dests = built.dests.map(d => d.name);
    stream.status = stream.retry ? 'reconnecting' : 'connecting';
    addLog((stream.retry ? 'Reconnexion' : 'Démarrage de la diffusion') + ' → ' + built.dests.map(d => d.name + ' (' + mask(d.url) + ')').join(', '));
    stream.prev = null;
    const proc = new Consumer('diffusion', built.args, FFMPEG, {
      onStdout: parseProgress(s => {
        const now = Date.now();
        if (stream.prev && s.totalSize >= stream.prev.size) { const dt = (now - stream.prev.t) / 1000; if (dt > 0.2) stream.kbps = (s.totalSize - stream.prev.size) * 8 / 1000 / dt; }
        else stream.kbps = s.bitrate || 0;
        stream.prev = { t: now, size: s.totalSize };
        stream.dropHist.push({ t: now, drop: s.drop }); stream.dropHist = stream.dropHist.filter(x => now - x.t < 10000);
        stream.hist.push(Math.round(stream.kbps)); if (stream.hist.length > 180) stream.hist.shift();
        stream.stats = s;
        if (stream.status !== 'live') { stream.status = 'live'; if (stream.retry) addLog('Diffusion rétablie.'); stream.retry = 0; }
      }),
      onLine: line => addLog(line),
      onError: e => { stream.err = 'Impossible de lancer ffmpeg : ' + e.message; },
      onClose: (code, expected) => {
        if (stream.proc !== proc) return;
        stream.proc = null; stream.stats = null; stream.kbps = 0;
        if (!stream.want) { stream.status = 'idle'; return; }
        if (stream.restarting) { stream.restarting = false; stream.status = 'waitfeed'; ensureConsumers(); return; }
        addLog(`Le flux s'est arrêté (code ${code}).`);
        scheduleStreamRetry();
      },
    });
    stream.proc = proc;
  }
  function scheduleStreamRetry() {
    stream.retry++;
    if (stream.retry > 30) { stream.want = false; stream.status = 'error'; stream.err = 'Trop d\'échecs : vérifiez Internet et les clés de stream.'; addLog('ERREUR : ' + stream.err); return; }
    const delay = Math.min(10000, 2000 + stream.retry * 1000);
    stream.status = 'reconnecting';
    addLog(`Nouvelle tentative dans ${Math.round(delay / 1000)} s (essai ${stream.retry})…`);
    stream.retryT = setTimeout(() => { stream.retryT = null; if (stream.want) { if (feed.headerDone) launchStream(); else stream.status = 'waitfeed'; } }, delay);
  }
  function startStream() {
    if (stream.want) return;
    if (!ffmpegOk) { addLog('ERREUR : ffmpeg est introuvable.'); return; }
    try { streamArgs(cfg); } catch (e) { stream.err = e.message; stream.status = 'error'; addLog('ERREUR : ' + e.message); return; }
    stream.want = true; stream.retry = 0; stream.err = ''; stream.startedAt = Date.now(); stream.hist = []; stream.dropHist = [];
    stream.status = feed.headerDone ? 'connecting' : 'waitfeed';
    if (!feed.headerDone) addLog('Diffusion armée : en attente du programme de la régie.');
    ensureConsumers();
  }
  function stopStream() {
    if (!stream.want && !stream.proc) return;
    stream.want = false; clearTimeout(stream.retryT); stream.retryT = null;
    if (stream.proc) stream.proc.stop();
    stream.status = 'idle'; addLog('Diffusion arrêtée.');
  }

  function launchRec() {
    try { fs.mkdirSync(cfg.recDir, { recursive: true }); } catch (e) { rec.want = false; rec.status = 'error'; rec.err = 'Dossier d\'enregistrement inaccessible : ' + e.message; addLog('ERREUR : ' + rec.err); return; }
    rec.part++;
    const file = path.join(cfg.recDir, `ScenePro_${stamp(new Date(rec.startedAt))}${rec.part > 1 ? '_partie' + rec.part : ''}.mp4`);
    rec.file = file; rec.files.push(file); rec.status = 'rec';
    addLog('Enregistrement → ' + file);
    const proc = new Consumer('rec', recArgs(cfg, file), FFMPEG, {
      onStdout: parseProgress(s => { rec.stats = s; }),
      onLine: line => addLog('REC : ' + line),
      onError: e => { rec.err = 'Impossible de lancer ffmpeg : ' + e.message; },
      onClose: code => {
        if (rec.proc !== proc) return;
        rec.proc = null;
        if (!rec.want) { rec.status = 'idle'; return; }
        if (rec.restarting) { rec.restarting = false; rec.status = 'waitfeed'; ensureConsumers(); return; }
        rec.want = false; rec.status = 'error'; rec.err = `L'enregistrement s'est arrêté (code ${code}).`; addLog('ERREUR : ' + rec.err);
      },
    });
    rec.proc = proc;
  }
  function startRec() {
    if (rec.want) return;
    if (!ffmpegOk) { addLog('ERREUR : ffmpeg est introuvable.'); return; }
    rec.want = true; rec.err = ''; rec.startedAt = Date.now(); rec.part = 0; rec.files = []; rec.stats = null;
    rec.status = feed.headerDone ? 'rec' : 'waitfeed';
    if (!feed.headerDone) addLog('Enregistrement armé : en attente du programme de la régie.');
    ensureConsumers();
  }
  function stopRec() {
    if (!rec.want && !rec.proc) return;
    rec.want = false; if (rec.proc) rec.proc.stop();
    rec.status = 'idle'; addLog('Enregistrement arrêté' + (rec.file ? ' : ' + rec.file : '.'));
  }

  function runCmd(cmd) {
    const map = {
      'stream-start': startStream, 'stream-stop': stopStream, 'stream-toggle': () => stream.want ? stopStream() : startStream(),
      'rec-start': startRec, 'rec-stop': stopRec, 'rec-toggle': () => rec.want ? stopRec() : startRec(),
    };
    if (map[cmd]) { addLog('Commande de la régie : ' + cmd); map[cmd](); }
  }

  function health() {
    if (stream.status !== 'live' || !stream.stats) return null;
    const s = stream.stats, up = Date.now() - stream.startedAt;
    const dh = stream.dropHist, recentDrop = dh.length > 1 ? dh[dh.length - 1].drop - dh[0].drop : 0;
    if (up < 6000) return 'good';
    if ((s.speed && s.speed < 0.9) || recentDrop > cfg.fps * 2) return 'bad';
    if ((s.speed && s.speed < 0.97) || recentDrop > 0) return 'warn';
    return 'good';
  }

  function snapshot() {
    const now = Date.now();
    if (feed.prevT && now - feed.prevT >= 900) { feed.kbpsIn = (feed.bytes - feed.prevBytes) * 8 / 1000 / ((now - feed.prevT) / 1000); feed.prevBytes = feed.bytes; feed.prevT = now; }
    else if (!feed.prevT) { feed.prevT = now; feed.prevBytes = feed.bytes; }
    if (feed.status === 'live' && now - feed.lastData > 4000) feed.kbpsIn = 0;
    return {
      type: 'state', now, version: VERSION, ffmpeg: ffmpegOk, ffmpegVersion,
      feed: { status: feed.status, err: feed.err, info: feed.info, kbps: Math.round(feed.kbpsIn), stalled: feed.status === 'live' && now - feed.lastData > 3000, regie: feed.regie },
      stream: { status: stream.status, want: stream.want, startedAt: stream.startedAt, retry: stream.retry, err: stream.err, dests: stream.dests, kbps: Math.round(stream.kbps), stats: stream.stats, hist: stream.hist, health: health() },
      rec: { status: rec.status, want: rec.want, startedAt: rec.startedAt, file: rec.file, files: rec.files, err: rec.err, size: rec.stats ? rec.stats.totalSize : 0, stats: rec.stats },
      levels: preview.levels,
      cfg,
      free: diskFree(),
    };
  }
  let freeCache = { t: 0, v: null };
  function diskFree() {
    if (Date.now() - freeCache.t < 10000) return freeCache.v;
    freeCache.t = Date.now();
    try { if (fs.statfsSync) { fs.mkdirSync(cfg.recDir, { recursive: true }); const s = fs.statfsSync(cfg.recDir); freeCache.v = s.bavail * s.bsize; } } catch (e) { freeCache.v = null; }
    return freeCache.v;
  }

  // état vers l'interface (2×/s) et vers la régie (1×/s)
  let tickN = 0;
  const tick = setInterval(() => {
    tickN++;
    if (feed.status === 'live' && feed.lastData && Date.now() - feed.lastData > 6000) feedLost('plus de données depuis 6 s');
    if (uiClients.size) broadcast(snapshot()); else if (preview.proc) stopPreview();
    // retour d'état pour la régie (le serveur le relaie aux clients /control en {type:'stream', …})
    // les durées sont envoyées en millisecondes (les horloges des deux ordinateurs peuvent différer)
    if (tickN % 2 === 0) sendFeed({ type: 'status', s: {
      status: stream.status === 'waitfeed' ? 'connecting' : stream.status, health: health(), kbps: Math.round(stream.kbps),
      dests: stream.dests.map(name => ({ name, status: stream.status })), uptime: stream.want ? Date.now() - stream.startedAt : 0,
      rec: { status: rec.status, uptime: rec.want ? Date.now() - rec.startedAt : 0, file: rec.file ? path.basename(rec.file) : '' },
      poste: os.hostname(),
    } });
  }, 500);

  /* ----- serveur de l'interface (cet ordinateur uniquement) ----- */
  let PORT = opts.port || 7360, allowed = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/diffusion' || url.pathname === '/diffusion.html') {
      fs.readFile(path.join(root, 'diffusion.html'), (err, buf) => {
        if (err) { res.writeHead(500); return res.end('diffusion.html introuvable'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(buf);
      });
      return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, role: 'diffusion', version: VERSION, ffmpeg: ffmpegOk }));
    }
    if (url.pathname === '/favicon.ico' || url.pathname === '/icon.png') {
      // logo du poste Diffusion (onglet / bandeau de l'interface)
      fs.readFile(path.join(root, 'build', 'icons', 'diffusion.png'), (err, buf) => {
        if (err) { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' }); res.end(buf);
      });
      return;
    }
    res.writeHead(404); res.end('404');
  });
  const wssUi = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ui' || !allowed.includes(req.headers.origin)) { socket.destroy(); return; }
    wssUi.handleUpgrade(req, socket, head, ws => wssUi.emit('connection', ws, req));
  });
  wssUi.on('connection', ws => {
    uiClients.add(ws);
    ws.send(JSON.stringify({ type: 'logs', lines: logs }));
    ws.send(JSON.stringify(snapshot()));
    ensureConsumers();
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type === 'cfg' && m.cfg && typeof m.cfg === 'object') {
        const before = JSON.stringify(cfg.regie), beforeQ = cfg.res + '/' + cfg.fps;
        for (const k of ['res', 'preset', 'recDir']) if (typeof m.cfg[k] === 'string') cfg[k] = m.cfg[k];
        for (const k of ['fps', 'kbps', 'akbps', 'rkbps']) if (m.cfg[k] != null) cfg[k] = +m.cfg[k] || cfg[k];
        if (Array.isArray(m.cfg.dests)) cfg.dests = m.cfg.dests.filter(x => x && typeof x === 'object').map(x => ({
          id: String(x.id || Math.random().toString(36).slice(2, 10)), service: String(x.service || 'custom'), name: String(x.name || ''),
          server: String(x.server || ''), key: String(x.key || ''), enabled: !!x.enabled }));
        if (m.cfg.regie && typeof m.cfg.regie === 'object') {
          cfg.regie = { host: String(m.cfg.regie.host || '').trim(), port: clampInt(m.cfg.regie.port, 1, 65535, 7350), code: String(m.cfg.regie.code || '').replace(/\D/g, '').slice(0, 6) };
        }
        saveCfg();
        if (JSON.stringify(cfg.regie) !== before) feedConnect();
        else if (cfg.res + '/' + cfg.fps !== beforeQ) sendWant();
      }
      else if (m.type === 'stream') m.on ? startStream() : stopStream();
      else if (m.type === 'rec') m.on ? startRec() : stopRec();
      else if (m.type === 'route') sendFeed({ type: 'route', bus: clampInt(m.bus, 1, 3, 1) });
      else if (m.type === 'reconnect') feedConnect();
      else if (m.type === 'openRec') openDir(cfg.recDir);
    });
    ws.on('close', () => { uiClients.delete(ws); });
  });
  function openDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    if (opts.openPath) return opts.openPath(dir);
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
  }

  feedConnect();

  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = () => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && opts.portFallback !== false && tries < 20) { tries++; PORT++; tryListen(); } else reject(e); });
      server.listen(PORT, '127.0.0.1', () => {
        allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
        log(`Poste Diffusion ${VERSION} sur http://localhost:${PORT}/ — ffmpeg : ${ffmpegOk ? ffmpegVersion : 'INTROUVABLE'}`);
        resolve({
          port: PORT, url: `http://localhost:${PORT}/`,
          busy: () => stream.want || rec.want,
          close() {
            clearInterval(tick); clearTimeout(feed.retryT); clearTimeout(stream.retryT);
            stream.want = rec.want = false;
            [stream.proc, rec.proc].forEach(p => { if (p) p.stop(); });
            stopPreview();
            if (feed.ws) try { feed.ws.terminate(); } catch (e) {}
            wssUi.clients.forEach(c => c.terminate());
            return new Promise(r => setTimeout(() => server.close(() => r()), 600));
          },
        });
      });
    };
    tryListen();
  });
}

/* ---------- application de bureau : ScènePro.exe --diffusion ----------
   Appelé en tête de main.js, AVANT le verrou d'instance de la régie : données et verrou séparés,
   pour pouvoir lancer la régie et le poste Diffusion sur le même ordinateur. */
function runElectron() {
  const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
  app.setName('ScènePro Diffusion');
  app.setPath('userData', path.join(app.getPath('appData'), 'ScènePro Diffusion'));
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let win = null, st = null;
  const ICON = path.join(__dirname, 'build', 'icons', 'diffusion.png');
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    try {
      st = await startStation({ port: 7360, root: __dirname, confDir: app.getPath('userData'), recDir: path.join(app.getPath('videos'), 'ScenePro'), openPath: d => shell.openPath(d) });
    } catch (e) { dialog.showErrorBox('ScènePro Diffusion', 'Impossible de démarrer le poste Diffusion : ' + e.message); app.quit(); return; }
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({ width: 1400, height: 900, minWidth: 980, minHeight: 640, backgroundColor: '#141619', title: 'ScènePro Diffusion', icon: ICON, show: false,
      autoHideMenuBar: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, spellcheck: false } });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(st.url)) { e.preventDefault(); shell.openExternal(url); } });
    win.webContents.on('will-prevent-unload', e => {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Quitter quand même', 'Annuler'], defaultId: 1, cancelId: 1, title: 'ScènePro Diffusion',
        message: 'Une diffusion ou un enregistrement est en cours.', detail: 'Quitter coupera la diffusion en ligne et terminera l\'enregistrement.' });
      if (r === 0) e.preventDefault();
    });
    win.on('closed', () => { win = null; });
    win.loadURL(st.url);
  });
  app.on('window-all-closed', async () => { if (st) { try { await st.close(); } catch (e) {} } app.quit(); });
}

module.exports = { startStation, findCluster, runElectron };

/* ---------- utilisation seule : node station.js ---------- */
if (require.main === module) {
  startStation({ portFallback: false }).then(({ port }) => {
    console.log('  Gardez cette fenêtre ouverte pendant le show.');
    if (process.argv.includes('--no-browser') || process.platform !== 'win32') return;
    const profile = path.join(process.env.LOCALAPPDATA || __dirname, 'ScenePro-Diffusion', 'profil');
    const args = [`--app=http://localhost:${port}/`, `--user-data-dir=${profile}`, '--window-size=1400,900', '--no-first-run'];
    spawn('cmd', ['/c', 'start', '""', 'msedge', ...args.map(a => `"${a}"`)], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }).catch(e => {
    if (e.code === 'EADDRINUSE') { console.log('Le poste Diffusion tourne déjà (port 7360).'); process.exit(0); }
    console.error(e); process.exit(1);
  });
}

/* ============================================================
   ScènePro — poste Enregistrement (moteur)
   - fonctionne seul (serveur local http://localhost:7380, réglages propres) ;
   - se connecte à la régie (ws://ADRESSE:7350/rec) quand elle est allumée, avec le code
     à 6 chiffres si la régie est sur un autre ordinateur ;
   - enregistre chaque bus demandé (PGM 1, PGM 2, PGM 3, WEB) dans son propre fichier,
     sans perte de qualité (copie du flux) en MKV, ou en MP4 compatible montage.
   Utilisé par l'application (main.js --enregistreur) ou seul : `node recorder.js`
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const SOURCES = ['pgm1', 'pgm2', 'pgm3', 'web'];
const LABEL = { pgm1: 'PGM 1', pgm2: 'PGM 2', pgm3: 'PGM 3', web: 'WEB' };
function log(s) { console.log(new Date().toLocaleTimeString('fr-FR') + '  [Enregistreur] ' + s); }

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
function defaultFolder() {
  const v = path.join(os.homedir(), 'Videos');
  return path.join(fs.existsSync(v) ? v : os.homedir(), 'ScènePro Enregistrements');
}
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}`; };
const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60);

/**
 * Démarre le poste Enregistrement. Options : port (7380), root, confDir, pickFolder(cur) → Promise<string|null>, openPath(p)
 * Renvoie une promesse { port, url, close() }.
 */
function startRecorder(opts = {}) {
  const root = opts.root || __dirname;
  const confDir = opts.confDir || path.join(process.env.LOCALAPPDATA || root, 'ScenePro Enregistreur');
  const cfgFile = path.join(confDir, 'enregistreur.json');
  const FFMPEG = findFfmpeg(root);
  const openPath = opts.openPath || (p => spawn(process.platform === 'win32' ? 'explorer' : 'xdg-open', [p], { detached: true, stdio: 'ignore' }).unref());

  const cfg = Object.assign({
    regie: 'localhost:7350', code: '', folder: opts.defaultFolder || defaultFolder(), format: 'mp4', res: '1080', fps: 30, prefix: '',
    armed: { pgm1: true, pgm2: false, pgm3: false, web: false },
  }, (() => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); } catch (e) { return {}; } })());
  const saveCfg = () => { try { fs.mkdirSync(confDir, { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch (e) {} };

  const link = { status: 'offline', regie: false, err: '', sources: [] }; // offline | connecting | connected | refused | blocked
  const rec = {};
  SOURCES.forEach(s => rec[s] = { status: 'idle', ws: null, ff: null, file: '', t0: 0, bytes: 0, lastBytes: 0, kbps: 0, err: '', part: 0, mime: '', stopping: false });
  const recent = [];
  const uiClients = new Set();

  /* ---------- liaison avec la régie ---------- */
  let ctl = null, ctlTimer = null, closing = false;
  const isLocalRegie = () => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(cfg.regie.trim());
  const wsUrl = q => `ws://${cfg.regie.trim().replace(/^wss?:\/\//, '').replace(/\/.*$/, '')}/rec?${q}${cfg.code ? '&k=' + encodeURIComponent(cfg.code) : ''}`;
  function connectCtl() {
    clearTimeout(ctlTimer);
    if (closing) return;
    if (ctl) { try { ctl.removeAllListeners(); ctl.terminate(); } catch (e) {} ctl = null; }
    if (!cfg.regie.trim()) { link.status = 'offline'; return; }
    link.status = 'connecting'; link.err = '';
    let ws;
    try { ws = new WebSocket(wsUrl('role=ctl')); } catch (e) { link.status = 'offline'; link.err = e.message; ctlTimer = setTimeout(connectCtl, 3000); return; }
    ctl = ws;
    ws.on('open', () => { link.status = 'connected'; log(`Connecté à la régie ${cfg.regie}`); sendStatus(true); push(); });
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type === 'hello' || m.type === 'regie-status') { link.regie = !!m.regie; push(); }
      else if (m.type === 'cmd') runCmd(m.cmd, m.arg);
    });
    ws.on('close', code => {
      if (ctl !== ws) return;
      ctl = null; link.regie = false;
      link.status = code === 4401 ? 'refused' : code === 4403 ? 'blocked' : 'offline';
      link.err = code === 4401 ? 'Code d\'accès incorrect' : code === 4403 ? 'Trop d\'essais : patientez 2 minutes' : '';
      push();
      ctlTimer = setTimeout(connectCtl, code === 4401 ? 10000 : 3000);
    });
    ws.on('error', () => {});
  }
  let lastSent = '';
  function sendStatus(force) {
    if (!ctl || ctl.readyState !== 1) return;
    const s = { poste: os.hostname(), sources: {}, disk: disk() };
    SOURCES.forEach(k => { const r = rec[k]; s.sources[k] = { status: r.status, uptime: r.t0 ? Date.now() - r.t0 : 0, file: r.file ? path.basename(r.file) : '', bytes: r.bytes }; });
    const j = JSON.stringify(s);
    if (!force && j === lastSent) return;
    lastSent = j;
    ctl.send(JSON.stringify({ type: 'status', s }));
  }
  function runCmd(cmd, arg) {
    const list = arg ? [SOURCES[arg - 1]].filter(Boolean) : SOURCES.filter(k => cfg.armed[k]);
    if (!list.length) return;
    const anyOn = list.some(k => rec[k].status !== 'idle');
    list.forEach(k => {
      if (cmd === 'enr-start' || (cmd === 'enr-toggle' && !anyOn)) startRec(k);
      else if (cmd === 'enr-stop' || cmd === 'enr-toggle') stopRec(k);
    });
  }

  /* ---------- enregistrement d'un bus ---------- */
  function ffArgs(mime, file) {
    const h264 = /h264|avc1/i.test(mime || '');
    const a = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-i', 'pipe:0'];
    if (cfg.format === 'mkv') a.push('-c', 'copy');
    else {
      a.push('-c:v', h264 ? 'copy' : 'libx264');
      if (!h264) a.push('-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
      a.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+frag_keyframe+empty_moov+default_base_moof');
    }
    a.push('-avoid_negative_ts', 'make_zero', '-y', file);
    return a;
  }
  function newFile(k) {
    const r = rec[k];
    try { fs.mkdirSync(cfg.folder, { recursive: true }); } catch (e) {}
    const base = `${stamp()}_${cfg.prefix ? safe(cfg.prefix) + '_' : ''}${LABEL[k].replace(' ', '')}${r.part > 1 ? '_partie' + r.part : ''}`;
    return path.join(cfg.folder, base + (cfg.format === 'mkv' ? '.mkv' : '.mp4'));
  }
  function openFf(k) {
    const r = rec[k];
    closeFf(k);
    r.part++;
    const file = newFile(k);
    const ff = spawn(FFMPEG, ffArgs(r.mime, file), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    r.ff = ff; r.file = file;
    let err = '';
    ff.stderr.on('data', d => { err = (err + d.toString()).slice(-600); });
    ff.stdin.on('error', () => {});
    ff.on('error', e => { r.status = 'error'; r.err = 'ffmpeg : ' + e.message; push(); });
    ff.on('close', code => {
      try { const st = fs.statSync(file); if (st.size > 0) { recent.unshift({ file, size: st.size, t: Date.now(), source: k }); recent.splice(30); } } catch (e) {}
      if (r.ff === ff) { r.ff = null; if (code && !r.stopping) { r.status = 'error'; r.err = err.trim().split('\n').pop() || 'erreur ffmpeg ' + code; } }
      push();
    });
    log(`${LABEL[k]} → ${file}`);
  }
  function closeFf(k) { const r = rec[k]; if (r.ff) { const f = r.ff; r.ff = null; try { f.stdin.end(); } catch (e) {} setTimeout(() => { try { f.kill(); } catch (e) {} }, 8000); } }
  function startRec(k) {
    const r = rec[k];
    if (r.status === 'rec' || r.status === 'wait') return;
    r.status = 'wait'; r.err = ''; r.part = 0; r.bytes = 0; r.lastBytes = 0; r.kbps = 0; r.t0 = 0; r.file = ''; r.stopping = false;
    connectData(k);
    push();
  }
  function connectData(k) {
    const r = rec[k];
    if (r.status === 'idle') return;
    if (r.ws) { try { r.ws.removeAllListeners(); r.ws.terminate(); } catch (e) {} }
    let ws;
    try { ws = new WebSocket(wsUrl(`source=${k}&res=${cfg.res}&fps=${cfg.fps}`)); } catch (e) { r.err = e.message; setTimeout(() => connectData(k), 3000); return; }
    r.ws = ws;
    ws.on('message', (d, isBinary) => {
      if (r.ws !== ws) return;
      if (isBinary) {
        if (r.ff && r.ff.stdin.writable) { r.ff.stdin.write(d); r.bytes += d.length; }
        return;
      }
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type === 'init') {
        // nouvel en-tête : nouveau fichier (le premier, ou une « partie » si la régie a relancé ce bus)
        r.mime = m.mime || '';
        openFf(k);
        if (!r.t0) r.t0 = Date.now();
        r.status = 'rec'; r.err = '';
        push();
      } else if (m.type === 'source-lost') { closeFf(k); r.status = 'wait'; r.err = 'La régie a arrêté ce bus'; push(); }
      else if (m.type === 'hello' && !m.regie) { r.err = 'Régie fermée : en attente'; push(); }
    });
    ws.on('close', code => {
      if (r.ws !== ws) return;
      r.ws = null;
      if (r.status === 'idle') return;
      closeFf(k);
      r.status = 'wait';
      r.err = code === 4401 ? 'Code d\'accès incorrect' : 'Liaison avec la régie perdue : reconnexion…';
      push();
      setTimeout(() => connectData(k), code === 4401 ? 10000 : 2000);
    });
    ws.on('error', () => {});
  }
  function stopRec(k) {
    const r = rec[k];
    if (r.status === 'idle') return;
    r.status = 'idle'; r.stopping = true;
    if (r.ws) { const w = r.ws; r.ws = null; try { w.close(); } catch (e) {} }
    closeFf(k);
    r.t0 = 0; r.kbps = 0; r.err = '';
    push();
  }

  function disk() {
    try {
      fs.mkdirSync(cfg.folder, { recursive: true });
      const st = fs.statfsSync(cfg.folder);
      return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch (e) { return { free: 0, total: 0 }; }
  }

  /* ---------- interface (page enregistreur.html) ---------- */
  function state() {
    const s = { type: 'state', cfg, link, ffmpeg: FFMPEG, disk: disk(), recent: recent.slice(0, 12).map(x => ({ name: path.basename(x.file), size: x.size, t: x.t, source: x.source })), sources: {} };
    SOURCES.forEach(k => { const r = rec[k]; s.sources[k] = { status: r.status, uptime: r.t0 ? Date.now() - r.t0 : 0, bytes: r.bytes, kbps: r.kbps, file: r.file ? path.basename(r.file) : '', err: r.err, part: r.part }; });
    return s;
  }
  function push() { const m = JSON.stringify(state()); uiClients.forEach(c => { if (c.readyState === 1) c.send(m); }); sendStatus(); }
  const tick = setInterval(() => {
    SOURCES.forEach(k => { const r = rec[k]; r.kbps = (r.bytes - r.lastBytes) * 8 / 1000; r.lastBytes = r.bytes; });
    push();
  }, 1000);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/logo.png' || u.pathname === '/favicon.ico') {
      fs.readFile(path.join(root, 'build', 'icons', 'enregistreur.png'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' }); res.end(buf);
      });
      return;
    }
    if (u.pathname === '/' || u.pathname === '/enregistreur.html') {
      fs.readFile(path.join(root, 'enregistreur.html'), (err, buf) => {
        if (err) { res.writeHead(500); return res.end('enregistreur.html introuvable'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(buf);
      });
      return;
    }
    res.writeHead(404); res.end('404');
  });
  const wssUi = new WebSocketServer({ noServer: true });
  let PORT = opts.port || 7380;
  server.on('upgrade', (req, socket, head) => {
    const okOrigin = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin);
    if (new URL(req.url, 'http://x').pathname !== '/ui' || !okOrigin) { socket.destroy(); return; }
    wssUi.handleUpgrade(req, socket, head, ws => wssUi.emit('connection', ws, req));
  });
  wssUi.on('connection', ws => {
    uiClients.add(ws);
    ws.send(JSON.stringify(state()));
    ws.on('message', async d => {
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type === 'rec') { m.on ? startRec(m.source) : stopRec(m.source); }
      else if (m.type === 'recAll') { SOURCES.filter(k => cfg.armed[k]).forEach(k => m.on ? startRec(k) : stopRec(k)); }
      else if (m.type === 'cfg' && m.cfg) {
        const before = cfg.regie + '|' + cfg.code;
        ['regie', 'code', 'folder', 'format', 'res', 'prefix'].forEach(f => { if (typeof m.cfg[f] === 'string') cfg[f] = m.cfg[f].trim(); });
        if (m.cfg.fps) cfg.fps = Math.max(15, Math.min(60, +m.cfg.fps || 30));
        if (m.cfg.armed) SOURCES.forEach(k => { if (k in m.cfg.armed) cfg.armed[k] = !!m.cfg.armed[k]; });
        if (!['mp4', 'mkv'].includes(cfg.format)) cfg.format = 'mp4';
        if (!['480', '720', '1080'].includes(cfg.res)) cfg.res = '1080';
        saveCfg();
        if (before !== cfg.regie + '|' + cfg.code) connectCtl();
        push();
      }
      else if (m.type === 'reconnect') connectCtl();
      else if (m.type === 'openFolder') { try { fs.mkdirSync(cfg.folder, { recursive: true }); openPath(cfg.folder); } catch (e) {} }
      else if (m.type === 'openFile' && m.name) { const f = path.join(cfg.folder, path.basename(m.name)); if (fs.existsSync(f)) openPath(f); }
      else if (m.type === 'pickFolder' && opts.pickFolder) { const f = await opts.pickFolder(cfg.folder); if (f) { cfg.folder = f; saveCfg(); push(); } }
    });
    ws.on('close', () => uiClients.delete(ws));
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = () => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && tries < 20 && opts.portFallback !== false) { tries++; PORT++; tryListen(); } else reject(e); });
      server.listen(PORT, '127.0.0.1', () => {
        log(`Poste Enregistrement sur http://localhost:${PORT}/ — régie : ${cfg.regie}`);
        connectCtl();
        resolve({
          port: PORT, url: `http://localhost:${PORT}/`,
          recording: () => SOURCES.some(k => rec[k].status !== 'idle'),
          close() {
            closing = true; clearInterval(tick); clearTimeout(ctlTimer);
            SOURCES.forEach(stopRec);
            if (ctl) { try { ctl.terminate(); } catch (e) {} }
            wssUi.clients.forEach(c => c.terminate());
            return new Promise(r => server.close(() => r()));
          },
        });
      });
    };
    tryListen();
  });
}

/* ---------- dans l'application : ScènePro.exe --enregistreur ---------- */
function runElectron() {
  const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
  // données et verrou d'instance séparés de la régie : les deux tournent en même temps sur le même PC
  app.setPath('userData', path.join(app.getPath('appData'), 'ScènePro Enregistrement'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  let win = null, rec = null;
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    try {
      rec = await startRecorder({
        root: __dirname, confDir: app.getPath('userData'),
        defaultFolder: (() => { try { return path.join(app.getPath('videos'), 'ScènePro Enregistrements'); } catch (e) { return undefined; } })(),
        openPath: p => shell.openPath(p),
        pickFolder: async cur => { const r = await dialog.showOpenDialog(win, { title: 'Dossier d\'enregistrement', defaultPath: cur, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
      });
    } catch (e) { dialog.showErrorBox('ScènePro Enregistrement', 'Démarrage impossible : ' + e.message); app.quit(); return; }
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1300, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0a0c0f', title: 'ScènePro — Enregistrement',
      icon: path.join(__dirname, 'build', 'icons', 'enregistreur.png'), autoHideMenuBar: true,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('close', e => {
      if (rec && rec.recording()) {
        const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Arrêter et quitter', 'Annuler'], defaultId: 1, cancelId: 1, title: 'ScènePro Enregistrement', message: 'Des enregistrements sont en cours.', detail: 'Quitter les arrête proprement (les fichiers restent lisibles).' });
        if (r === 1) e.preventDefault();
      }
    });
    win.loadURL(rec.url);
  });
  app.on('window-all-closed', async () => { if (rec) { try { await rec.close(); } catch (e) {} } app.quit(); });
}

module.exports = { startRecorder, runElectron, SOURCES };

/* ---------- utilisation seule : node recorder.js ---------- */
if (require.main === module) {
  startRecorder({ portFallback: false }).then(({ port }) => {
    if (process.argv.includes('--no-browser') || process.platform !== 'win32') return;
    const profile = path.join(process.env.LOCALAPPDATA || __dirname, 'ScenePro', 'profil-enregistreur');
    const args = [`--app=http://localhost:${port}/`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,860'];
    spawn('cmd', ['/c', 'start', '""', 'msedge', ...args.map(a => `"${a}"`)], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }).catch(e => { console.error(e.code === 'EADDRINUSE' ? 'Le poste Enregistrement tourne déjà (port 7380).' : e); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); });
}

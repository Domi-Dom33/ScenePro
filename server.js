/* ============================================================
   ScènePro — serveur local
   - sert la régie sur http://localhost:7350
   - relaie le programme WEB de la régie vers les postes Diffusion (station.js), qui
     encodent eux-mêmes vers RTMP/RTMPS et enregistrent ; leur état est renvoyé à la régie
   - télécommandes (Stream Deck, Companion, claviers macro) via /api/cmd
   Utilisé par l'application (main.js) ou seul : `node server.js`
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const createBusFeed = require('./busfeed');
const discovery = require('./discovery');
const { createCpuMeter } = require('./cpu');

const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '0.0.0'; } })();
const COMMANDS = ['auto', 'cut', 'next', 'black', 'pause', 'restart', 'mute', 'prev', 'pvwnext', 'cue',
  'stream-start', 'stream-stop', 'stream-toggle', 'rec-start', 'rec-stop', 'rec-toggle', 'fs1', 'fs2', 'fs3', 'bus', 'pip',
  'enr-start', 'enr-stop', 'enr-toggle'];
// commandes exécutées par le poste Diffusion (pas par la régie)
const STATION_CMD = /^(stream|rec)-(start|stop|toggle)$/;

function log(s) { console.log(new Date().toLocaleTimeString('fr-FR') + '  ' + s); }
function clampInt(v, a, b, def) { v = parseInt(v, 10); return isFinite(v) ? Math.max(a, Math.min(b, v)) : def; }

/**
 * Démarre le serveur. Options :
 *  port (7350), root (dossier de ScenePro.html), confDir (dossier du jeton de télécommande)
 * Renvoie une promesse { port, url, close() }. Si le port est occupé, essaie les suivants.
 */
function startServer(opts = {}) {
  const root = opts.root || __dirname;
  const confDir = opts.confDir || path.join(process.env.LOCALAPPDATA || root, 'ScenePro');

  // jeton qui protège les télécommandes
  const tokenFile = path.join(confDir, 'telecommande.txt');
  let TOKEN = '';
  try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) {}
  if (!/^[a-f0-9]{12,}$/.test(TOKEN)) {
    TOKEN = crypto.randomBytes(8).toString('hex');
    try { fs.mkdirSync(confDir, { recursive: true }); fs.writeFileSync(tokenFile, TOKEN); } catch (e) {}
  }

  // accès depuis les autres ordinateurs du réseau local (poste Synthé, overlay, Stream Deck) :
  // protégé par un code à 6 chiffres. La régie, la diffusion et ses clés restent réservées à cet ordinateur.
  const LAN = opts.lan !== false;
  const pinFile = path.join(confDir, 'acces-reseau.txt');
  let PIN = '';
  try { PIN = fs.readFileSync(pinFile, 'utf8').trim(); } catch (e) {}
  if (!/^\d{6}$/.test(PIN)) {
    PIN = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    try { fs.mkdirSync(confDir, { recursive: true }); fs.writeFileSync(pinFile, PIN); } catch (e) {}
  }
  const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const remoteIp = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  function lanIps() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ ip: a.address, name });
    return out;
  }
  // anti-essais : 8 mauvais codes depuis une même machine = bloquée 2 minutes
  const fails = new Map();
  const blocked = ip => { const f = fails.get(ip); return f && f.n >= 8 && Date.now() - f.t < 120000; };
  const fail = ip => { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 120000) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); };
  const REMOTE_OK = /^\/(synthe|Synthe\.html|overlay|overlay\.html|programmes|Programmes\.html|gfx-render\.js|favicon\.ico|api\/cmd\/.*|api\/gfx\/.*|api\/state|api\/hello|api\/conducteur|conducteur|conducteur\.html|api\/prog\/.*|api\/progcmd\/.*|prog\/media\/.*)$/;
  const lanInfo = () => ({ enabled: LAN, port: PORT, pin: PIN, ips: lanIps() });

  const controlClients = new Set();
  let lastState = {};
  const cpu = createCpuMeter(); // CPU de la régie (application) et du PC
  let rundown = null; // conducteur calculé par la régie (page /conducteur)
  let PORT = opts.port || 7350;
  let allowed = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!isLoopback(req) && !REMOTE_OK.test(url.pathname)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>ScènePro</title><body style="font:16px/1.6 'Segoe UI',sans-serif;background:#0a0c0f;color:#e7eaee;padding:40px">
        <h2>ScènePro</h2><p>La régie n'est accessible que sur l'ordinateur de la régie.</p>
        <p>Depuis cet ordinateur vous pouvez ouvrir :</p><ul><li><a style="color:#3d8bff" href="/synthe">le poste Synthé / habillage</a></li>
        <li><a style="color:#3d8bff" href="/programmes">le poste Programmes (reportages, clips)</a></li>
        <li><a style="color:#3d8bff" href="/overlay">la page d'incrustation (OBS, vMix…)</a></li></ul></body>`);
    }
    if (url.pathname === '/favicon.ico' || url.pathname === '/logo-regie.png') {
      return fs.readFile(path.join(root, 'build', 'icons', 'regie.png'), (err, buf) => { if (err) { res.writeHead(204); return res.end(); } res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' }); res.end(buf); });
    }
    const cm = url.pathname.match(/^\/api\/cmd\/([a-z0-9-]+)(?:\/(\d+))?\/?$/);
    if (cm) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.searchParams.get('k') !== TOKEN) { res.writeHead(403); return res.end('{"ok":false,"error":"jeton invalide"}'); }
      if (!COMMANDS.includes(cm[1])) { res.writeHead(404); return res.end('{"ok":false,"error":"commande inconnue"}'); }
      if (/^enr-/.test(cm[1])) {
        // enregistrement des bus : exécuté par le poste Enregistrement (enr-toggle/1..4 = PGM 1, 2, 3, WEB ; sans numéro = bus cochés)
        const n = busfeed.cmd(cm[1], cm[2] ? +cm[2] : null);
        res.writeHead(n ? 200 : 409); return res.end(JSON.stringify(n ? { ok: true, cmd: cm[1], postes: n } : { ok: false, error: 'aucun poste Enregistrement connecté' }));
      }
      if (STATION_CMD.test(cm[1])) {
        // diffusion / enregistrement : exécutés par le poste Diffusion, même si la régie est fermée
        if (!feedClients.size) { res.writeHead(409); return res.end('{"ok":false,"error":"aucun poste Diffusion connecté"}'); }
        toStations({ type: 'cmd', cmd: cm[1] });
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, cmd: cm[1], postes: feedClients.size, diffusion: streamSummary() }));
      }
      const msg = JSON.stringify({ type: 'cmd', cmd: cm[1], arg: cm[2] ? +cm[2] : null });
      controlClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, cmd: cm[1], regies: controlClients.size, state: lastState }));
    }
    if (url.pathname === '/api/state') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.searchParams.get('k') !== TOKEN) { res.writeHead(403); return res.end('{"ok":false}'); }
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, state: lastState }));
    }
    // habillage : télécommandes du poste Synthé (Stream Deck, Companion…)
    const gm = url.pathname.match(/^\/api\/gfx\/(take|on|off|next|clear|select)(?:\/(\d+))?\/?$/);
    if (gm) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.searchParams.get('k') !== TOKEN) { res.writeHead(403); return res.end('{"ok":false,"error":"jeton invalide"}'); }
      const synthes = [...gfxClients].filter(c => c._role === 'synthe' && c.readyState === 1);
      if (!synthes.length) { res.writeHead(409); return res.end('{"ok":false,"error":"poste Synthé non ouvert"}'); }
      const msg = JSON.stringify({ type: 'cmd', cmd: gm[1], arg: gm[2] ? +gm[2] : null });
      synthes.forEach(c => c.send(msg));
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, cmd: gm[1], arg: gm[2] ? +gm[2] : null }));
    }
    // poste Programmes : bibliothèque de reportages / clips, lecture des fichiers, télécommandes
    if (/^\/(api\/prog\/|prog\/media\/)/.test(url.pathname)) return progHttp(req, res, url);
    const pc = url.pathname.match(/^\/api\/progcmd\/(take|stop|pause|restart|stopall)(?:\/(\d+))?\/?$/);
    if (pc) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.searchParams.get('k') !== TOKEN) { res.writeHead(403); return res.end('{"ok":false,"error":"jeton invalide"}'); }
      const r = progAction({ type: pc[1], bus: clampInt(url.searchParams.get('bus'), 1, 3, 1), id: pc[2] ? (progList[+pc[2] - 1] || {}).id : null });
      res.writeHead(r.ok ? 200 : 409); return res.end(JSON.stringify(r));
    }
    const STATIC = { '/synthe': ['Synthe.html', 'text/html'], '/Synthe.html': ['Synthe.html', 'text/html'], '/overlay': ['overlay.html', 'text/html'],
      '/overlay.html': ['overlay.html', 'text/html'], '/gfx-render.js': ['gfx-render.js', 'text/javascript'],
      '/programmes': ['Programmes.html', 'text/html'], '/Programmes.html': ['Programmes.html', 'text/html'],
      '/conducteur': ['conducteur.html', 'text/html'], '/conducteur.html': ['conducteur.html', 'text/html'] };
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      fs.readFile(path.join(root, file), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(file + ' introuvable'); }
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/ScenePro.html') {
      fs.readFile(path.join(root, 'ScenePro.html'), (err, buf) => {
        if (err) { res.writeHead(500); return res.end('ScenePro.html introuvable'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    // identification sans code : un poste vérifie qu'il parle bien à une régie ScènePro (adresse et port corrects)
    // conducteur : lisible sans code sur cet ordinateur, avec le code d'accès ailleurs sur le réseau
    if (url.pathname === '/api/conducteur') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      if (!isLoopback(req)) {
        const ip = remoteIp(req);
        if (!LAN || blocked(ip)) { res.writeHead(403); return res.end('{"ok":false,"error":"bloque"}'); }
        if (url.searchParams.get('code') !== PIN) { fail(ip); res.writeHead(401); return res.end('{"ok":false,"error":"code"}'); }
        fails.delete(ip);
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, now: Date.now(), regie: controlClients.size > 0, r: rundown }));
    }
    if (url.pathname === '/api/cpu') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(cpu.get()));
    }
    if (url.pathname === '/api/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ app: 'ScenePro', role: 'regie', name: os.hostname(), port: PORT, version: VERSION, lan: LAN, regieOuverte: controlClients.size > 0 }));
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, version: VERSION, app: !!opts.app, postesDiffusion: feedClients.size }));
    }
    res.writeHead(404); res.end('404');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const wssCtl = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const wssGfx = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const wssFeed = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // flux des bus pour le poste Enregistrement (busfeed.js)
  const busfeed = createBusFeed({
    log, isLoopback, remoteIp, allowedOrigin: o => allowed.includes(o), lan: () => LAN, pin: () => PIN,
    blocked, fail, clearFail: ip => fails.delete(ip), controlClients,
  });
  server.on('upgrade', (req, socket, head) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (busfeed.handles(p)) { busfeed.upgrade(req, socket, head, p); return; }
    if (p === '/feed') {
      // poste Diffusion (application, pas une page web) : code à 6 chiffres vérifié à la connexion si autre ordinateur
      if (req.headers.origin && !allowed.includes(req.headers.origin)) { socket.destroy(); return; }
      wssFeed.handleUpgrade(req, socket, head, ws => wssFeed.emit('connection', ws, req));
      return;
    }
    if (p === '/live' || p === '/control') {
      // régie et diffusion : uniquement depuis cet ordinateur
      if (!isLoopback(req) || !allowed.includes(req.headers.origin)) { socket.destroy(); return; }
    } else if (p === '/prog') {
      // poste Programmes : code d'accès vérifié à la connexion (sauf page de cette régie sur cet ordinateur)
    } else if (p === '/gfx') {
      // poste Synthé / overlay : toute origine (poste autonome sur le port 7370, fichier local, autre PC…),
      // le code d'accès est vérifié à la connexion pour tout ce qui n'est pas une page de cette régie sur cet ordinateur
    } else { socket.destroy(); return; }
    const target = p === '/live' ? wss : p === '/gfx' ? wssGfx : p === '/prog' ? wssProg : wssCtl;
    target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
  });
  // habillage : dernier état envoyé par le poste Synthé, relayé à la régie et aux pages /overlay
  let gfxState = null, gfxMsg = null;
  const gfxClients = new Set();
  const gfxPeers = () => {
    const m = JSON.stringify({ type: 'peers', regies: controlClients.size, token: TOKEN });
    gfxClients.forEach(c => { if (c._role === 'synthe' && c.readyState === 1) c.send(m); });
    const postes = [...gfxClients].map(c => ({ role: c._role, ip: c._ip }));
    const r = JSON.stringify({ type: 'gfxpeers', postes, lan: lanInfo() });
    controlClients.forEach(c => { if (c.readyState === 1) c.send(r); });
  };
  wssCtl.on('connection', ws => {
    controlClients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, port: PORT, commands: COMMANDS, lan: lanInfo() }));
    if (gfxMsg) ws.send(gfxMsg);
    gfxPeers();
    ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'state') { lastState = m.state || {}; toStations({ type: 'regie', state: lastState }); }
      else if (m.type === 'progstatus' && m.s && typeof m.s === 'object') { progStatus = m.s; toProg({ type: 'status', s: progStatus, regies: controlClients.size }); }
      else if (m.type === 'rundown' && m.r && typeof m.r === 'object') rundown = m.r;
      else if (m.type === 'enr-cmd' && /^enr-(start|stop|toggle)$/.test(m.cmd)) busfeed.cmd(m.cmd, m.arg == null ? null : clampInt(m.arg, 1, 4, 1)); } catch (e) {} });
    busfeed.hello(ws); busfeed.regieChanged();
    ws.send(JSON.stringify(streamSummary()));
    progPeers();
    ws.on('close', () => { controlClients.delete(ws); gfxPeers(); if (!controlClients.size) progStatus = null; progPeers(); busfeed.regieChanged(); });
  });
  wssGfx.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams, ip = remoteIp(req);
    // de confiance sans code : une page servie par cette régie (origine localhost:PORT) ouverte sur cet ordinateur
    const trusted = isLoopback(req) && (allowed.includes(req.headers.origin) || req.headers.origin === `http://${req.headers.host}`);
    if (!trusted) {
      // poste autonome, fichier local ou autre ordinateur : bon code exigé (et accès réseau activé pour un autre PC)
      if ((!LAN && !isLoopback(req)) || blocked(ip)) { ws.close(4403, 'bloque'); return; }
      if (q.get('k') !== PIN) { fail(ip); log(`Code d'accès refusé (poste Synthé / overlay) depuis ${isLoopback(req) ? 'cet ordinateur' : ip}`); ws.close(4401, 'code'); return; }
      fails.delete(ip);
    }
    ws._role = q.get('role') === 'synthe' ? 'synthe' : 'overlay';
    ws._ip = isLoopback(req) ? 'cet ordinateur' : ip;
    if (!isLoopback(req)) log(`${ws._role === 'synthe' ? 'Poste Synthé' : 'Overlay'} connecté depuis ${ip}`);
    gfxClients.add(ws);
    gfxPeers();
    if (ws._role === 'synthe') ws.send(JSON.stringify({ type: 'hello', regies: controlClients.size, token: TOKEN }));
    else if (gfxMsg) ws.send(gfxMsg);
    ws.on('message', d => {
      if (ws._role !== 'synthe') return;
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type !== 'gfx' || !m.state || typeof m.state !== 'object') return;
      gfxState = m.state; gfxMsg = JSON.stringify({ type: 'gfx', state: gfxState });
      controlClients.forEach(c => { if (c.readyState === 1) c.send(gfxMsg); });
      gfxClients.forEach(c => { if (c !== ws && c._role === 'overlay' && c.readyState === 1) c.send(gfxMsg); });
    });
    ws.on('close', () => { gfxClients.delete(ws); gfxPeers(); });
  });

  /* ---------- poste Programmes : reportages, clips, jingles envoyés à l'antenne ----------
     Les fichiers sont déposés depuis le poste Programmes (cet ordinateur ou un autre du réseau) et rangés
     dans <confDir>/programmes. La régie les lit directement depuis /prog/media/<id> (lecture avec avance rapide).
     Le poste envoie ses ordres sur /prog (take, stop, pause, restart) ; la régie renvoie l'état de ses programmes. */
  const PROG_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac' };
  const progDir = path.join(confDir, 'programmes');
  const progIndex = path.join(progDir, 'programmes.json');
  let progList = [];
  try { progList = JSON.parse(fs.readFileSync(progIndex, 'utf8')).filter(p => p && /^[a-z0-9]{12}$/.test(p.id) && PROG_EXT[p.ext] && fs.existsSync(path.join(progDir, p.id + '.' + p.ext))); } catch (e) {}
  let progStatus = null;
  const progClients = new Set();
  const progFile = p => path.join(progDir, p.id + '.' + p.ext);
  const progById = id => progList.find(p => p.id === id) || null;
  const progSave = () => { try { fs.mkdirSync(progDir, { recursive: true }); fs.writeFileSync(progIndex + '.tmp', JSON.stringify(progList)); fs.renameSync(progIndex + '.tmp', progIndex); } catch (e) { log('Programmes : sauvegarde impossible : ' + e.message); } };
  const toProg = o => { const m = JSON.stringify(o); progClients.forEach(c => sendJ(c, m)); };
  const progListMsg = () => ({ type: 'list', items: progList });
  function progPeers() { toProg({ type: 'peers', regies: controlClients.size, postes: progClients.size, token: TOKEN, s: progStatus });
    const m = JSON.stringify({ type: 'progpeers', postes: [...progClients].map(c => c._ip) }); controlClients.forEach(c => sendJ(c, m)); }
  const progOnAir = id => !!(progStatus && Array.isArray(progStatus.buses) && progStatus.buses.some(b => b.prog === id));
  // ordre du poste (ou d'une télécommande) → régie
  function progAction(m) {
    if (!controlClients.size) return { ok: false, error: 'régie fermée' };
    const bus = clampInt(m.bus, 1, 3, 1), fade = m.fade == null ? null : clampInt(m.fade, 0, 10000, 1000);
    let out;
    if (m.type === 'take') {
      const p = progById(m.id); if (!p) return { ok: false, error: 'programme introuvable' };
      out = { type: 'prog', action: 'take', bus, fade, startAt: Math.max(0, +m.startAt || 0),
        prog: { id: p.id, name: p.name, url: '/prog/media/' + p.id, kind: p.ext in { mp3: 1, wav: 1, m4a: 1, aac: 1 } ? 'audio' : 'video',
          endAction: p.endAction || 'back', volume: p.volume == null ? 1 : p.volume, thumb: p.thumb || null, duration: p.duration || null } };
    } else if (['stop', 'pause', 'restart', 'stopall'].includes(m.type)) out = { type: 'prog', action: m.type, bus, fade };
    else return { ok: false, error: 'ordre inconnu' };
    const j = JSON.stringify(out); controlClients.forEach(c => sendJ(c, j));
    return { ok: true, action: out.action, bus };
  }
  function progAuth(req, url) {
    if (isLoopback(req)) return true;
    const ip = remoteIp(req);
    if (!LAN || blocked(ip)) return false;
    if ((req.headers['x-scenepro-code'] || url.searchParams.get('k')) !== PIN) { fail(ip); return false; }
    return true;
  }
  function progHttp(req, res, url) {
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!progAuth(req, url)) return json(401, { ok: false, error: 'code d\'accès' });
    // lecture du fichier (avec plages d'octets : avance rapide, reprise au point d'aperçu)
    const mm = url.pathname.match(/^\/prog\/media\/([a-z0-9]{12})$/);
    if (mm) {
      const p = progById(mm[1]); if (!p) { res.writeHead(404); return res.end(); }
      const file = progFile(p);
      return fs.stat(file, (err, st) => {
        if (err) { res.writeHead(404); return res.end(); }
        const h = { 'Content-Type': PROG_EXT[p.ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        let start = 0, end = st.size - 1, code = 200;
        if (rg && (rg[1] || rg[2])) {
          if (rg[1]) { start = +rg[1]; if (rg[2]) end = Math.min(+rg[2], st.size - 1); }
          else start = Math.max(0, st.size - +rg[2]);
          if (start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
          code = 206; h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        }
        h['Content-Length'] = end - start + 1;
        res.writeHead(code, h);
        if (req.method === 'HEAD' || !st.size) return res.end();
        const rs = fs.createReadStream(file, { start, end }); rs.on('error', () => res.destroy()); rs.pipe(res);
        res.on('close', () => rs.destroy());
      });
    }
    if (url.pathname === '/api/prog/list') return json(200, { ok: true, items: progList, status: progStatus, regies: controlClients.size });
    if (url.pathname === '/api/prog/upload' && req.method === 'POST') {
      const ext = String(url.searchParams.get('ext') || '').toLowerCase();
      if (!PROG_EXT[ext]) { req.resume(); return json(415, { ok: false, error: 'format non pris en charge' }); }
      const name = String(url.searchParams.get('name') || 'Programme').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'Programme';
      const p = { id: crypto.randomBytes(6).toString('hex'), name, ext, size: 0, addedAt: Date.now(), duration: null, thumb: null, endAction: 'back', volume: 1 };
      try { fs.mkdirSync(progDir, { recursive: true }); } catch (e) {}
      const tmp = progFile(p) + '.part', ws = fs.createWriteStream(tmp);
      let failed = false;
      const abort = msg => { if (failed) return; failed = true; ws.destroy(); fs.unlink(tmp, () => {}); if (!res.headersSent) json(500, { ok: false, error: msg }); };
      req.on('aborted', () => abort('envoi interrompu'));
      req.on('data', c => { p.size += c.length; });
      ws.on('error', e => abort('écriture impossible : ' + e.message));
      ws.on('finish', () => {
        if (failed) return;
        fs.rename(tmp, progFile(p), err => {
          if (err) return abort('écriture impossible : ' + err.message);
          progList.push(p); progSave(); toProg(progListMsg());
          log(`Programme ajouté : « ${p.name} » (${Math.round(p.size / 1048576)} Mo)`);
          json(200, { ok: true, item: p });
        });
      });
      req.pipe(ws);
      return;
    }
    const im = url.pathname.match(/^\/api\/prog\/(order|([a-z0-9]{12}))$/);
    if (im && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (req.method === 'DELETE') {
        const p = progById(im[2]); if (!p) return json(404, { ok: false, error: 'introuvable' });
        if (progOnAir(p.id)) return json(409, { ok: false, error: 'programme à l\'antenne' });
        progList = progList.filter(x => x !== p); progSave(); fs.unlink(progFile(p), () => {}); toProg(progListMsg());
        return json(200, { ok: true });
      }
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        let o; try { o = JSON.parse(body); } catch (e) { return json(400, { ok: false, error: 'json' }); }
        if (im[1] === 'order') {
          if (!Array.isArray(o.ids)) return json(400, { ok: false });
          const rank = new Map(o.ids.map((id, i) => [id, i]));
          progList.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
        } else {
          const p = progById(im[2]); if (!p) return json(404, { ok: false, error: 'introuvable' });
          if (typeof o.name === 'string' && o.name.trim()) p.name = o.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
          if (['back', 'black', 'hold', 'loop'].includes(o.endAction)) p.endAction = o.endAction;
          if (o.volume != null && isFinite(+o.volume)) p.volume = Math.max(0, Math.min(1, +o.volume));
          if (o.duration != null && isFinite(+o.duration)) p.duration = +o.duration;
          if (typeof o.thumb === 'string' && o.thumb.length < 400000 && /^data:image\/(jpeg|png);base64,/.test(o.thumb)) p.thumb = o.thumb;
        }
        progSave(); toProg(progListMsg()); json(200, { ok: true });
      });
      return;
    }
    json(404, { ok: false, error: 'inconnu' });
  }
  const wssProg = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  wssProg.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams, ip = remoteIp(req);
    const trusted = isLoopback(req) && (allowed.includes(req.headers.origin) || req.headers.origin === `http://${req.headers.host}`);
    if (!trusted) {
      if ((!LAN && !isLoopback(req)) || blocked(ip)) { ws.close(4403, 'bloque'); return; }
      if (q.get('k') !== PIN) { fail(ip); log(`Code d'accès refusé (poste Programmes) depuis ${isLoopback(req) ? 'cet ordinateur' : ip}`); ws.close(4401, 'code'); return; }
      fails.delete(ip);
    }
    ws._ip = isLoopback(req) ? 'cet ordinateur' : ip;
    if (!isLoopback(req)) log(`Poste Programmes connecté depuis ${ip}`);
    progClients.add(ws);
    sendJ(ws, progListMsg());
    progPeers();
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      const r = progAction(m);
      if (!r.ok) sendJ(ws, { type: 'error', error: r.error });
    });
    ws.on('close', () => { progClients.delete(ws); progPeers(); });
  });

  /* ---------- diffusion : relais régie → postes Diffusion ----------
     La régie envoie sur /live le programme du bus WEB (WebM : {type:'init'} puis des morceaux binaires).
     Les postes Diffusion (station.js, sur cet ordinateur ou un autre du réseau) se connectent sur /feed,
     reçoivent ce flux et gèrent eux-mêmes ffmpeg, les plateformes et l'enregistrement.
     Ils renvoient leur état ({type:'status'}), relayé à la régie ({type:'stream'}). */
  let liveSender = null, feedInit = null, feedWant = null;
  const feedClients = new Set();
  const sendJ = (ws, o) => { if (ws && ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
  const toStations = o => { const m = JSON.stringify(o); feedClients.forEach(c => sendJ(c, m)); };
  let lastActive = false; // un poste diffusait ou enregistrait au dernier état connu
  function streamSummary() {
    // état du premier poste qui diffuse (ou du premier connecté)
    const list = [...feedClients].map(c => ({ ip: c._ip, s: c._status || null }));
    const main = list.find(x => x.s && ((x.s.status && x.s.status !== 'idle') || (x.s.rec && x.s.rec.status !== 'idle'))) || list.find(x => x.s) || null;
    const s = main ? main.s : {};
    const out = Object.assign({ type: 'stream', status: 'idle', health: null, kbps: 0, dests: [], uptime: 0, rec: { status: 'idle', uptime: 0, file: '' } }, s,
      { stations: list.length, postes: list.map(x => ({ ip: x.ip, poste: x.s && x.s.poste || '' })) });
    if (list.length) lastActive = out.status !== 'idle' || out.rec.status !== 'idle';
    // poste Diffusion parti pendant une diffusion : état inconnu, la régie l'affiche en orange
    else if (lastActive) { out.status = 'lost'; out.rec = { status: 'lost', uptime: 0, file: '' }; }
    return out;
  }
  function pushStream() {
    const m = JSON.stringify(streamSummary());
    sendJ(liveSender, m);
    controlClients.forEach(c => sendJ(c, m));
  }
  function stationsChanged() {
    sendJ(liveSender, { type: 'stations', n: feedClients.size, want: feedWant });
    pushStream();
  }
  wss.on('connection', ws => {
    if (liveSender) { try { liveSender.close(); } catch (e) {} }
    liveSender = ws; feedInit = null;
    toStations({ type: 'regie-status', regie: true });
    stationsChanged();
    ws.on('message', (data, isBinary) => {
      if (liveSender !== ws) return;
      if (isBinary) {
        feedClients.forEach(c => {
          if (c.readyState !== 1 || !c._ready) return;
          if (c.bufferedAmount > 48e6) { log(`Poste Diffusion ${c._ip} trop lent : reconnexion.`); c._ready = false; c.terminate(); return; }
          c.send(data);
        });
        return;
      }
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m.type === 'init') { feedInit = JSON.stringify(m); feedClients.forEach(c => { c._ready = true; sendJ(c, feedInit); }); }
      else if (m.type === 'cmd' && /^(stream|rec)-(start|stop|toggle)$/.test(m.cmd)) toStations({ type: 'cmd', cmd: m.cmd });
    });
    ws.on('close', () => {
      if (liveSender !== ws) return;
      liveSender = null; feedInit = null;
      feedClients.forEach(c => { c._ready = false; });
      toStations({ type: 'regie-status', regie: false });
    });
  });
  wssFeed.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams, ip = remoteIp(req);
    if (!isLoopback(req)) {
      if (!LAN || blocked(ip)) { ws.close(4403, 'bloque'); return; }
      if (q.get('k') !== PIN) { fail(ip); log(`Code d'accès refusé (poste Diffusion) depuis ${ip}`); ws.close(4401, 'code'); return; }
      fails.delete(ip);
    }
    ws._ip = isLoopback(req) ? 'cet ordinateur' : ip; ws._ready = false; ws._status = null;
    feedClients.add(ws);
    log(`Poste Diffusion connecté (${ws._ip})`);
    sendJ(ws, { type: 'hello', regie: !!liveSender });
    sendJ(ws, { type: 'regie', state: lastState });
    // la régie relance son encodeur pour que ce poste reçoive un en-tête complet
    sendJ(liveSender, { type: 'feed-restart' });
    stationsChanged();
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type === 'status' && m.s && typeof m.s === 'object') { ws._status = m.s; pushStream(); }
      else if (m.type === 'want') { feedWant = { res: ['480', '720', '1080'].includes(m.res) ? m.res : '720', fps: clampInt(m.fps, 15, 60, 30) }; sendJ(liveSender, { type: 'want', ...feedWant }); }
      else if (m.type === 'route') sendJ(liveSender, { type: 'route', bus: clampInt(m.bus, 1, 3, 1) });
      else if (m.type === 'resync') { log(`Poste Diffusion ${ws._ip} : aucune image reçue, relance de l'envoi de la régie`); sendJ(liveSender, { type: 'feed-restart' }); }
    });
    ws.on('close', () => { feedClients.delete(ws); log(`Poste Diffusion déconnecté (${ws._ip})`); stationsChanged(); });
  });

  let announcer = null;
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = () => {
      server.once('error', e => {
        if (e.code === 'EADDRINUSE' && opts.portFallback !== false && tries < 20) { tries++; PORT++; tryListen(); }
        else reject(e);
      });
      server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
        allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
        log(`ScènePro ${VERSION} — régie sur http://localhost:${PORT}/`);
        if (LAN) lanIps().forEach(a => log(`Poste Synthé depuis un autre ordinateur : http://${a.ip}:${PORT}/synthe  (code d'accès ${PIN})`));
        if (LAN) lanIps().forEach(a => log(`Poste Diffusion : adresse ${a.ip}, port ${PORT}, code d'accès ${PIN}`));
        // annonce sur le réseau : les postes trouvent la régie tout seuls (le code n'est jamais diffusé)
        if (LAN) announcer = discovery.announce(() => ({ port: PORT, ips: lanIps().map(a => a.ip), version: VERSION }));
        resolve({
          port: PORT, url: `http://localhost:${PORT}/`,
          close() {
            wss.clients.forEach(c => c.terminate()); wssCtl.clients.forEach(c => c.terminate()); wssGfx.clients.forEach(c => c.terminate()); wssFeed.clients.forEach(c => c.terminate()); wssProg.clients.forEach(c => c.terminate()); busfeed.close(); if (announcer) announcer.close();
            return new Promise(r => server.close(() => r()));
          },
        });
      });
    };
    tryListen();
  });
}

module.exports = { startServer, VERSION };

/* ---------- utilisation seule (sans l'application) : node server.js ---------- */
if (require.main === module) {
  const NO_BROWSER = process.argv.includes('--no-browser');
  startServer({ portFallback: false }).then(({ port }) => {
    console.log('  Gardez cette fenêtre ouverte pendant le show.');
    if (NO_BROWSER || process.platform !== 'win32') return;
    const profile = path.join(process.env.LOCALAPPDATA || __dirname, 'ScenePro', 'profil');
    const args = [
      `--app=http://localhost:${port}/`, `--user-data-dir=${profile}`, '--start-maximized', '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=IntensiveWakeUpThrottling,BackgroundVideoTrackOptimization',
    ];
    spawn('cmd', ['/c', 'start', '""', 'msedge', ...args.map(a => `"${a}"`)], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }).catch(e => {
    if (e.code === 'EADDRINUSE') { console.log('ScènePro tourne déjà (port 7350).'); process.exit(0); }
    console.error(e); process.exit(1);
  });
}

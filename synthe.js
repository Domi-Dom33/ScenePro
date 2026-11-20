/* ============================================================
   ScènePro Synthé — poste habillage autonome
   - petit serveur local (http://localhost:7370) : le poste s'ouvre et se prépare
     même si la régie est éteinte ; le conducteur est enregistré dans un fichier
   - le poste se connecte ensuite à la régie (ws://IP:7350/gfx, code d'accès)
   Utilisé par l'application (ScènePro.exe --synthe) ou seul : `node synthe.js`
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function log(s) { console.log(new Date().toLocaleTimeString('fr-FR') + '  [Synthé] ' + s); }

/* codes d'accès des régies installées sur cet ordinateur (application ou mode .bat) :
   le poste les connaît d'office quand la régie est sur le même PC */
function localCodes() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'ScènePro'), path.join(process.env.APPDATA, 'scenepro'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'ScenePro'));
  const out = [];
  for (const d of dirs) { try { const c = fs.readFileSync(path.join(d, 'acces-reseau.txt'), 'utf8').trim(); if (/^\d{6}$/.test(c) && !out.includes(c)) out.push(c); } catch (e) {} }
  return out;
}

/**
 * Démarre le serveur du poste Synthé. Options : port (7370), root (dossier des fichiers), confDir (conducteur).
 * Renvoie une promesse { port, url, close() }.
 */
function startSyntheServer(opts = {}) {
  const root = opts.root || __dirname;
  const confDir = opts.confDir || path.join(process.env.LOCALAPPDATA || root, 'ScenePro-Synthe');
  const file = path.join(confDir, 'conducteur.json');
  let PORT = opts.port || 7370;
  const FILES = { '/': ['Synthe.html', 'text/html'], '/synthe': ['Synthe.html', 'text/html'], '/Synthe.html': ['Synthe.html', 'text/html'],
    '/gfx-render.js': ['gfx-render.js', 'text/javascript'] };

  // détection automatique des régies qui s'annoncent sur le réseau (UDP 7399)
  let disc = null;
  try { disc = require('./discovery').listen(() => {}); } catch (e) { log('détection des régies indisponible : ' + e.message); }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // anti « DNS rebinding » : uniquement les pages ouvertes sur localhost
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
    if (url.pathname === '/api/regies') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      // disc.list() : liste à jour (les régies disparues depuis plus de 7 s en sont retirées)
      const list = disc ? disc.list().sort((a, b) => (b.local - a.local) || String(a.name).localeCompare(b.name)) : [];
      return res.end(JSON.stringify({ ok: true, regies: list, detection: !!disc }));
    }
    if (url.pathname === '/api/test') {
      // « Tester l'adresse » : interroge /api/hello de la régie et explique précisément ce qui ne va pas
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const host = String(url.searchParams.get('host') || '').trim(), port = parseInt(url.searchParams.get('port'), 10);
      if (!/^[a-zA-Z0-9.\-]{1,253}$/.test(host)) { res.writeHead(200); return res.end(JSON.stringify({ ok: false, why: 'adresse', msg: 'Adresse IP invalide.' })); }
      if (!(port > 0 && port < 65536)) { res.writeHead(200); return res.end(JSON.stringify({ ok: false, why: 'port', msg: 'Port invalide (1 à 65535, 7350 par défaut).' })); }
      let done = false;
      const reply = o => { if (done) return; done = true; res.writeHead(200); res.end(JSON.stringify(o)); };
      const rq = http.get({ host, port, path: '/api/hello', timeout: 2500 }, r => {
        let b = ''; r.on('data', d => { if (b.length < 8192) b += d; });
        r.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch (e) {}
          if (!j || j.app !== 'ScenePro' || j.role !== 'regie') return reply({ ok: false, why: 'pas-scenepro', msg: `Un autre logiciel répond sur ${host}:${port} : ce n'est pas une régie ScènePro (vérifiez le port).` });
          reply({ ok: true, name: j.name, port: j.port, version: j.version, lan: j.lan, regieOuverte: !!j.regieOuverte });
        });
      });
      rq.on('timeout', () => { rq.destroy(); reply({ ok: false, why: 'injoignable', msg: `Aucune réponse de ${host} : adresse IP fausse, ordinateur éteint, autre réseau ou pare-feu.` }); });
      rq.on('error', e => {
        if (e.code === 'ECONNREFUSED') reply({ ok: false, why: 'refus', msg: `L'ordinateur ${host} répond, mais rien n'écoute sur le port ${port} : régie ScènePro fermée ou mauvais port.` });
        else if (e.code === 'ENOTFOUND') reply({ ok: false, why: 'adresse', msg: `Nom d'ordinateur « ${host} » introuvable.` });
        else reply({ ok: false, why: 'injoignable', msg: `Aucune réponse de ${host} (${e.code || e.message}) : adresse IP fausse, autre réseau ou pare-feu.` });
      });
      return;
    }
    if (url.pathname === '/api/conducteur') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') {
        fs.readFile(file, 'utf8', (err, txt) => { res.writeHead(200); res.end(err ? 'null' : txt); });
        return;
      }
      if (req.method === 'PUT') {
        // même origine uniquement (pas d'écriture depuis un autre site)
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); return res.end('{"ok":false}'); }
        const chunks = []; let size = 0;
        req.on('data', c => { size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); else chunks.push(c); });
        req.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          try { JSON.parse(txt); } catch (e) { res.writeHead(400); return res.end('{"ok":false}'); }
          try { fs.mkdirSync(confDir, { recursive: true }); fs.writeFileSync(file + '.tmp', txt); fs.renameSync(file + '.tmp', file); res.writeHead(200); res.end('{"ok":true}'); }
          catch (e) { res.writeHead(500); res.end('{"ok":false}'); }
        });
        return;
      }
      res.writeHead(405); return res.end();
    }
    if (url.pathname === '/api/local-codes') {
      // lisible seulement par la page du poste (pas d'en-tête CORS : un autre site ne peut pas lire la réponse)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, codes: localCodes(), autonome: true }));
    }
    const f = FILES[url.pathname];
    if (!f) { res.writeHead(404); return res.end('404'); }
    fs.readFile(path.join(root, f[0]), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(f[0] + ' introuvable'); }
      res.writeHead(200, { 'Content-Type': f[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = () => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && opts.portFallback !== false && tries < 20) { tries++; PORT++; tryListen(); } else reject(e); });
      server.listen(PORT, '127.0.0.1', () => {
        log(`poste Synthé sur http://localhost:${PORT}/`);
        resolve({ port: PORT, url: `http://localhost:${PORT}/`, close: () => { if (disc) disc.close(); return new Promise(r => server.close(() => r())); } });
      });
    };
    tryListen();
  });
}

/* ---------- application de bureau : ScènePro.exe --synthe ---------- */
function runElectron() {
  const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
  // dossier séparé : la régie et le poste Synthé peuvent tourner en même temps sur le même PC
  app.setPath('userData', app.getPath('userData') + '-synthe');
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let win = null, srv = null;
  // logo propre au poste Synthé (repli sur le logo de la régie s'il manque)
  const own = path.join(__dirname, 'build', 'icons', 'synthe.png');
  const ICON = fs.existsSync(own) ? own : path.join(__dirname, 'build', 'icon.png');
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    try { srv = await startSyntheServer({ root: __dirname, confDir: app.getPath('userData') }); }
    catch (e) { dialog.showErrorBox('ScènePro Synthé', 'Impossible de démarrer le poste Synthé : ' + e.message); app.quit(); return; }
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({ width: 1500, height: 920, minWidth: 1000, minHeight: 640, backgroundColor: '#0a0c0f', title: 'ScènePro Synthé', icon: ICON, show: false,
      autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false } });
    win.once('ready-to-show', () => { win.maximize(); win.show(); });
    const local = u => { try { return new URL(u).origin === new URL(srv.url).origin; } catch (e) { return false; } };
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!local(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
    win.on('closed', () => { win = null; });
    win.loadURL(srv.url);
  });
  app.on('window-all-closed', async () => { if (srv) { try { await srv.close(); } catch (e) {} } app.quit(); });
}

module.exports = { startSyntheServer, runElectron };

/* ---------- utilisation seule : node synthe.js ---------- */
if (require.main === module) {
  startSyntheServer({}).then(({ url }) => {
    console.log('  Gardez cette fenêtre ouverte pendant le show.');
    if (process.argv.includes('--no-browser') || process.platform !== 'win32') return;
    const profile = path.join(process.env.LOCALAPPDATA || __dirname, 'ScenePro-Synthe', 'profil');
    spawn('cmd', ['/c', 'start', '""', 'msedge', `"--app=${url}"`, `"--user-data-dir=${profile}"`, '"--start-maximized"', '"--no-first-run"'],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }).catch(e => { console.error(e); process.exit(1); });
}

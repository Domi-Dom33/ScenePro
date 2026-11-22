/* ============================================================
   ScènePro — application de bureau (Electron)
   Démarre le serveur local intégré, ouvre la régie dans sa propre fenêtre,
   gère les fenêtres de sortie, les autorisations et les mises à jour (GitHub).
   ============================================================ */
'use strict';
const { app, BrowserWindow, session, shell, dialog, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const IS_MAC = process.platform === 'darwin';
const ROLE = process.argv.includes('--diffusion') ? 'diffusion' : process.argv.includes('--synthe') ? 'synthe' : process.argv.includes('--enregistreur') ? 'enregistreur' : 'regie';

// ouvre un autre poste (nouvelle instance de l'application avec son rôle) — sur Mac il n'y a pas de raccourcis dédiés
function launchRole(flag) {
  try { spawn(process.execPath, app.isPackaged ? [flag] : [app.getAppPath(), flag], { detached: true, stdio: 'ignore' }).unref(); }
  catch (e) { dialog.showErrorBox('ScènePro', "Impossible d'ouvrir ce poste : " + e.message); }
}
// Mac : une barre de menus est indispensable (Cmd+Q, copier/coller des clés de stream…). Appliquée à chaque fenêtre de chaque poste.
function macMenu() {
  const poste = r => ({ label: { synthe: 'Poste Synthé', diffusion: 'Poste Diffusion', enregistreur: 'Poste Enregistrement' }[r], enabled: ROLE !== r, click: () => launchRole('--' + r) });
  return Menu.buildFromTemplate([
    { label: 'ScènePro', submenu: [{ role: 'about', label: 'À propos de ScènePro' }, { type: 'separator' }, { role: 'hide', label: 'Masquer ScènePro' }, { role: 'hideOthers', label: 'Masquer les autres' }, { role: 'unhide', label: 'Tout afficher' }, { type: 'separator' }, { role: 'quit', label: 'Quitter ScènePro' }] },
    { label: 'Édition', submenu: [{ role: 'undo', label: 'Annuler' }, { role: 'redo', label: 'Rétablir' }, { type: 'separator' }, { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' }, { role: 'selectAll', label: 'Tout sélectionner' }] },
    { label: 'Postes', submenu: [poste('synthe'), poste('diffusion'), poste('enregistreur'), { type: 'separator' }, { label: 'Ouvrir la régie', enabled: ROLE !== 'regie', click: () => launchRole('--regie') }] },
    { label: 'Fenêtre', submenu: [{ role: 'minimize', label: 'Réduire' }, { role: 'togglefullscreen', label: 'Plein écran' }, { role: 'zoom', label: 'Agrandir' }, { type: 'separator' }, { role: 'front', label: 'Tout ramener au premier plan' }] },
  ]);
}
if (IS_MAC) app.on('browser-window-created', () => setImmediate(() => Menu.setApplicationMenu(macMenu())));
const { startServer } = require('./server');

// lecture automatique avec le son, et pas de ralentissement quand la régie est en arrière-plan
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling,BackgroundVideoTrackOptimization');

// autres rôles de la même application (données et verrou d'instance séparés, chacun fonctionne seul) :
//   ScènePro.exe --diffusion → poste Diffusion (station.js)   ·   ScènePro.exe --synthe → poste Synthé (synthe.js)
if (process.argv.includes('--diffusion')) { require('./station').runElectron(); return; }
if (process.argv.includes('--synthe')) { require('./synthe').runElectron(); return; }
//   ScènePro.exe --enregistreur → poste Enregistrement des bus (recorder.js)
if (process.argv.includes('--enregistreur')) { require('./recorder').runElectron(); return; }

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null, srv = null, quitting = false;
const ICON = path.join(__dirname, 'build', 'icon.png');

const ALLOWED_PERMISSIONS = new Set([
  'media', 'mediaKeySystem', 'window-management', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read',
  'speaker-selection', 'notifications', 'pointerLock', 'keyboardLock', 'fileSystem',
]);

function isLocal(url) {
  try { const u = new URL(url); return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && +u.port === srv.port; }
  catch (e) { return url === 'about:blank' || url === ''; }
}

function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(ALLOWED_PERMISSIONS.has(permission) && isLocal(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && isLocal(origin || (wc && wc.getURL()) || ''));
  ses.setDevicePermissionHandler(() => true);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0a0c0f', title: 'ScènePro', icon: ICON, show: false,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(IS_MAC ? macMenu() : null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });

  // fenêtres de sortie (window.open('') depuis la régie) : autorisées, sans menu, fond noir
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === '' || url === 'about:blank' || isLocal(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: '#000000', autoHideMenuBar: true, icon: ICON, title: 'ScènePro — Sortie',
          webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    shell.openExternal(url); // liens externes (aide des plateformes…) dans le navigateur
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', child => {
    child.setMenu(null);
    child.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') { child.setFullScreen(!child.isFullScreen()); e.preventDefault(); }
    });
  });
  // pas de navigation hors de la régie
  win.webContents.on('will-navigate', (e, url) => { if (!isLocal(url)) { e.preventDefault(); shell.openExternal(url); } });

  // la régie demande confirmation quand un programme est à l'antenne
  win.webContents.on('will-prevent-unload', e => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Quitter quand même', 'Annuler'], defaultId: 1, cancelId: 1,
      title: 'ScènePro', message: 'Un programme est à l\'antenne ou une diffusion est en cours.',
      detail: 'Quitter coupera les sorties vidéo et la diffusion en ligne.',
    });
    if (r === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });

  win.loadURL(srv.url);
}

function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  if (IS_MAC) {
    // Mac : sans certificat Apple, l'installation automatique est impossible → on prévient et on ouvre la page de téléchargement
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', info => {
      if (!win) return;
      dialog.showMessageBox(win, { type: 'info', buttons: ['Télécharger', 'Plus tard'], defaultId: 0, cancelId: 1, title: 'Mise à jour de ScènePro',
        message: `La version ${info.version} est disponible.`, detail: "Téléchargez le fichier .dmg correspondant à votre Mac et remplacez l'application. Ne le faites pas pendant un show." })
        .then(r => { if (r.response === 0) shell.openExternal('https://github.com/Domi-Dom33/ScenePro/releases/latest'); });
    });
    autoUpdater.on('error', () => {});
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => {
    if (!win) return;
    dialog.showMessageBox(win, {
      type: 'info', buttons: ['Redémarrer maintenant', 'Plus tard'], defaultId: 1, cancelId: 1,
      title: 'Mise à jour de ScènePro', message: `La version ${info.version} est prête.`,
      detail: 'Elle sera installée au redémarrage. Ne redémarrez pas pendant un show.',
    }).then(r => { if (r.response === 0) { quitting = true; autoUpdater.quitAndInstall(); } });
  });
  autoUpdater.on('error', () => {}); // pas de connexion : on réessaiera au prochain lancement
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  try {
    srv = await startServer({ port: 7350, root: __dirname, confDir: app.getPath('userData'), app: true });
  } catch (e) {
    dialog.showErrorBox('ScènePro', 'Impossible de démarrer le serveur interne : ' + e.message);
    app.quit(); return;
  }
  setupPermissions();
  createWindow();
  setupUpdates();
});

app.on('window-all-closed', async () => {
  if (srv) { try { await srv.close(); } catch (e) {} }
  app.quit();
});
app.on('before-quit', () => { quitting = true; });

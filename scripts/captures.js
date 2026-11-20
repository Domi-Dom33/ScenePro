/* ============================================================
   ScènePro — captures d'écran de présentation (docs/captures/*.png)
   Prérequis : régie (node server.js --no-browser), poste Enregistrement (node recorder.js --no-browser)
   et poste Diffusion (node station.js --no-browser) lancés sur cet ordinateur.
   Lancement : node_modules\electron\dist\electron.exe scripts\captures.js
   ============================================================ */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const OUT = path.join(__dirname, '..', 'docs', 'captures');
const W = 1920, H = 1080;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// nom de la session Windows, lu à l'exécution, pour le masquer sur les captures
const SESSION_USER = require('os').userInfo().username;

function open(url) {
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, backgroundColor: '#0a0c0f',
    webPreferences: { backgroundThrottling: false, offscreen: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false } }));
  return win.loadURL(url).then(() => win);
}
async function shot(win, name) {
  // le nom de session Windows n'apparaît pas sur les captures publiées (masque maintenu pendant les rafraîchissements)
  await win.webContents.executeJavaScript(`(() => { const u = ${JSON.stringify(SESSION_USER)}; const fix = () => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.nodeValue.includes(u)) n.nodeValue = n.nodeValue.split(u).join('…'); document.querySelectorAll('input').forEach(i => { if (i.value.includes(u)) i.value = i.value.split(u).join('…'); }); }; fix(); if (!window.__mask) { window.__mask = new MutationObserver(fix); window.__mask.observe(document.body, {subtree: true, childList: true, characterData: true}); } })()`, true);
  await sleep(400);
  const left = await win.webContents.executeJavaScript(`(() => { const u = ${JSON.stringify(SESSION_USER)}; let c = 0; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.nodeValue.includes(u)) { c++; n.nodeValue = n.nodeValue.split(u).join('…'); } return c; })()`, true);
  if (left) console.log('  (masqué juste avant la capture :', left, 'texte(s))');
  await sleep(2600); // la fenêtre cachée repeint avec ~2 s de retard
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  console.log('capture :', name + '.png', img.getSize().width + '×' + img.getSize().height);
}
const js = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);

// contenu de démonstration créé dans la page de la régie
const DEMO = `
  const slide = (title, sub, c1, c2, lines) => new Promise(r => {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 1920, 1080); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = 'rgba(255,255,255,.08)'; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(1500 + i * 40, 200 + i * 120, 260 - i * 30, 0, 7); g.fill(); }
    g.fillStyle = '#fff'; g.font = '700 110px Segoe UI'; g.fillText(title, 140, 470);
    g.font = '400 54px Segoe UI'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText(sub, 144, 560);
    (lines || []).forEach((l, i) => { g.font = '500 46px Segoe UI'; g.fillText('•  ' + l, 160, 680 + i * 70); });
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '600 34px Segoe UI'; g.fillText('CONFÉRENCE ANNUELLE 2026', 140, 160);
    c.toBlob(b => r(new File([b], title + '.png', {type: 'image/png'})));
  });
  const plateau = () => new Promise(r => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d');
    const s = c.captureStream(30); const ac = new AudioContext(); const o = ac.createOscillator(); const gn = ac.createGain(); gn.gain.value = .05; const d = ac.createMediaStreamDestination(); o.connect(gn); gn.connect(d); o.start(); s.addTrack(d.stream.getAudioTracks()[0]);
    const rec = new MediaRecorder(s, {mimeType: 'video/webm'}); const ch = []; rec.ondataavailable = e => ch.push(e.data); rec.onstop = () => r(new File(ch, 'Plateau caméra 1.webm', {type: 'video/webm'}));
    const t0 = performance.now();
    const tick = () => { const t = (performance.now() - t0) / 1000;
      const gr = g.createLinearGradient(0, 0, 0, 720); gr.addColorStop(0, '#2b3442'); gr.addColorStop(1, '#141820'); g.fillStyle = gr; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#3a2a1f'; g.fillRect(0, 470, 1280, 250);  // estrade
      g.fillStyle = '#1d3557'; g.fillRect(140, 120, 520, 300); g.fillStyle = '#e9f1f7'; g.font = '700 40px Segoe UI'; g.fillText('CONFÉRENCE 2026', 190, 285);  // écran du fond
      g.fillStyle = '#5b4636'; g.fillRect(780, 380, 260, 200);  // pupitre
      const x = 900 + Math.sin(t * .8) * 30;  // orateur
      g.fillStyle = '#e8c8a8'; g.beginPath(); g.arc(x, 250, 46, 0, 7); g.fill();
      g.fillStyle = '#23395b'; g.beginPath(); g.moveTo(x - 80, 470); g.quadraticCurveTo(x, 280, x + 80, 470); g.fill();
      g.fillStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(900, 0); g.lineTo(700, 720); g.lineTo(1150, 720); g.fill();  // projecteur
      if (t < 14) setTimeout(tick, 33); else rec.stop(); };
    rec.start(); tick();
  });
  const files = [await slide('Bienvenue', 'Ouverture par la direction', '#7a1f2b', '#2a0d14'), await slide('Programme', 'De 9 h à 17 h', '#1f4f7a', '#0b1b2e', ['Ouverture et bilan', 'Table ronde', 'Reportage terrain', 'Questions de la salle']),
    await slide('Table ronde', 'Innovation et territoires', '#2b6a3f', '#0c2214'), await slide('Merci', 'Rendez-vous en 2027', '#5b3a8a', '#1b1029'), await plateau()];
  addEntries(files.map(f => ({file: f})));
  await new Promise(r => setTimeout(r, 1500));
  const it = n => state.items.find(i => i.name === n);
  const now = Date.now(), hm = off => { const t = new Date(now + off * 60000); return [t.getHours(), t.getMinutes(), 0].map(n => String(n).padStart(2, '0')).join(':'); };
  const P = it('Plateau caméra 1'); P.loop = true; P.plannedDur = 900; P.plannedAt = hm(0); P.name = 'Plateau caméra 1';
  it('Bienvenue').imageDuration = 0; it('Bienvenue').plannedDur = 120; it('Bienvenue').plannedAt = hm(-2);
  it('Programme').plannedDur = 180; it('Programme').plannedAt = hm(14);
  it('Table ronde').plannedDur = 1800; it('Table ronde').plannedAt = hm(16);
  it('Merci').plannedDur = 60; it('Merci').plannedAt = hm(50);
  state.showName = 'Conférence annuelle 2026';
  // PGM 1 : le plateau (caméra) avec la diapositive en PIP ; PGM 2 : programme de la journée ; PGM 3 : retour présentateur
  cuePreview(P.id); selectBus(0); Engine.take(0);
  const b0 = Engine.buses[0]; b0.pip = {on: true, itemId: it('Programme').id, pos: 'tr', size: 0.3, border: true}; b0.applyPip(0);
  selectBus(1); cuePreview(it('Programme').id); Engine.take(0);
  setFollow(2, true);
  selectBus(0); cuePreview(it('Table ronde').id);
  render();
`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 1. poste Synthé : un bandeau nom-titre à l'antenne (sur PGM 1 et WEB)
  const syn = await open('http://localhost:7350/synthe');
  await sleep(2500);
  // 2. régie avec le contenu de démonstration
  const reg = await open('http://localhost:7350/');
  await sleep(2000);
  await js(reg, DEMO);
  await sleep(1500);
  await js(syn, `const b = [...document.querySelectorAll('button')].find(x => /ENVOYER/i.test(x.textContent)); if (b) b.click(); return !!b;`);
  await sleep(3500);
  await shot(syn, '03-synthe');
  await shot(reg, '01-regie');
  console.log('mixage :', await js(reg, `setLowerTab('mix'); renderMixer(true); return $('#mixer').style.display + ' / ' + document.querySelectorAll('#strips .strip').length + ' tranches';`)); await sleep(2500);
  await shot(reg, '02-regie-mixage');
  await js(reg, `setLowerTab('bin');`);
  // 3. conducteur (page web)
  const cd = await open('http://localhost:7350/conducteur'); await sleep(3000);
  await shot(cd, '06-conducteur');
  // 4. poste Enregistrement : PGM 1 et PGM 2 enregistrés
  const enr = await open('http://localhost:7380/'); await sleep(2500);
  await js(enr, `send({type:'cfg', cfg:{folder:'D:/ScenePro/docs/demo-enr', prefix:'Conference-2026'}});`); await sleep(1000);
  await js(enr, `send({type:'rec', source:'pgm1', on:true}); send({type:'rec', source:'pgm2', on:true});`);
  for (let i = 0; i < 30; i++) { await sleep(1000); const ok = await js(enr, `return !!(st && st.sources.pgm1.thumbAt && st.sources.pgm2.thumbAt);`); if (ok && i > 6) break; }
  await sleep(1500);
  await shot(enr, '05-enregistrement');
  await js(enr, `send({type:'recAll', on:false}); send({type:'rec', source:'pgm1', on:false}); send({type:'rec', source:'pgm2', on:false});`);
  // 5. poste Diffusion
  const dif = await open('http://localhost:7360/'); await sleep(6000);
  await shot(dif, '04-diffusion');
  // (pas de capture du poste Programmes : sa bibliothèque contient les fichiers de l'utilisateur)
  await sleep(1500);
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });

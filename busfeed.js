/* ============================================================
   ScènePro — relais des flux de bus pour le poste Enregistrement
   La régie compose l'image de chaque bus demandé (PGM 1, PGM 2, PGM 3, WEB) et l'envoie
   sur /bus-src?source=X (WebM : {type:'init'} puis des morceaux binaires).
   Le poste Enregistrement (recorder.js, sur cet ordinateur ou un autre du réseau) se connecte :
     - /rec?role=ctl            : état du poste, commandes (enr-start / enr-stop / enr-toggle)
     - /rec?source=X&res=&fps=  : réception du flux d'un bus (une connexion par bus enregistré)
   La régie ne compose un bus que tant qu'au moins un poste le demande.
   ============================================================ */
'use strict';
const { WebSocketServer } = require('ws');

const SOURCES = ['pgm1', 'pgm2', 'pgm3', 'web'];
const RES = ['480', '720', '1080'];

module.exports = function createBusFeed(ctx) {
  // ctx : { log, isLoopback(req), remoteIp(req), allowedOrigin(origin), lan(), pin(), blocked(ip), fail(ip), clearFail(ip), controlClients }
  const wssSrc = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const wssRec = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const src = {};           // source -> { sender, init }
  const dataClients = new Set();
  const ctlClients = new Set();
  const sendJ = (ws, o) => { if (ws && ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
  const toRegie = o => { const m = JSON.stringify(o); ctx.controlClients.forEach(c => sendJ(c, m)); };

  // ce que la régie doit composer : { pgm1: {res, fps} | null, ... }
  function want() {
    const w = {};
    SOURCES.forEach(s => w[s] = null);
    dataClients.forEach(c => { if (!w[c._source] || +c._res > +w[c._source].res) w[c._source] = { res: c._res, fps: c._fps }; });
    return w;
  }
  const pushWant = () => toRegie({ type: 'busfeed', want: want() });

  function summary() {
    return { type: 'recorder', postes: [...ctlClients].map(c => ({ ip: c._ip, s: c._status || null })), regieSources: Object.keys(src).filter(s => src[s] && src[s].sender) };
  }
  const pushSummary = () => toRegie(summary());

  function handles(p) { return p === '/bus-src' || p === '/rec'; }

  function upgrade(req, socket, head, p) {
    if (p === '/bus-src') {
      // seule la régie de cet ordinateur fournit les flux
      if (!ctx.isLoopback(req) || !ctx.allowedOrigin(req.headers.origin)) { socket.destroy(); return; }
      wssSrc.handleUpgrade(req, socket, head, ws => wssSrc.emit('connection', ws, req));
      return;
    }
    // poste Enregistrement : application (pas une page web) ; code vérifié à la connexion si autre ordinateur
    if (req.headers.origin && !ctx.allowedOrigin(req.headers.origin)) { socket.destroy(); return; }
    wssRec.handleUpgrade(req, socket, head, ws => wssRec.emit('connection', ws, req));
  }

  wssSrc.on('connection', (ws, req) => {
    const source = new URL(req.url, 'http://x').searchParams.get('source');
    if (!SOURCES.includes(source)) { ws.close(4400, 'source'); return; }
    const old = src[source];
    if (old && old.sender) { try { old.sender.close(); } catch (e) {} }
    src[source] = { sender: ws, init: null };
    pushSummary();
    ws.on('message', (data, isBinary) => {
      const s = src[source]; if (!s || s.sender !== ws) return;
      if (isBinary) {
        dataClients.forEach(c => {
          if (c._source !== source || !c._ready || c.readyState !== 1) return;
          if (c.bufferedAmount > 48e6) { ctx.log(`Poste Enregistrement ${c._ip} trop lent (${source}) : reconnexion.`); c._ready = false; c.terminate(); return; }
          c.send(data);
        });
        return;
      }
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m.type === 'init') {
        s.init = JSON.stringify(Object.assign({}, m, { source }));
        dataClients.forEach(c => { if (c._source === source) { c._ready = true; sendJ(c, s.init); } });
      }
    });
    ws.on('close', () => {
      const s = src[source]; if (!s || s.sender !== ws) return;
      src[source] = null;
      dataClients.forEach(c => { if (c._source === source) { c._ready = false; sendJ(c, { type: 'source-lost', source }); } });
      pushSummary();
    });
  });

  wssRec.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams, ip = ctx.remoteIp(req);
    if (!ctx.isLoopback(req)) {
      if (!ctx.lan() || ctx.blocked(ip)) { ws.close(4403, 'bloque'); return; }
      if (q.get('k') !== ctx.pin()) { ctx.fail(ip); ctx.log(`Code d'accès refusé (poste Enregistrement) depuis ${ip}`); ws.close(4401, 'code'); return; }
      ctx.clearFail(ip);
    }
    ws._ip = ctx.isLoopback(req) ? 'cet ordinateur' : ip;
    if (q.get('role') === 'ctl') {
      ws._status = null;
      ctlClients.add(ws);
      ctx.log(`Poste Enregistrement connecté (${ws._ip})`);
      sendJ(ws, { type: 'hello', regie: ctx.controlClients.size > 0, sources: SOURCES });
      pushSummary();
      ws.on('message', d => {
        let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
        if (m.type === 'status' && m.s && typeof m.s === 'object') { ws._status = m.s; pushSummary(); }
      });
      ws.on('close', () => { ctlClients.delete(ws); ctx.log(`Poste Enregistrement déconnecté (${ws._ip})`); pushSummary(); });
      return;
    }
    const source = q.get('source');
    if (!SOURCES.includes(source)) { ws.close(4400, 'source'); return; }
    ws._source = source; ws._ready = false;
    ws._res = RES.includes(q.get('res')) ? q.get('res') : '1080';
    ws._fps = Math.max(15, Math.min(60, parseInt(q.get('fps'), 10) || 30));
    dataClients.add(ws);
    sendJ(ws, { type: 'hello', regie: ctx.controlClients.size > 0, source });
    pushWant();
    // la régie relance l'encodeur de ce bus pour que ce poste reçoive un en-tête complet
    if (src[source] && src[source].sender) toRegie({ type: 'busfeed-restart', source });
    ws.on('close', () => { dataClients.delete(ws); pushWant(); });
  });

  return {
    handles, upgrade,
    // à l'ouverture d'une connexion /control (la régie) : ce qu'elle doit composer + état des postes
    hello(ws) { sendJ(ws, { type: 'busfeed', want: want() }); sendJ(ws, summary()); },
    // commandes enr-* (Stream Deck, boutons REC de la régie) : relayées aux postes Enregistrement
    cmd(cmd, arg) { const m = JSON.stringify({ type: 'cmd', cmd, arg: arg == null ? null : arg }); ctlClients.forEach(c => sendJ(c, m)); return ctlClients.size; },
    regieChanged() { const on = ctx.controlClients.size > 0; ctlClients.forEach(c => sendJ(c, { type: 'regie-status', regie: on })); dataClients.forEach(c => sendJ(c, { type: 'regie-status', regie: on })); },
    postes() { return ctlClients.size; },
    close() { wssSrc.clients.forEach(c => c.terminate()); wssRec.clients.forEach(c => c.terminate()); },
  };
};
module.exports.SOURCES = SOURCES;

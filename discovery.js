/* ============================================================
   ScènePro — détection automatique des régies sur le réseau local
   - la régie s'annonce toutes les 2 s (UDP, port 7399) : { app:'ScenePro', role:'regie', name, port, ips, version }
   - les postes (Synthé, Diffusion, Enregistrement…) écoutent et affichent la liste des régies trouvées
   Le code d'accès n'est jamais diffusé : il reste à saisir (sauf sur le même ordinateur, où il n'est pas demandé).
   ============================================================ */
'use strict';
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 7399;

function broadcastAddrs() {
  const out = new Set(['255.255.255.255', '127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
    out.add(ip.map((b, i) => (b & m[i]) | (~m[i] & 255)).join('.'));
  }
  return [...out];
}

/** Côté régie : s'annonce sur le réseau. getInfo() → { port, name, ips, version } */
function announce(getInfo) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null, closed = false;
  s.on('error', () => {});
  const tick = () => {
    if (closed) return;
    let msg;
    try { msg = Buffer.from(JSON.stringify(Object.assign({ app: 'ScenePro', role: 'regie', name: os.hostname() }, getInfo()))); } catch (e) { return; }
    broadcastAddrs().forEach(addr => s.send(msg, DISCOVERY_PORT, addr, () => {}));
  };
  s.bind(0, () => { try { s.setBroadcast(true); } catch (e) {} tick(); timer = setInterval(tick, 2000); });
  return { close() { closed = true; clearInterval(timer); try { s.close(); } catch (e) {} } };
}

/** Côté poste : écoute les annonces. onChange(list) avec list = [{ name, host, port, ips, local, version, seen }] */
function listen(onChange) {
  const found = new Map();
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;
  const localIps = () => { const l = new Set(['127.0.0.1']); for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4') l.add(a.address); return l; };
  const emit = () => onChange([...found.values()].sort((a, b) => (b.local - a.local) || a.name.localeCompare(b.name)));
  s.on('error', () => {});
  s.on('message', (buf, rinfo) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || m.app !== 'ScenePro' || m.role !== 'regie' || !m.port) return;
    const local = localIps().has(rinfo.address);
    // une régie sur ce PC est jointe par localhost (aucun code demandé) ; sinon par son adresse réseau
    const host = local ? 'localhost' : rinfo.address;
    const key = (m.name || '') + ':' + m.port;
    const prev = found.get(key);
    const entry = { name: m.name || rinfo.address, host: prev && prev.local ? prev.host : host, port: +m.port, ips: m.ips || [], local: (prev && prev.local) || local, version: m.version || '', seen: Date.now() };
    const changed = !prev || prev.host !== entry.host;
    found.set(key, entry);
    if (changed) emit();
  });
  s.bind(DISCOVERY_PORT, () => {});
  const prune = setInterval(() => {
    let changed = false;
    for (const [k, v] of found) if (Date.now() - v.seen > 7000) { found.delete(k); changed = true; }
    if (changed) emit();
  }, 2000);
  return { list: () => [...found.values()], close() { closed = true; clearInterval(prune); try { s.close(); } catch (e) {} } };
}

module.exports = { announce, listen, DISCOVERY_PORT };

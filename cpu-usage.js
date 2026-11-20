/* ============================================================
   ScènePro — mesure de l'utilisation du processeur (CPU)
   - CPU total de l'ordinateur (toutes applications)
   - CPU de chaque processus du logiciel : processus Node/Electron et processus enfants (ffmpeg…)
   Les pourcentages sont exprimés sur la capacité totale de l'ordinateur (100 % = tous les cœurs occupés).
   Réutilisable par les autres postes :
     const cpu = require('./cpu-usage').monitor({ children: () => [{ pid, role }], appMetrics: () => app.getAppMetrics() });
     cpu.read() → { total, app, parts: { role: % }, cores }      cpu.close()
   La mesure ne tourne que pendant que quelqu'un la lit (cpu.read() appelé) : arrêt automatique après 10 s.
   ============================================================ */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const CORES = Math.max(1, os.cpus().length);
const round = v => Math.max(0, Math.round(v * 10) / 10);

function monitor(opts = {}) {
  const children = opts.children || (() => []);
  let lastRead = 0, timer = null, ps = null, pidFile = null, closed = false;
  let sysPrev = null, selfPrev = null, selfT = 0;
  const childPrev = new Map();   // pid → { ms, t }
  const childPct = new Map();    // pid → %
  let result = { total: 0, app: 0, parts: {}, cores: CORES };

  function sysTimes() {
    let idle = 0, all = 0;
    for (const c of os.cpus()) { const t = c.times; idle += t.idle; all += t.user + t.nice + t.sys + t.idle + t.irq; }
    return { idle, all };
  }
  // temps CPU cumulé (ms) d'un enfant → pourcentage depuis la mesure précédente
  function feedChild(pid, ms) {
    const now = Date.now(), p = childPrev.get(pid);
    if (p && now > p.t && ms >= p.ms) childPct.set(pid, (ms - p.ms) / (now - p.t) / CORES * 100);
    childPrev.set(pid, { ms, t: now });
  }

  // Windows : une seule fenêtre PowerShell invisible, qui relève le temps CPU des processus listés dans un fichier
  function startWinProbe() {
    pidFile = path.join(os.tmpdir(), `scenepro-cpu-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
    try { fs.writeFileSync(pidFile, ''); } catch (e) {}
    // la sonde s'arrête d'elle-même si le logiciel qui l'a lancée disparaît (fermeture brutale)
    const script = `$f='${pidFile.replace(/'/g, "''")}'; while ($true) { if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { exit }; $o=@(); foreach ($l in @(Get-Content -LiteralPath $f -ErrorAction SilentlyContinue)) { if ($l -match '^\\d+$') { $p=Get-Process -Id ([int]$l) -ErrorAction SilentlyContinue; if ($p) { $o += ('' + $p.Id + '=' + [math]::Round($p.TotalProcessorTime.TotalMilliseconds)) } } }; [Console]::Out.WriteLine('CPU ' + ($o -join ' ')); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1500 }`;
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    ps.stdout.on('data', d => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('CPU')) continue;
        const seen = new Set();
        line.slice(3).trim().split(/\s+/).filter(Boolean).forEach(kv => { const [pid, ms] = kv.split('=').map(Number); if (pid) { seen.add(pid); feedChild(pid, ms); } });
        for (const pid of [...childPct.keys()]) if (!seen.has(pid)) { childPct.delete(pid); childPrev.delete(pid); }
      }
    });
    ps.on('error', () => { ps = null; });
    ps.on('close', () => { ps = null; });
  }
  // macOS / Linux : ps
  function unixProbe(pids) {
    if (!pids.length) { childPct.clear(); return; }
    execFile('ps', ['-o', 'pid=,time=', '-p', pids.join(',')], { timeout: 3000 }, (err, out) => {
      if (err && !out) return;
      String(out).split('\n').forEach(l => {
        const m = l.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/); if (!m) return;
        const ms = ((+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4]) * 60 + parseFloat(m[5])) * 1000;
        feedChild(+m[1], ms);
      });
    });
  }

  function tick() {
    if (closed) return;
    if (Date.now() - lastRead > 10000) { stop(); return; }
    // ordinateur entier
    const s = sysTimes();
    if (sysPrev && s.all > sysPrev.all) result.total = round((1 - (s.idle - sysPrev.idle) / (s.all - sysPrev.all)) * 100);
    sysPrev = s;
    // processus enfants (ffmpeg…)
    const kids = children().filter(k => k && k.pid);
    if (process.platform === 'win32') { if (!ps) startWinProbe(); try { fs.writeFileSync(pidFile, kids.map(k => k.pid).join('\n')); } catch (e) {} }
    else unixProbe(kids.map(k => k.pid));
    // le logiciel lui-même : processus Electron (fenêtres, GPU…) ou processus Node seul
    let own = 0;
    if (opts.appMetrics) {
      try { for (const m of opts.appMetrics()) own += (m.cpu && m.cpu.percentCPUUsage) || 0; own /= CORES; } catch (e) {}
    } else {
      const u = process.cpuUsage(), now = Date.now();
      if (selfPrev && now > selfT) own = ((u.user + u.system) - (selfPrev.user + selfPrev.system)) / 1000 / (now - selfT) / CORES * 100;
      selfPrev = u; selfT = now;
    }
    const parts = { [opts.selfLabel || 'interface']: round(own) };
    for (const k of kids) { const v = childPct.get(k.pid); if (v != null) parts[k.role] = round((parts[k.role] || 0) + v); }
    result = { total: result.total, app: round(Object.values(parts).reduce((a, b) => a + b, 0)), parts, cores: CORES };
  }
  function start() { if (timer || closed) return; tick(); timer = setInterval(tick, 1500); }
  function stop() {
    clearInterval(timer); timer = null; sysPrev = null; selfPrev = null; childPrev.clear(); childPct.clear();
    if (ps) { try { ps.kill(); } catch (e) {} ps = null; }
    if (pidFile) { try { fs.unlinkSync(pidFile); } catch (e) {} pidFile = null; }
  }
  return {
    read() { lastRead = Date.now(); start(); return result; },
    close() { closed = true; stop(); },
  };
}

module.exports = { monitor, CORES };

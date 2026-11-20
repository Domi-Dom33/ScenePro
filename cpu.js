/* ============================================================
   ScènePro — mesure de l'utilisation du processeur (CPU)
   - pc  : CPU total de l'ordinateur (tous logiciels confondus), en %
   - app : CPU de ce logiciel ScènePro (fenêtres + moteur + ffmpeg lancés par lui), en % de la machine
   Utilisation : const cpu = createCpuMeter({ childPids: () => [pid, …] }); cpu.get() → { pc, app, cores }
   ============================================================ */
'use strict';
const os = require('os');
const { execFile } = require('child_process');

function createCpuMeter(opts = {}) {
  const cores = os.cpus().length || 1;
  let last = null, lastSelf = process.cpuUsage(), lastT = Date.now(), lastChild = new Map();
  const out = { pc: 0, app: 0, cores };
  let electronApp = null;
  try { const e = require('electron'); if (e && typeof e === 'object' && e.app && e.app.getAppMetrics) electronApp = e.app; } catch (e) {}

  function pcSample() {
    const t = os.cpus().reduce((a, c) => { const x = c.times; a.idle += x.idle; a.total += x.user + x.nice + x.sys + x.idle + x.irq; return a; }, { idle: 0, total: 0 });
    if (last) { const dt = t.total - last.total, di = t.idle - last.idle; if (dt > 0) out.pc = Math.round(Math.max(0, Math.min(100, (1 - di / dt) * 100))); }
    last = t;
  }
  // temps CPU (secondes) des processus enfants (ffmpeg…) : PowerShell sous Windows, ps ailleurs
  function childCpu(pids, cb) {
    if (!pids.length) return cb(0);
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU)" }`], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        const now = Date.now(); let used = 0;
        String(stdout || '').trim().split(/\r?\n/).forEach(l => {
          const [pid, sec] = l.trim().split(/\s+/); if (!pid) return;
          const s = parseFloat(String(sec).replace(',', '.')) || 0, p = lastChild.get(pid);
          if (p) used += Math.max(0, s - p.s) / ((now - p.t) / 1000);
          lastChild.set(pid, { s, t: now });
        });
        cb(used / cores * 100);
      });
    } else {
      execFile('ps', ['-o', 'pcpu=', '-p', pids.join(',')], { timeout: 3000 }, (err, stdout) => cb(String(stdout || '').trim().split(/\s+/).reduce((a, v) => a + (parseFloat(v) || 0), 0) / cores));
    }
  }
  function tick() {
    pcSample();
    let own = 0;
    if (electronApp) {
      // toutes les fenêtres et processus de cette instance de l'application
      try { own = electronApp.getAppMetrics().reduce((a, m) => a + (m.cpu ? m.cpu.percentCPUUsage : 0), 0) / cores; } catch (e) {}
    } else {
      const u = process.cpuUsage(lastSelf), now = Date.now();
      own = (u.user + u.system) / 1000 / (now - lastT) / cores * 100;
      lastSelf = process.cpuUsage(); lastT = now;
    }
    const pids = (opts.childPids ? opts.childPids() : []).filter(Boolean);
    childCpu(pids, c => { out.app = Math.round(Math.max(0, Math.min(100, own + c))); });
  }
  tick();
  const timer = setInterval(tick, opts.interval || 2000);
  if (timer.unref) timer.unref();
  return { get: () => Object.assign({}, out), close: () => clearInterval(timer) };
}

module.exports = { createCpuMeter };

/* ============================================================
   ScènePro — moteur de rendu de l'habillage (synthés, logo, bandeau…)
   Partagé par : la régie (incrustation DSK), le poste Synthé (aperçus)
   et la page /overlay (source navigateur pour OBS, vMix, CasparCG…).
   Tout est dessiné sur un canvas 2D dans un repère 1920 × 1080.
   ============================================================ */
(function (root) {
  'use strict';
  const RW = 1920, RH = 1080, SAFE_X = 96, SAFE_Y = 60;
  const DUR_IN = 550, DUR_OUT = 380;
  const DEFAULT_THEME = { primary: '#12151a', accent: '#ff3b3b', text: '#ffffff', text2: '#12151a', panel2: '#ffffff', font: 'Segoe UI' };
  const ORDER = { fullscreen: 0, logo: 1, clock: 2, badge: 3, ticker: 4, lower: 5 };

  const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1); // sous-étape d'une animation
  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return `rgba(0,0,0,${a})`;
    const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function rrect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2); g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  const pad2 = n => String(n).padStart(2, '0');

  class Scene {
    constructor() { this.items = new Map(); this.theme = Object.assign({}, DEFAULT_THEME); this.images = new Map(); this.onImage = null; }

    /** st = { theme, items:[{id,type,on,...}] } — à appeler à chaque changement d'état */
    update(st) {
      st = st || {};
      const now = performance.now();
      this.theme = Object.assign({}, DEFAULT_THEME, st.theme || {});
      const seen = new Set();
      for (const it of (st.items || [])) {
        if (!it || !it.id) continue;
        seen.add(it.id);
        let s = this.items.get(it.id);
        if (!s) { s = { on: false, p0: 0, t: now - 1e5, born: now }; this.items.set(it.id, s); }
        const want = !!it.on;
        if (want !== s.on) { s.p0 = this.prog(s, now); s.on = want; s.t = now; if (want) s.tOn = now; }
        s.removed = false; s.data = it;
        if (it.image) this.img(it.image);
      }
      for (const [, s] of this.items) if (!seen.has(s.data.id) && !s.removed) { s.p0 = this.prog(s, now); s.on = false; s.t = now; s.removed = true; }
    }
    prog(s, now) {
      if (s.on) return Math.min(1, s.p0 + (now - s.t) / DUR_IN);
      return Math.max(0, s.p0 - (now - s.t) / DUR_OUT);
    }
    img(src) {
      let im = this.images.get(src);
      if (!im) { im = new Image(); im.onload = () => this.onImage && this.onImage(); im.src = src; this.images.set(src, im); }
      return im;
    }
    /** true si quelque chose est visible (ou en cours d'animation) */
    active(now = performance.now()) { for (const [, s] of this.items) if (s.on || this.prog(s, now) > 0) return true; return false; }
    count() { let n = 0; for (const [, s] of this.items) if (s.on) n++; return n; }

    /** true si un élément visible passe le filtre (ex. cibles d'une sortie) */
    activeFor(filter, now = performance.now()) { for (const [, s] of this.items) if ((s.on || this.prog(s, now) > 0) && (!filter || filter(s.data))) return true; return false; }

    /** dessine l'habillage dans un canvas W × H (cadre 16/9 centré). Ne l'efface pas.
        filter(data) → false pour ne pas dessiner un élément (cibles PGM 1/2/3/WEB) */
    draw(g, W, H, now = performance.now(), filter) {
      const k = Math.min(W / RW, H / RH), ox = (W - RW * k) / 2, oy = (H - RH * k) / 2;
      const list = [];
      for (const [id, s] of this.items) {
        const p = this.prog(s, now);
        if (p <= 0) { if (s.removed) this.items.delete(id); continue; }
        if (filter && !filter(s.data)) continue;
        list.push({ s, p });
      }
      if (!list.length) return;
      list.sort((a, b) => (ORDER[a.s.data.type] || 0) - (ORDER[b.s.data.type] || 0));
      // un bandeau défilant visible fait remonter les synthés
      let tick = 0; for (const e of list) if (e.s.data.type === 'ticker') tick = Math.max(tick, ease(e.p));
      g.save(); g.translate(ox, oy); g.scale(k, k);
      g.beginPath(); g.rect(0, 0, RW, RH); g.clip();
      for (const e of list) {
        const fn = DRAW[e.s.data.type]; if (!fn) continue;
        g.save(); g.globalAlpha = 1; g.textBaseline = 'alphabetic';
        try { fn.call(this, g, e.s.data, e.p, now, e.s, this.theme, { tick }); } catch (err) {}
        g.restore();
      }
      g.restore();
    }
  }

  const font = (t, w, px) => `${w} ${px}px "${t.font}", "Segoe UI", system-ui, sans-serif`;

  const DRAW = {
    /* ---------- synthé (lower third) : nom + fonction ---------- */
    lower(g, d, p, now, s, t, ctx) {
      const name = d.name || '', role = d.role || '';
      const style = d.style || 'classique', pos = d.pos || 'left';
      const lift = ctx.tick * 92;
      const nPx = 54, rPx = 34;
      g.font = font(t, 700, nPx); const nw = g.measureText(name).width;
      g.font = font(t, 500, rPx); const rw = role ? g.measureText(role).width : 0;
      const a = ease(seg(p, 0, 0.7)), b = ease(seg(p, 0.3, 1));

      if (style === 'moderne') {
        const w = Math.max(nw, rw * 1.08) + 40, y = RH - SAFE_Y - 110 - lift;
        const x = pos === 'center' ? (RW - w) / 2 : pos === 'right' ? RW - SAFE_X - w : SAFE_X;
        const grd = g.createLinearGradient(0, y - 90, 0, RH); grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, `rgba(0,0,0,${0.55 * a})`);
        g.fillStyle = grd; g.fillRect(0, y - 90, RW, RH - y + 90);
        g.globalAlpha = b; g.fillStyle = t.text; g.font = font(t, 800, nPx + 6);
        g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12;
        g.fillText(name, x + (1 - b) * -30, y);
        g.shadowBlur = 0;
        g.globalAlpha = 1; g.fillStyle = t.accent; g.fillRect(x, y + 18, w * a, 6);
        if (role) { g.globalAlpha = b; g.fillStyle = t.accent; g.font = font(t, 700, rPx - 4); if ('letterSpacing' in g) g.letterSpacing = '3px';
          g.fillText(role.toUpperCase(), x + (1 - b) * 30, y + 66); }
        return;
      }
      if (style === 'bandeau') {
        const h = 96, y = RH - SAFE_Y - h - lift;
        const w = RW * a;
        g.fillStyle = hexA(t.primary, 0.92); g.fillRect(0, y, w, h);
        g.fillStyle = t.accent; g.fillRect(0, y, w, 6);
        g.globalAlpha = b; g.fillStyle = t.text; g.font = font(t, 700, nPx - 6);
        const x0 = pos === 'center' ? (RW - (nw + (role ? rw + 60 : 0))) / 2 : SAFE_X;
        g.fillText(name, x0, y + 66);
        if (role) { g.font = font(t, 400, rPx); g.fillStyle = hexA(t.text, 0.8); g.fillText(role, x0 + nw * ((nPx - 6) / nPx) + 40, y + 64); }
        return;
      }
      // classique : barre accent + cartouche nom + cartouche fonction
      const padX = 34, h1 = 82, h2 = 54;
      const w1 = nw + padX * 2, w2 = rw + padX * 2, w = Math.max(w1, role ? w2 : 0);
      const y1 = RH - SAFE_Y - (role ? h1 + h2 : h1) - 20 - lift;
      const x = pos === 'center' ? (RW - w) / 2 : pos === 'right' ? RW - SAFE_X - w : SAFE_X;
      g.fillStyle = t.accent; g.fillRect(x - 14, y1, 10, (role ? h1 + h2 : h1) * ease(seg(p, 0, 0.35)));
      g.save(); g.beginPath(); g.rect(x, y1, w1 * a, h1); g.clip();
      g.fillStyle = hexA(t.primary, 0.94); g.fillRect(x, y1, w1, h1);
      g.globalAlpha = b; g.fillStyle = t.text; g.font = font(t, 700, nPx); g.fillText(name, x + padX, y1 + 60);
      g.restore();
      if (role) {
        g.save(); g.beginPath(); g.rect(x, y1 + h1, w2 * b, h2); g.clip();
        g.fillStyle = t.panel2; g.fillRect(x, y1 + h1, w2, h2);
        g.fillStyle = t.text2; g.font = font(t, 500, rPx); g.globalAlpha = ease(seg(p, 0.5, 1)); g.fillText(role, x + padX, y1 + h1 + 39);
        g.restore();
      }
    },

    /* ---------- logo de la chaîne (bug) ---------- */
    logo(g, d, p, now, s, t) {
      const im = d.image && this.img(d.image); if (!im || !im.complete || !im.naturalWidth) return;
      const w = clamp(+d.size || 0.12, 0.03, 0.6) * RW, h = w * im.naturalHeight / im.naturalWidth;
      const c = d.corner || 'tr', m = +d.margin >= 0 ? +d.margin : 1;
      const x = c[1] === 'l' ? SAFE_X * m : RW - SAFE_X * m - w, y = c[0] === 't' ? SAFE_Y * m : RH - SAFE_Y * m - h;
      g.globalAlpha = ease(p) * clamp(d.opacity == null ? 1 : +d.opacity, 0.05, 1);
      g.drawImage(im, x, y, w, h);
    },

    /* ---------- badge texte (EN DIRECT, REPLAY…) ---------- */
    badge(g, d, p, now, s, t) {
      const txt = (d.text || 'EN DIRECT').toUpperCase(), px = 30;
      g.font = font(t, 800, px); if ('letterSpacing' in g) g.letterSpacing = '2px';
      const tw = g.measureText(txt).width, dot = d.dot !== false, h = 54, w = tw + 44 + (dot ? 30 : 0);
      const c = d.corner || 'tl';
      const x = c[1] === 'l' ? SAFE_X : RW - SAFE_X - w, y = c[0] === 't' ? SAFE_Y : RH - SAFE_Y - h;
      g.globalAlpha = ease(p); const sc = 0.85 + 0.15 * ease(p);
      g.translate(x + w / 2, y + h / 2); g.scale(sc, sc); g.translate(-w / 2, -h / 2);
      g.fillStyle = d.color || t.accent; rrect(g, 0, 0, w, h, 8); g.fill();
      if (dot) { const pulse = 0.55 + 0.45 * Math.abs(Math.sin((now - (s.tOn || 0)) / 500)); g.fillStyle = `rgba(255,255,255,${pulse})`; g.beginPath(); g.arc(30, h / 2, 9, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#fff'; g.fillText(txt, dot ? 52 : 22, h / 2 + 11);
    },

    /* ---------- horloge / compte à rebours ---------- */
    clock(g, d, p, now, s, t) {
      const D = new Date(); let txt;
      if (d.mode === 'compte' && /^\d{1,2}:\d{2}$/.test(d.target || '')) {
        const [hh, mm] = d.target.split(':').map(Number); const tg = new Date(D); tg.setHours(hh, mm, 0, 0);
        let r = Math.max(0, Math.round((tg - D) / 1000));
        txt = (r >= 3600 ? Math.floor(r / 3600) + ':' : '') + pad2(Math.floor(r / 60) % 60) + ':' + pad2(r % 60);
      } else txt = pad2(D.getHours()) + ':' + pad2(D.getMinutes()) + (d.seconds ? ':' + pad2(D.getSeconds()) : '');
      const label = d.label || '';
      g.font = font(t, 700, 40); const tw = g.measureText(d.seconds || d.mode === 'compte' ? '00:00:00' : '00:00').width;
      g.font = font(t, 600, 20); const lw = label ? g.measureText(label.toUpperCase()).width : 0;
      const w = Math.max(tw, lw) + 40, h = label ? 92 : 64, c = d.corner || 'tr';
      const x = c[1] === 'l' ? SAFE_X : RW - SAFE_X - w, y = c[0] === 't' ? SAFE_Y : RH - SAFE_Y - h;
      g.globalAlpha = ease(p);
      g.fillStyle = hexA(t.primary, 0.85); rrect(g, x, y, w, h, 8); g.fill();
      g.fillStyle = t.accent; g.fillRect(x, y + h - 4, w, 4);
      g.textAlign = 'center'; g.fillStyle = t.text;
      if (label) { g.font = font(t, 600, 20); g.fillStyle = hexA(t.text, 0.7); g.fillText(label.toUpperCase(), x + w / 2, y + 30); g.fillStyle = t.text; }
      g.font = font(t, 700, 40); g.fillText(txt, x + w / 2, y + (label ? 76 : 47));
    },

    /* ---------- bandeau défilant (ticker / crawl) ---------- */
    ticker(g, d, p, now, s, t) {
      const h = 72, y = RH - h - (+d.bottom || 0) + (1 - ease(p)) * (h + 10);
      const label = (d.label || '').toUpperCase(), txt = (d.text || '').replace(/\s*\n\s*/g, '   •   ');
      g.fillStyle = hexA(t.primary, 0.95); g.fillRect(0, y, RW, h);
      g.fillStyle = t.accent; g.fillRect(0, y, RW, 4);
      let lx = 0;
      if (label) { g.font = font(t, 800, 30); const lw = g.measureText(label).width + 60;
        g.fillStyle = t.accent; g.fillRect(0, y, lw + 40, h); g.fillStyle = '#fff'; g.fillText(label, 40, y + 47); lx = lw + 40; }
      if (!txt) return;
      g.save(); g.beginPath(); g.rect(lx + 10, y, RW - lx - 10, h); g.clip();
      g.font = font(t, 500, 34); g.fillStyle = t.text;
      const gap = 140, tw = g.measureText(txt).width + gap;
      const speed = clamp(+d.speed || 120, 20, 600);
      const off = (((now - (s.tOn || 0)) / 1000) * speed) % tw;
      for (let x = RW - off - tw * Math.ceil((RW - lx) / tw + 1); x < RW + tw; x += tw) if (x + tw > lx) g.fillText(txt, x, y + 48);
      g.restore();
    },

    /* ---------- carton plein écran (pause, titre, générique) ---------- */
    fullscreen(g, d, p, now, s, t) {
      const a = ease(p);
      g.globalAlpha = a;
      const im = d.image && this.img(d.image);
      if (im && im.complete && im.naturalWidth) { const k = Math.max(RW / im.naturalWidth, RH / im.naturalHeight); g.drawImage(im, (RW - im.naturalWidth * k) / 2, (RH - im.naturalHeight * k) / 2, im.naturalWidth * k, im.naturalHeight * k);
        g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, RW, RH); }
      else { g.fillStyle = hexA(t.primary, clamp(d.opacity == null ? 0.9 : +d.opacity, 0, 1)); g.fillRect(0, 0, RW, RH); }
      g.textAlign = 'center';
      const lines = (d.title || '').split('\n'), b = ease(seg(p, 0.25, 1));
      g.globalAlpha = a * b; g.fillStyle = t.text; g.font = font(t, 800, 104);
      const total = lines.length * 120 + (d.subtitle ? 90 : 0), y0 = RH / 2 - total / 2 + 90 + (1 - b) * 30;
      lines.forEach((l, i) => g.fillText(l, RW / 2, y0 + i * 120));
      const ly = y0 + (lines.length - 1) * 120 + 40;
      g.globalAlpha = a; g.fillStyle = t.accent; const lw = 220 * ease(seg(p, 0.1, 0.8)); g.fillRect(RW / 2 - lw / 2, ly, lw, 7);
      if (d.subtitle) { g.globalAlpha = a * b; g.fillStyle = hexA(t.text, 0.85); g.font = font(t, 500, 48); g.fillText(d.subtitle, RW / 2, ly + 80); }
    },
  };

  root.GfxRender = { Scene, DEFAULT_THEME, RW, RH, TYPES: Object.keys(DRAW) };
})(typeof window !== 'undefined' ? window : globalThis);

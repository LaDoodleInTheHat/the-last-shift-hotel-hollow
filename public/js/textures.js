// textures.js - every texture in the hotel is painted here on a <canvas>. No image files.
import * as THREE from 'three';
import { mulberry32 } from './maze.js';

const TAU = Math.PI * 2;

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTex(c, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function grain(ctx, w, h, amt, rng) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const n = (rng() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function ell(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot, 0, TAU);
}

function woodGrain(ctx, x, y, w, h, base, dark, rng, vertical = true) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  const n = Math.floor((vertical ? w : h) / 3);
  for (let i = 0; i < n; i++) {
    ctx.strokeStyle = dark;
    ctx.globalAlpha = 0.08 + rng() * 0.25;
    ctx.lineWidth = 0.5 + rng() * 1.6;
    ctx.beginPath();
    const p = (vertical ? x : y) + rng() * (vertical ? w : h);
    const wob = rng() * 5, ph = rng() * TAU, fr = 0.01 + rng() * 0.03;
    const len = vertical ? h : w;
    for (let s = 0; s <= len; s += 8) {
      const o = Math.sin(s * fr + ph) * wob;
      if (vertical) (s === 0 ? ctx.moveTo(p + o, y + s) : ctx.lineTo(p + o, y + s));
      else (s === 0 ? ctx.moveTo(x + s, p + o) : ctx.lineTo(x + s, p + o));
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function damask(ctx, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  // central leaf
  ctx.beginPath();
  ctx.moveTo(0, -34);
  ctx.bezierCurveTo(16, -18, 16, 10, 0, 30);
  ctx.bezierCurveTo(-16, 10, -16, -18, 0, -34);
  ctx.fill();
  // scrolls
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx * 6, 14);
    ctx.bezierCurveTo(sx * 30, 10, sx * 34, -16, sx * 18, -22);
    ctx.bezierCurveTo(sx * 28, -10, sx * 22, 2, sx * 8, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx * 5, 24);
    ctx.bezierCurveTo(sx * 22, 30, sx * 28, 44, sx * 12, 48);
    ctx.bezierCurveTo(sx * 18, 40, sx * 12, 34, sx * 2, 34);
    ctx.fill();
    ell(ctx, sx * 22, -32, 4, 4); ctx.fill();
  }
  // diamonds
  ctx.beginPath(); ctx.moveTo(0, -52); ctx.lineTo(5, -44); ctx.lineTo(0, -36); ctx.lineTo(-5, -44); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(5, 50); ctx.lineTo(0, 60); ctx.lineTo(-5, 50); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/** Full-height wall: damask paper over dark wood wainscoting. One tile = one cell wide. */
function wallpaper(opts, seed) {
  const rng = mulberry32(seed);
  const S = 512;
  const c = mk(S, S), ctx = c.getContext('2d');
  const railY = Math.round(S * 0.63);
  ctx.fillStyle = opts.base; ctx.fillRect(0, 0, S, railY);
  // faint vertical stripes
  for (let x = 0; x < S; x += 32) {
    ctx.fillStyle = opts.stripe; ctx.globalAlpha = 0.35;
    ctx.fillRect(x, 0, 16, railY);
  }
  ctx.globalAlpha = 1;
  // damask motifs, staggered
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = col * 128 + (row % 2 ? 64 : 0) + 0.001;
      const y = 62 + row * 106;
      ctx.fillStyle = opts.motifDark; ctx.globalAlpha = 0.7;
      damask(ctx, x + 2, y + 2, 0.86);
      if (x < 70) damask(ctx, x + S + 2, y + 2, 0.86);
      ctx.fillStyle = opts.motif; ctx.globalAlpha = 0.9;
      damask(ctx, x, y, 0.86);
      if (x < 70) damask(ctx, x + S, y, 0.86);
      if (x > S - 70) damask(ctx, x - S, y, 0.86);
    }
  }
  ctx.globalAlpha = 1;
  // crown moulding
  woodGrain(ctx, 0, 0, S, 18, '#1d0f09', '#000', rng, false);
  ctx.fillStyle = 'rgba(255,220,170,0.10)'; ctx.fillRect(0, 16, S, 2);
  // water stains running down from the ceiling
  for (let i = 0; i < 7; i++) {
    const x = rng() * S, w = 10 + rng() * 40, len = 60 + rng() * 240;
    const g = ctx.createLinearGradient(0, 18, 0, 18 + len);
    g.addColorStop(0, 'rgba(10,6,2,0.42)'); g.addColorStop(1, 'rgba(10,6,2,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 18, w, len);
    if (x + w > S) ctx.fillRect(x - S, 18, w, len);
  }
  // peeling patches
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = `rgba(${150 + rng() * 40},${130 + rng() * 30},${100 + rng() * 20},0.16)`;
    ell(ctx, rng() * S, 40 + rng() * (railY - 80), 8 + rng() * 22, 5 + rng() * 14, rng() * 3); ctx.fill();
  }
  // wainscot
  woodGrain(ctx, 0, railY, S, S - railY, '#23120a', '#060201', rng, true);
  for (let p = 0; p < 2; p++) {
    const px = p * 256 + 26, py = railY + 34, pw = 204, ph = S - railY - 78;
    ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(px, py, pw, ph);
    woodGrain(ctx, px + 6, py + 6, pw - 12, ph - 12, '#2a160c', '#070302', rng, true);
    ctx.strokeStyle = 'rgba(255,200,140,0.12)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px + pw, py); ctx.lineTo(px + pw, py + ph); ctx.lineTo(px, py + ph); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.moveTo(px, py + ph); ctx.lineTo(px, py); ctx.lineTo(px + pw, py); ctx.stroke();
  }
  // chair rail + skirting
  const g = ctx.createLinearGradient(0, railY - 2, 0, railY + 16);
  g.addColorStop(0, '#4a2a16'); g.addColorStop(0.4, '#2c170c'); g.addColorStop(1, '#0d0603');
  ctx.fillStyle = g; ctx.fillRect(0, railY - 2, S, 18);
  ctx.fillStyle = '#120904'; ctx.fillRect(0, S - 30, S, 30);
  ctx.fillStyle = 'rgba(255,200,140,0.10)'; ctx.fillRect(0, S - 31, S, 2);
  // scuffs
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.1 + rng() * 0.25})`; ctx.lineWidth = 1;
    const x = rng() * S, y = railY + 20 + rng() * (S - railY - 30);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rng() - 0.5) * 30, y + (rng() - 0.5) * 6); ctx.stroke();
  }
  grain(ctx, S, S, 22, rng);
  return toTex(c);
}

function carpet(seed, palette) {
  const rng = mulberry32(seed);
  const S = 256;
  const c = mk(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = palette.base; ctx.fillRect(0, 0, S, S);
  // woven diamonds
  for (let y = -1; y < 5; y++) {
    for (let x = -1; x < 5; x++) {
      const cx = x * 64 + (y % 2 ? 32 : 0), cy = y * 64;
      ctx.fillStyle = palette.dark;
      ctx.beginPath(); ctx.moveTo(cx, cy - 26); ctx.lineTo(cx + 26, cy); ctx.lineTo(cx, cy + 26); ctx.lineTo(cx - 26, cy); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = palette.line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy - 18); ctx.lineTo(cx + 18, cy); ctx.lineTo(cx, cy + 18); ctx.lineTo(cx - 18, cy); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = palette.line;
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2;
        ell(ctx, cx + Math.cos(a) * 7, cy + Math.sin(a) * 7, 4, 2.4, a); ctx.fill();
      }
      ctx.fillStyle = palette.base;
      ell(ctx, cx, cy, 3, 3); ctx.fill();
    }
  }
  // lattice lines
  ctx.strokeStyle = palette.line; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5;
  for (let i = -S; i < S * 2; i += 64) {
    ctx.beginPath(); ctx.moveTo(i + 32, 0); ctx.lineTo(i + 32 + S, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i + 32, 0); ctx.lineTo(i + 32 - S, S); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // wear and stains
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.08 + rng() * 0.16})`;
    ell(ctx, rng() * S, rng() * S, 10 + rng() * 40, 8 + rng() * 26, rng() * 3); ctx.fill();
  }
  grain(ctx, S, S, 34, rng);
  return toTex(c);
}

function ceiling(seed) {
  const rng = mulberry32(seed);
  const S = 256;
  const c = mk(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = '#6a6458'; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(30,26,20,${0.15 + rng() * 0.3})`;
    ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 1.5, 1 + rng() * 1.5);
  }
  for (let i = 0; i < 6; i++) {
    const x = rng() * S, y = rng() * S, r = 18 + rng() * 46;
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      const g = ctx.createRadialGradient(x + ox, y + oy, r * 0.2, x + ox, y + oy, r);
      g.addColorStop(0, 'rgba(50,34,14,0.16)');
      g.addColorStop(0.8, 'rgba(44,28,10,0.26)');
      g.addColorStop(1, 'rgba(60,38,12,0)');
      ctx.fillStyle = g;
      ell(ctx, x + ox, y + oy, r, r * (0.6 + rng() * 0.4), rng() * 3); ctx.fill();
    }
  }
  ctx.strokeStyle = '#2a261f'; ctx.lineWidth = 3;
  for (let i = 0; i <= 2; i++) {
    ctx.beginPath(); ctx.moveTo(i * 128, 0); ctx.lineTo(i * 128, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 128); ctx.lineTo(S, i * 128); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
  for (let i = 0; i < 2; i++) {
    ctx.beginPath(); ctx.moveTo(i * 128 + 3, 0); ctx.lineTo(i * 128 + 3, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 128 + 3); ctx.lineTo(S, i * 128 + 3); ctx.stroke();
  }
  grain(ctx, S, S, 16, rng);
  return toTex(c);
}

function wood(seed, base, dark) {
  const rng = mulberry32(seed);
  const S = 256;
  const c = mk(S, S), ctx = c.getContext('2d');
  woodGrain(ctx, 0, 0, S, S, base, dark, rng, true);
  for (let i = 0; i < 3; i++) {
    const x = rng() * S, y = rng() * S;
    ctx.strokeStyle = dark; ctx.globalAlpha = 0.5;
    for (let r = 2; r < 12; r += 3) { ell(ctx, x, y, r * 0.6, r); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  grain(ctx, S, S, 18, rng);
  return toTex(c);
}

function planks(seed) {
  const rng = mulberry32(seed);
  const S = 256;
  const c = mk(S, S), ctx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const shade = 28 + rng() * 14;
    woodGrain(ctx, i * 64, 0, 64, S, `rgb(${shade + 18},${shade},${shade - 12})`, '#080402', rng, true);
    ctx.fillStyle = '#060302'; ctx.fillRect(i * 64, 0, 2, S);
    const j = rng() * S;
    ctx.fillRect(i * 64, j, 64, 2);
  }
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.1 + rng() * 0.2})`;
    ell(ctx, rng() * S, rng() * S, 10 + rng() * 30, 6 + rng() * 20, rng() * 3); ctx.fill();
  }
  grain(ctx, S, S, 22, rng);
  return toTex(c);
}

function doorLeaf(seed) {
  const rng = mulberry32(seed);
  const W = 256, H = 512;
  const c = mk(W, H), ctx = c.getContext('2d');
  woodGrain(ctx, 0, 0, W, H, '#3a1c10', '#0a0402', rng, true);
  for (const [py, ph] of [[34, 190], [262, 216]]) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(34, py, W - 68, ph);
    woodGrain(ctx, 42, py + 8, W - 84, ph - 16, '#42210f', '#0a0402', rng, true);
    ctx.strokeStyle = 'rgba(255,190,130,0.14)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W - 34, py); ctx.lineTo(W - 34, py + ph); ctx.lineTo(34, py + ph); ctx.stroke();
  }
  // brass handle + escutcheon
  const g = ctx.createLinearGradient(196, 0, 236, 0);
  g.addColorStop(0, '#6b5320'); g.addColorStop(0.5, '#d6b45a'); g.addColorStop(1, '#5a4418');
  ctx.fillStyle = g; ctx.fillRect(206, 232, 22, 62);
  ctx.fillStyle = '#e2c672'; ell(ctx, 217, 252, 12, 12); ctx.fill();
  ctx.fillStyle = '#6b5320'; ell(ctx, 217, 252, 6, 6); ctx.fill();
  ctx.fillStyle = '#100a04'; ell(ctx, 217, 280, 3, 5); ctx.fill();
  for (let i = 0; i < 30; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.15 + rng() * 0.25})`; ctx.lineWidth = 1;
    const x = rng() * W, y = rng() * H;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rng() - 0.5) * 14, y + rng() * 40); ctx.stroke();
  }
  grain(ctx, W, H, 18, rng);
  return toTex(c, false);
}

function wardrobeFront(seed) {
  const rng = mulberry32(seed);
  const W = 256, H = 512;
  const c = mk(W, H), ctx = c.getContext('2d');
  woodGrain(ctx, 0, 0, W, H, '#2e170c', '#070301', rng, true);
  for (const x0 of [10, 132]) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x0, 14, 114, H - 50);
    woodGrain(ctx, x0 + 6, 20, 102, H - 62, '#341b0e', '#070301', rng, true);
    // louvre slats
    for (let y = 40; y < 250; y += 14) {
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(x0 + 16, y, 82, 6);
      ctx.fillStyle = 'rgba(255,200,150,0.08)'; ctx.fillRect(x0 + 16, y + 6, 82, 2);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3; ctx.strokeRect(x0 + 16, 280, 82, 160);
  }
  ctx.fillStyle = '#000'; ctx.fillRect(126, 10, 4, H - 40);
  ctx.fillStyle = '#c9a84f';
  ell(ctx, 114, 270, 6, 6); ctx.fill(); ell(ctx, 142, 270, 6, 6); ctx.fill();
  ctx.fillStyle = '#0a0503'; ctx.fillRect(0, H - 30, W, 30);
  grain(ctx, W, H, 18, rng);
  return toTex(c, false);
}

function fabric(seed, base, stain, pattern) {
  const rng = mulberry32(seed);
  const S = 256;
  const c = mk(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  if (pattern) {
    ctx.strokeStyle = pattern; ctx.lineWidth = 3; ctx.globalAlpha = 0.6;
    for (let i = 0; i < S; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  for (let i = 0; i < 18; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.06 + rng() * 0.1})`; ctx.lineWidth = 2 + rng() * 5;
    ctx.beginPath();
    const x = rng() * S, y = rng() * S;
    ctx.moveTo(x, y); ctx.quadraticCurveTo(x + (rng() - 0.5) * 120, y + (rng() - 0.5) * 60, x + (rng() - 0.5) * 160, y + (rng() - 0.5) * 80);
    ctx.stroke();
  }
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = stain;
    ell(ctx, rng() * S, rng() * S, 8 + rng() * 36, 6 + rng() * 24, rng() * 3); ctx.fill();
  }
  grain(ctx, S, S, 20, rng);
  return toTex(c);
}

function metal(seed) {
  const rng = mulberry32(seed);
  const W = 128, H = 256;
  const c = mk(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#3c3a36'); g.addColorStop(0.5, '#6f6b62'); g.addColorStop(1, '#34322e');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 300; i++) {
    ctx.strokeStyle = `rgba(${rng() < 0.5 ? 255 : 0},${rng() < 0.5 ? 255 : 0},${rng() < 0.5 ? 255 : 0},0.05)`;
    const x = rng() * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4; ctx.strokeRect(8, 8, W - 16, H - 16);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(40,16,4,${0.15 + rng() * 0.25})`;
    ell(ctx, rng() * W, rng() * H, 4 + rng() * 14, 8 + rng() * 30); ctx.fill();
  }
  grain(ctx, W, H, 14, rng);
  return toTex(c, false);
}

function plate(text) {
  const W = 128, H = 64;
  const c = mk(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#d8bc6a'); g.addColorStop(0.5, '#a88838'); g.addColorStop(1, '#6e5520');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#3a2c0c'; ctx.lineWidth = 3; ctx.strokeRect(5, 5, W - 10, H - 10);
  ctx.fillStyle = '#17100a';
  ctx.font = 'bold 40px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2 + 2);
  ctx.fillStyle = '#4a3a12';
  for (const [x, y] of [[11, 11], [W - 11, 11], [11, H - 11], [W - 11, H - 11]]) { ell(ctx, x, y, 2.5, 2.5); ctx.fill(); }
  return toTex(c, false);
}

function sign(text, fg, bg, w = 256, h = 64, font = 'bold 34px Georgia, serif') {
  const c = mk(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = fg; ctx.globalAlpha = 0.5; ctx.lineWidth = 2; ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.globalAlpha = 1;
  ctx.fillStyle = fg; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 2);
  return toTex(c, false);
}

function keycard() {
  const W = 128, H = 80;
  const c = mk(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#efe6cf'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#16100c'; ctx.fillRect(0, 10, W, 16);
  ctx.fillStyle = '#b08a2c'; ctx.fillRect(0, 60, W, 6);
  ctx.fillStyle = '#5a0f18'; ctx.font = 'bold 15px Georgia, serif'; ctx.textAlign = 'center';
  ctx.fillText('HOTEL HOLLOW', W / 2, 44);
  ctx.font = 'bold 10px Georgia, serif'; ctx.fillStyle = '#16100c';
  ctx.fillText('MASTER KEY', W / 2, 56);
  return toTex(c, false);
}

function glow() {
  const S = 64;
  const c = mk(S, S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return toTex(c, false);
}

/** The front doors, bricked up from the inside. */
function noExit(seed) {
  const rng = mulberry32(seed);
  const W = 512, H = 512;
  const c = mk(W, H), ctx = c.getContext('2d');
  woodGrain(ctx, 0, 0, W, H, '#1c0e07', '#050201', rng, true);
  // bricks inside the frame
  for (let y = 0; y < 15; y++) {
    for (let x = -1; x < 8; x++) {
      const bx = 38 + x * 64 + (y % 2 ? 32 : 0), by = 34 + y * 32;
      const s = 50 + rng() * 30;
      ctx.fillStyle = `rgb(${s + 30},${s * 0.55},${s * 0.45})`;
      const x0 = Math.max(38, bx + 2), x1 = Math.min(W - 38, bx + 62);
      if (x1 > x0) ctx.fillRect(x0, by + 2, x1 - x0, 28);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(38, 34, W - 76, H - 34);
  // old door frame + transom
  ctx.strokeStyle = '#0c0603'; ctx.lineWidth = 12; ctx.strokeRect(32, 28, W - 64, H);
  // scrawl
  ctx.save();
  ctx.translate(W / 2, 250); ctx.rotate(-0.06);
  ctx.font = 'bold 86px Georgia, serif'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(120,6,6,0.92)';
  ctx.fillText('NO EXIT', 0, 0);
  for (let i = 0; i < 16; i++) {
    const x = -170 + rng() * 340, len = 20 + rng() * 110;
    ctx.fillRect(x, -6, 3 + rng() * 3, len);
  }
  ctx.restore();
  grain(ctx, W, H, 24, rng);
  return toTex(c, false);
}

// ---------------------------------------------------------------------------
// Blood
// ---------------------------------------------------------------------------

function blood(variant, seed) {
  const rng = mulberry32(seed);
  const S = 256;
  const c = mk(S, S), ctx = c.getContext('2d');
  const col = () => `rgba(${70 + rng() * 50},${rng() * 6},${rng() * 6},${0.75 + rng() * 0.22})`;
  const blob = (x, y, r) => { ctx.fillStyle = col(); ell(ctx, x, y, r, r * (0.7 + rng() * 0.5), rng() * 3); ctx.fill(); };
  const cx = S / 2, cy = S / 2;
  if (variant === 2) {
    // dragged smear
    for (let i = 0; i < 46; i++) {
      const t = i / 46;
      blob(40 + t * 176 + (rng() - 0.5) * 10, cy + Math.sin(t * 5) * 22 + (rng() - 0.5) * 22, 6 + rng() * 16 * (1 - t * 0.6));
    }
    for (let i = 0; i < 24; i++) {
      ctx.strokeStyle = col(); ctx.lineWidth = 1 + rng() * 3;
      const y = cy - 30 + rng() * 60;
      ctx.beginPath(); ctx.moveTo(50 + rng() * 60, y); ctx.lineTo(160 + rng() * 80, y + (rng() - 0.5) * 30); ctx.stroke();
    }
  } else if (variant === 3) {
    // handprint with drips
    blob(cx, cy + 14, 30);
    blob(cx - 4, cy + 34, 24);
    const fingers = [[-36, -30, -0.5], [-16, -52, -0.18], [6, -56, 0.05], [28, -46, 0.3], [50, 2, 1.1]];
    for (const [fx, fy, a] of fingers) {
      ctx.save(); ctx.translate(cx + fx, cy + fy); ctx.rotate(a);
      ctx.fillStyle = col(); ell(ctx, 0, 0, 8, 26); ctx.fill();
      ctx.restore();
    }
    for (let i = 0; i < 5; i++) {
      const x = cx - 30 + rng() * 60, len = 30 + rng() * 80;
      ctx.fillStyle = col(); ctx.fillRect(x, cy + 30, 3 + rng() * 3, len);
      ell(ctx, x + 2, cy + 30 + len, 4, 5); ctx.fill();
    }
  } else {
    // impact splatter
    for (let i = 0; i < 20; i++) {
      const a = rng() * TAU, d = rng() * 34;
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 12 + rng() * 26);
    }
    for (let i = 0; i < 26; i++) {
      const a = rng() * TAU, d0 = 30 + rng() * 20, d1 = d0 + 20 + rng() * 64;
      ctx.strokeStyle = col(); ctx.lineWidth = 1 + rng() * 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0); ctx.lineTo(cx + Math.cos(a) * d1, cy + Math.sin(a) * d1); ctx.stroke();
      blob(cx + Math.cos(a) * (d1 + 4), cy + Math.sin(a) * (d1 + 4), 2 + rng() * 5);
    }
    for (let i = 0; i < 60; i++) {
      const a = rng() * TAU, d = 40 + rng() * 84;
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.6 + rng() * 3);
    }
    if (variant === 1) {
      for (let i = 0; i < 7; i++) {
        const x = cx - 44 + rng() * 88, len = 30 + rng() * 90;
        ctx.fillStyle = col(); ctx.fillRect(x, cy, 2 + rng() * 4, len);
        ell(ctx, x + 2, cy + len, 4, 6); ctx.fill();
      }
    }
  }
  // darker congealed centre
  const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 70);
  g.addColorStop(0, 'rgba(20,0,0,0.5)'); g.addColorStop(1, 'rgba(20,0,0,0)');
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
  return toTex(c, false);
}

// ---------------------------------------------------------------------------
// Portraits (eyes are left blank; the renderer adds pupils that follow you)
// ---------------------------------------------------------------------------

export const PORTRAIT_W = 256, PORTRAIT_H = 320;

function portrait(seed) {
  const rng = mulberry32(seed);
  const W = PORTRAIT_W, H = PORTRAIT_H;
  const c = mk(W, H), ctx = c.getContext('2d');
  // canvas background
  const bg = ctx.createRadialGradient(W / 2, H * 0.4, 20, W / 2, H * 0.45, 200);
  const hue = [[52, 44, 30], [30, 42, 36], [46, 30, 28], [34, 34, 44]][Math.floor(rng() * 4)];
  bg.addColorStop(0, `rgb(${hue[0] + 30},${hue[1] + 26},${hue[2] + 18})`);
  bg.addColorStop(1, `rgb(${hue[0] * 0.3},${hue[1] * 0.3},${hue[2] * 0.3})`);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  const cx = W / 2 + (rng() - 0.5) * 8, headY = 132;
  const fw = 44 + rng() * 10, fh = 60 + rng() * 10;
  const skin = 150 + rng() * 50;
  const skinCol = `rgb(${skin},${skin * 0.9},${skin * 0.76})`;
  // shoulders + clothes
  const cloth = ['#15120f', '#1c0d10', '#101a16', '#1a1820'][Math.floor(rng() * 4)];
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.moveTo(cx - 100, H); ctx.quadraticCurveTo(cx - 92, 222, cx - 30, 208);
  ctx.lineTo(cx + 30, 208); ctx.quadraticCurveTo(cx + 92, 222, cx + 100, H); ctx.closePath(); ctx.fill();
  // neck + collar
  ctx.fillStyle = `rgb(${skin * 0.75},${skin * 0.66},${skin * 0.55})`;
  ctx.fillRect(cx - 15, headY + fh - 14, 30, 40);
  ctx.fillStyle = '#b9b3a2';
  ctx.beginPath(); ctx.moveTo(cx - 26, 212); ctx.lineTo(cx, 244); ctx.lineTo(cx + 26, 212); ctx.lineTo(cx + 14, 204); ctx.lineTo(cx, 222); ctx.lineTo(cx - 14, 204); ctx.closePath(); ctx.fill();
  if (rng() < 0.5) { ctx.fillStyle = '#0a0808'; ell(ctx, cx, 226, 9, 6); ctx.fill(); }
  // head
  const hg = ctx.createRadialGradient(cx - 10, headY - 14, 6, cx, headY, fh * 1.15);
  hg.addColorStop(0, skinCol);
  hg.addColorStop(0.7, `rgb(${skin * 0.72},${skin * 0.62},${skin * 0.5})`);
  hg.addColorStop(1, `rgb(${skin * 0.3},${skin * 0.25},${skin * 0.2})`);
  ctx.fillStyle = hg;
  ell(ctx, cx, headY, fw, fh); ctx.fill();
  // hair
  const hairStyle = Math.floor(rng() * 4);
  ctx.fillStyle = ['#0c0a09', '#2a2622', '#3a2a18', '#6e6a62'][Math.floor(rng() * 4)];
  if (hairStyle === 0) { // severe bun
    ctx.beginPath(); ctx.ellipse(cx, headY - 16, fw + 3, fh - 4, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.quadraticCurveTo(cx, headY - fh * 0.62, cx - fw, headY - 22); ctx.fill();
    ell(ctx, cx, headY - fh - 6, 16, 12); ctx.fill();
  } else if (hairStyle === 1) { // parted, long
    ctx.beginPath(); ctx.moveTo(cx, headY - fh - 4);
    ctx.bezierCurveTo(cx - fw - 26, headY - fh, cx - fw - 20, headY + 30, cx - fw - 8, headY + fh + 30);
    ctx.lineTo(cx - fw + 8, headY + 10); ctx.quadraticCurveTo(cx - fw + 6, headY - fh * 0.5, cx, headY - fh * 0.72);
    ctx.quadraticCurveTo(cx + fw - 6, headY - fh * 0.5, cx + fw - 8, headY + 10); ctx.lineTo(cx + fw + 8, headY + fh + 30);
    ctx.bezierCurveTo(cx + fw + 20, headY + 30, cx + fw + 26, headY - fh, cx, headY - fh - 4); ctx.fill();
  } else if (hairStyle === 2) { // balding, sideburns
    ctx.fillRect(cx - fw - 3, headY - 26, 10, 54); ctx.fillRect(cx + fw - 7, headY - 26, 10, 54);
    ctx.beginPath(); ctx.ellipse(cx, headY - 30, fw + 2, fh * 0.62, 0, Math.PI * 1.12, Math.PI * 1.88); ctx.quadraticCurveTo(cx, headY - fh * 0.98, cx - fw * 0.9, headY - 44); ctx.fill();
  } else { // slick
    ctx.beginPath(); ctx.ellipse(cx, headY - 12, fw + 2, fh - 2, 0, Math.PI, TAU); ctx.quadraticCurveTo(cx + 10, headY - fh * 0.5, cx - fw, headY - 12); ctx.fill();
  }
  // eye sockets
  const eyeY = headY - 4 + (rng() - 0.5) * 6, eyeDX = fw * 0.44;
  const eyes = [];
  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    const sg = ctx.createRadialGradient(ex, eyeY, 2, ex, eyeY, 24);
    sg.addColorStop(0, 'rgba(10,4,2,0.85)'); sg.addColorStop(1, 'rgba(10,4,2,0)');
    ctx.fillStyle = sg; ell(ctx, ex, eyeY, 24, 20); ctx.fill();
    ctx.fillStyle = '#e6e2d2'; ell(ctx, ex, eyeY, 11.5, 7.5); ctx.fill();
    ctx.strokeStyle = '#120806'; ctx.lineWidth = 2; ell(ctx, ex, eyeY, 11.5, 7.5); ctx.stroke();
    ctx.strokeStyle = '#1a100c'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(ex - s * 15, eyeY - 14 - rng() * 3); ctx.lineTo(ex + s * 13, eyeY - 17 + rng() * 6); ctx.stroke();
    eyes.push({ x: ex, y: eyeY });
  }
  // nose
  ctx.strokeStyle = 'rgba(40,20,10,0.55)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - 2, eyeY + 6); ctx.quadraticCurveTo(cx - 8, eyeY + 30, cx + 5, eyeY + 32); ctx.stroke();
  // mouth
  const my = headY + fh * 0.56;
  const mouth = Math.floor(rng() * 3);
  ctx.strokeStyle = '#2a0c0a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx - 17, my); ctx.quadraticCurveTo(cx, my + (mouth === 0 ? -5 : 4), cx + 17, my); ctx.stroke();
  if (mouth === 1) { // stitched shut
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0a0404';
    for (let x = -14; x <= 14; x += 7) { ctx.beginPath(); ctx.moveTo(cx + x, my - 6); ctx.lineTo(cx + x + 2, my + 7); ctx.stroke(); }
  } else if (mouth === 2) { // scratched out
    ctx.strokeStyle = 'rgba(8,4,2,0.9)'; ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.moveTo(cx - 26 + rng() * 10, my - 10 + rng() * 20); ctx.lineTo(cx + 16 + rng() * 10, my - 10 + rng() * 20); ctx.stroke(); }
  }
  // cheek hollows
  for (const s of [-1, 1]) {
    const g = ctx.createRadialGradient(cx + s * fw * 0.62, headY + 22, 2, cx + s * fw * 0.62, headY + 22, 22);
    g.addColorStop(0, 'rgba(20,8,4,0.45)'); g.addColorStop(1, 'rgba(20,8,4,0)');
    ctx.fillStyle = g; ell(ctx, cx + s * fw * 0.62, headY + 22, 14, 26); ctx.fill();
  }
  // varnish + craquelure
  ctx.fillStyle = 'rgba(70,50,10,0.22)'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(8,5,2,0.4)'; ctx.lineWidth = 0.7;
  for (let i = 0; i < 40; i++) {
    let x = rng() * W, y = rng() * H;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (rng() - 0.5) * 34; y += (rng() - 0.5) * 34; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  grain(ctx, W, H, 20, rng);
  // gilt frame
  const fr = 20;
  const fg = ctx.createLinearGradient(0, 0, W, H);
  fg.addColorStop(0, '#8a6c26'); fg.addColorStop(0.5, '#3a2a0c'); fg.addColorStop(1, '#6e5418');
  ctx.strokeStyle = fg; ctx.lineWidth = fr; ctx.strokeRect(fr / 2, fr / 2, W - fr, H - fr);
  ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 3; ctx.strokeRect(fr, fr, W - fr * 2, H - fr * 2);
  ctx.strokeStyle = 'rgba(255,220,130,0.25)'; ctx.lineWidth = 1.5; ctx.strokeRect(4, 4, W - 8, H - 8);
  ctx.fillStyle = 'rgba(255,220,130,0.22)';
  for (let i = 0; i < 14; i++) {
    ell(ctx, 18 + i * ((W - 36) / 13), fr / 2, 3, 3); ctx.fill();
    ell(ctx, 18 + i * ((W - 36) / 13), H - fr / 2, 3, 3); ctx.fill();
  }
  for (let i = 0; i < 17; i++) {
    ell(ctx, fr / 2, 18 + i * ((H - 36) / 16), 3, 3); ctx.fill();
    ell(ctx, W - fr / 2, 18 + i * ((H - 36) / 16), 3, 3); ctx.fill();
  }
  return { tex: toTex(c, false), eyes };
}

// ---------------------------------------------------------------------------
// Faces. Each monster's face is used on its head and, enlarged, for its jumpscare.
// ---------------------------------------------------------------------------

export const FACE_W = 384, FACE_H = 512;

function faceBase(ctx, w, h, light, dark) {
  const g = ctx.createRadialGradient(w / 2, h * 0.42, w * 0.08, w / 2, h * 0.5, w * 0.78);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

function socket(ctx, x, y, r, col = '0,0,0') {
  const g = ctx.createRadialGradient(x, y, r * 0.15, x, y, r);
  g.addColorStop(0, `rgba(${col},1)`); g.addColorStop(0.55, `rgba(${col},0.85)`); g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g; ell(ctx, x, y, r, r * 0.86); ctx.fill();
}

function drawConcierge(ctx, w, h, rng) {
  faceBase(ctx, w, h, '#c9c5b6', '#4b4a43');
  // slicked hair with a parting
  ctx.fillStyle = '#070707';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h * 0.2);
  ctx.quadraticCurveTo(w * 0.74, h * 0.07, w * 0.42, h * 0.1); ctx.quadraticCurveTo(w * 0.16, h * 0.12, 0, h * 0.24); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#3a3a38'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(w * 0.4, 0); ctx.lineTo(w * 0.43, h * 0.1); ctx.stroke();
  // sunken cheeks
  for (const s of [-1, 1]) {
    const g = ctx.createRadialGradient(w / 2 + s * w * 0.36, h * 0.6, 4, w / 2 + s * w * 0.36, h * 0.6, w * 0.26);
    g.addColorStop(0, 'rgba(20,20,18,0.75)'); g.addColorStop(1, 'rgba(20,20,18,0)');
    ctx.fillStyle = g; ell(ctx, w / 2 + s * w * 0.36, h * 0.6, w * 0.16, h * 0.24); ctx.fill();
  }
  // sockets and pinprick eyes
  for (const s of [-1, 1]) {
    const ex = w / 2 + s * w * 0.2, ey = h * 0.38;
    socket(ctx, ex, ey, w * 0.17);
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#fffdf0'; ell(ctx, ex + s * 2, ey + 2, 5, 5); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#111'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(ex - s * w * 0.13, ey - h * 0.1); ctx.quadraticCurveTo(ex, ey - h * 0.135, ex + s * w * 0.12, ey - h * 0.075); ctx.stroke();
  }
  // nose
  ctx.strokeStyle = 'rgba(30,30,28,0.6)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(w * 0.5, h * 0.4); ctx.lineTo(w * 0.47, h * 0.57); ctx.stroke();
  ctx.fillStyle = '#0a0a0a'; ell(ctx, w * 0.465, h * 0.585, 5, 3.5); ctx.fill(); ell(ctx, w * 0.535, h * 0.585, 5, 3.5); ctx.fill();
  // the grin: far too wide, cut up into the cheeks
  const grin = (t) => {
    const x = w * (0.07 + 0.86 * t);
    const y = h * (0.64 + 0.2 * Math.sin(Math.PI * t)) - (t < 0.08 || t > 0.92 ? h * 0.05 * (1 - Math.min(t, 1 - t) / 0.08) : 0);
    return [x, y];
  };
  ctx.fillStyle = '#120202';
  ctx.beginPath();
  for (let t = 0; t <= 1.001; t += 0.02) { const [x, y] = grin(t); t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  for (let t = 1; t >= -0.001; t -= 0.02) { const [x, y] = grin(t); ctx.lineTo(x, y - h * 0.035 * Math.sin(Math.PI * t)); }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#3a0606'; ctx.lineWidth = 6;
  ctx.beginPath();
  for (let t = 0; t <= 1.001; t += 0.02) { const [x, y] = grin(t); t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke();
  // stitches
  ctx.strokeStyle = '#050505'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  for (let t = 0.04; t < 0.98; t += 0.052) {
    const [x, y] = grin(t);
    const [x2, y2] = grin(t + 0.01);
    const a = Math.atan2(y2 - y, x2 - x) + Math.PI / 2 + (rng() - 0.5) * 0.4;
    const len = 16 + rng() * 8;
    const my = y - h * 0.017 * Math.sin(Math.PI * t);
    ctx.beginPath(); ctx.moveTo(x - Math.cos(a) * len, my - Math.sin(a) * len); ctx.lineTo(x + Math.cos(a) * len, my + Math.sin(a) * len); ctx.stroke();
    ctx.fillStyle = '#300'; ell(ctx, x - Math.cos(a) * len, my - Math.sin(a) * len, 2.5, 2.5); ctx.fill(); ell(ctx, x + Math.cos(a) * len, my + Math.sin(a) * len, 2.5, 2.5); ctx.fill();
  }
  // wrinkles
  ctx.strokeStyle = 'rgba(20,20,18,0.5)'; ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(w * 0.26, h * (0.2 + i * 0.022)); ctx.quadraticCurveTo(w * 0.5, h * (0.185 + i * 0.022), w * 0.74, h * (0.2 + i * 0.022)); ctx.stroke(); }
}

function drawMaid(ctx, w, h, rng) {
  faceBase(ctx, w, h, '#f0eee8', '#7d8088');
  // eyes: black pits
  const eyes = [];
  for (const s of [-1, 1]) {
    const ex = w / 2 + s * w * 0.19, ey = h * 0.4;
    socket(ctx, ex, ey, w * 0.19, '30,30,40');
    ctx.fillStyle = '#000';
    ell(ctx, ex, ey, w * 0.105, h * 0.058, s * 0.18); ctx.fill();
    ctx.strokeStyle = 'rgba(120,125,140,0.35)'; ctx.lineWidth = 2;
    ell(ctx, ex, ey + 2, w * 0.03, w * 0.03); ctx.stroke();
    eyes.push([ex, ey]);
    // thin sad brows
    ctx.strokeStyle = '#1a1a1e'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(ex - s * w * 0.1, ey - h * 0.085); ctx.quadraticCurveTo(ex, ey - h * 0.11, ex + s * w * 0.11, ey - h * 0.07); ctx.stroke();
  }
  // tear streaks
  for (const [ex, ey] of eyes) {
    for (let k = 0; k < 4; k++) {
      let x = ex + (k - 1.5) * w * 0.045, y = ey + h * 0.035;
      const end = h * (0.72 + rng() * 0.28);
      ctx.strokeStyle = `rgba(0,0,0,${0.55 + rng() * 0.4})`;
      ctx.lineWidth = 2 + rng() * 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, y);
      while (y < end) { y += 12 + rng() * 14; x += (rng() - 0.5) * 7; ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.fillStyle = '#000'; ell(ctx, x, y, 4, 6); ctx.fill();
    }
  }
  // nose
  ctx.fillStyle = 'rgba(40,40,50,0.55)'; ell(ctx, w * 0.47, h * 0.585, 4, 3); ctx.fill(); ell(ctx, w * 0.53, h * 0.585, 4, 3); ctx.fill();
  // mouth: a small dark wail
  ctx.fillStyle = '#060304'; ell(ctx, w / 2, h * 0.745, w * 0.085, h * 0.062); ctx.fill();
  ctx.strokeStyle = '#3a2a30'; ctx.lineWidth = 4; ell(ctx, w / 2, h * 0.745, w * 0.085, h * 0.062); ctx.stroke();
  ctx.fillStyle = '#000'; ctx.fillRect(w * 0.49, h * 0.79, 6, h * 0.14);
  // hair curtains
  ctx.fillStyle = '#050506';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    const x0 = s < 0 ? 0 : w;
    ctx.moveTo(x0, 0); ctx.lineTo(w / 2, 0);
    ctx.bezierCurveTo(w / 2 + s * w * 0.26, h * 0.06, w / 2 + s * w * 0.4, h * 0.3, w / 2 + s * w * 0.35, h * 0.62);
    ctx.bezierCurveTo(w / 2 + s * w * 0.33, h * 0.8, w / 2 + s * w * 0.4, h * 0.92, w / 2 + s * w * 0.36, h);
    ctx.lineTo(x0, h); ctx.closePath(); ctx.fill();
  }
  // stray strands
  ctx.strokeStyle = '#050506';
  for (let i = 0; i < 9; i++) {
    ctx.lineWidth = 1 + rng() * 2.5;
    const x = w * (0.2 + rng() * 0.6);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + (rng() - 0.5) * 60, h * 0.3, x + (rng() - 0.5) * 80, h * 0.6, x + (rng() - 0.5) * 90, h * (0.6 + rng() * 0.4)); ctx.stroke();
  }
  // frilled cap
  ctx.fillStyle = '#d9d6cc';
  for (let i = 0; i < 9; i++) { ell(ctx, w * (0.18 + i * 0.08), h * 0.035, w * 0.045, h * 0.035); ctx.fill(); }
  ctx.fillRect(w * 0.16, 0, w * 0.68, h * 0.03);
}

function drawBellhop(ctx, w, h, rng) {
  faceBase(ctx, w, h, '#aab092', '#3e4434');
  // hat
  ctx.fillStyle = '#8c1016'; ctx.fillRect(0, 0, w, h * 0.2);
  ctx.fillStyle = '#5c080c'; ctx.fillRect(0, h * 0.165, w, h * 0.035);
  ctx.fillStyle = '#c9a43c'; ctx.fillRect(0, h * 0.07, w, h * 0.022);
  ctx.fillStyle = '#c9a43c'; ell(ctx, w / 2, h * 0.125, 9, 9); ctx.fill();
  // chin strap
  ctx.strokeStyle = '#0c0c0c'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(w * 0.04, h * 0.2); ctx.bezierCurveTo(w * 0.02, h * 0.7, w * 0.3, h * 0.99, w * 0.5, h * 0.985); ctx.bezierCurveTo(w * 0.7, h * 0.99, w * 0.98, h * 0.7, w * 0.96, h * 0.2); ctx.stroke();
  // bulging eyes
  for (const s of [-1, 1]) {
    const ex = w / 2 + s * w * 0.22, ey = h * 0.36, r = w * 0.135;
    socket(ctx, ex, ey, r * 1.5, '20,26,14');
    ctx.fillStyle = '#e8e6d0'; ell(ctx, ex, ey, r, r); ctx.fill();
    ctx.strokeStyle = 'rgba(160,20,20,0.75)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      let x = ex + Math.cos(a) * r, y = ey + Math.sin(a) * r;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += -Math.cos(a) * r * 0.2 + (rng() - 0.5) * 8; y += -Math.sin(a) * r * 0.2 + (rng() - 0.5) * 8; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.fillStyle = '#000'; ell(ctx, ex - s * r * 0.3, ey + r * 0.12, r * 0.2, r * 0.2); ctx.fill();
    ctx.strokeStyle = '#14180e'; ctx.lineWidth = 5; ell(ctx, ex, ey, r, r); ctx.stroke();
  }
  // nose slits
  ctx.fillStyle = '#0c0f08'; ell(ctx, w * 0.47, h * 0.5, 3, 9, 0.2); ctx.fill(); ell(ctx, w * 0.53, h * 0.5, 3, 9, -0.2); ctx.fill();
  // mouth
  const mx = w * 0.15, mw = w * 0.7, my = h * 0.555, mh = h * 0.375;
  const mg = ctx.createRadialGradient(w / 2, my + mh / 2, 6, w / 2, my + mh / 2, mw * 0.6);
  mg.addColorStop(0, '#000'); mg.addColorStop(0.7, '#1c0204'); mg.addColorStop(1, '#5a0a10');
  ctx.fillStyle = mg;
  ctx.beginPath(); ctx.roundRect(mx, my, mw, mh, [mw * 0.2, mw * 0.2, mw * 0.46, mw * 0.46]); ctx.fill();
  ctx.strokeStyle = '#2c0406'; ctx.lineWidth = 8; ctx.stroke();
  // teeth: too many rows
  const tooth = (x, y, tw, th, down) => {
    ctx.fillStyle = `rgb(${205 + rng() * 40},${195 + rng() * 35},${140 + rng() * 40})`;
    ctx.beginPath();
    ctx.moveTo(x - tw / 2, y); ctx.lineTo(x + tw / 2, y);
    ctx.lineTo(x + tw * 0.12 + (rng() - 0.5) * 3, y + (down ? th : -th)); ctx.lineTo(x - tw * 0.12, y + (down ? th : -th) * 0.94);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(60,30,10,0.5)'; ctx.lineWidth = 1; ctx.stroke();
  };
  for (let row = 0; row < 3; row++) {
    const n = 15 - row * 3, inset = row * mw * 0.07;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = mx + inset + t * (mw - inset * 2);
      const arch = Math.sin(Math.PI * t);
      tooth(x, my + 8 + row * 16 - (1 - arch) * 4, (mw / n) * 0.92, (26 - row * 5) * (0.7 + rng() * 0.6), true);
      tooth(x, my + mh - 8 - row * 16 - (1 - arch) * mh * 0.34, (mw / n) * 0.92, (26 - row * 5) * (0.7 + rng() * 0.6), false);
    }
  }
  // drool
  ctx.strokeStyle = 'rgba(210,220,190,0.5)'; ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) { const x = mx + mw * (0.2 + rng() * 0.6); ctx.beginPath(); ctx.moveTo(x, my + 30); ctx.lineTo(x + (rng() - 0.5) * 6, my + mh - 30); ctx.stroke(); }
}

function drawManager(ctx, w, h, rng) {
  faceBase(ctx, w, h, '#57514b', '#0b0a09');
  // hair with a widow's peak
  ctx.fillStyle = '#020202';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h * 0.22);
  ctx.quadraticCurveTo(w * 0.78, h * 0.08, w * 0.5, h * 0.17); ctx.quadraticCurveTo(w * 0.22, h * 0.08, 0, h * 0.22); ctx.closePath(); ctx.fill();
  // cracks
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  for (let i = 0; i < 9; i++) {
    let x = w * (0.1 + rng() * 0.8), y = h * (0.12 + rng() * 0.2);
    ctx.lineWidth = 1 + rng() * 2.5;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 7; k++) { x += (rng() - 0.5) * 44; y += 10 + rng() * 34; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // brows: heavy wedges
  ctx.fillStyle = '#000';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(w / 2 + s * w * 0.05, h * 0.375); ctx.lineTo(w / 2 + s * w * 0.4, h * 0.25); ctx.lineTo(w / 2 + s * w * 0.42, h * 0.3); ctx.lineTo(w / 2 + s * w * 0.06, h * 0.41);
    ctx.closePath(); ctx.fill();
  }
  // eyes: red slits
  for (const s of [-1, 1]) {
    const ex = w / 2 + s * w * 0.21, ey = h * 0.4;
    socket(ctx, ex, ey, w * 0.2);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(s * -0.3);
    ctx.shadowColor = '#ff1500'; ctx.shadowBlur = 34;
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, w * 0.1);
    g.addColorStop(0, '#fff3c0'); g.addColorStop(0.25, '#ff5a1a'); g.addColorStop(1, '#8a0000');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(-w * 0.1, 0); ctx.quadraticCurveTo(0, -h * 0.034, w * 0.1, 0); ctx.quadraticCurveTo(0, h * 0.034, -w * 0.1, 0); ctx.fill(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#000'; ell(ctx, 0, 0, 3, h * 0.022); ctx.fill();
    ctx.restore();
  }
  // nose shadow
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath(); ctx.moveTo(w * 0.5, h * 0.44); ctx.lineTo(w * 0.44, h * 0.6); ctx.lineTo(w * 0.56, h * 0.6); ctx.closePath(); ctx.fill();
  // pencil moustache
  ctx.strokeStyle = '#000'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(w * 0.34, h * 0.665); ctx.quadraticCurveTo(w * 0.5, h * 0.635, w * 0.66, h * 0.665); ctx.stroke();
  // rictus
  const my = h * 0.77;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.moveTo(w * 0.14, my + 10); ctx.quadraticCurveTo(w * 0.5, my - 34, w * 0.86, my + 10); ctx.quadraticCurveTo(w * 0.5, my + 74, w * 0.14, my + 10); ctx.fill();
  ctx.save(); ctx.clip();
  ctx.fillStyle = '#cfc7b0';
  for (let i = 0; i < 26; i++) {
    const x = w * (0.15 + (i / 25) * 0.7);
    const len = 20 + rng() * 18;
    ctx.beginPath(); ctx.moveTo(x - 4, my - 30); ctx.lineTo(x + 4, my - 30); ctx.lineTo(x + (rng() - 0.5) * 3, my - 12 + len * 0.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 4, my + 70); ctx.lineTo(x + 4, my + 70); ctx.lineTo(x + (rng() - 0.5) * 3, my + 44 - len * 0.5); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = '#1a0000'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(w * 0.14, my + 10); ctx.quadraticCurveTo(w * 0.5, my - 34, w * 0.86, my + 10); ctx.quadraticCurveTo(w * 0.5, my + 74, w * 0.14, my + 10); ctx.stroke();
}

function drawPorter(ctx, w, h) {
  faceBase(ctx, w, h, '#d9b99a', '#7a5a44');
  ctx.fillStyle = '#5a0f18'; ctx.fillRect(0, 0, w, h * 0.2);
  ctx.fillStyle = '#c9a43c'; ctx.fillRect(0, h * 0.16, w, h * 0.03);
  for (const s of [-1, 1]) {
    const ex = w / 2 + s * w * 0.19, ey = h * 0.42;
    ctx.fillStyle = 'rgba(60,30,30,0.45)'; ell(ctx, ex, ey + 12, w * 0.1, h * 0.05); ctx.fill();
    ctx.fillStyle = '#f2efe6'; ell(ctx, ex, ey, w * 0.075, h * 0.036); ctx.fill();
    ctx.fillStyle = '#1c1410'; ell(ctx, ex, ey, w * 0.03, w * 0.03); ctx.fill();
    ctx.strokeStyle = '#2a1a12'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(ex - w * 0.09, ey - h * 0.06); ctx.lineTo(ex + w * 0.09, ey - h * 0.065); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(80,40,30,0.7)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(w * 0.5, h * 0.45); ctx.lineTo(w * 0.47, h * 0.6); ctx.lineTo(w * 0.52, h * 0.61); ctx.stroke();
  ctx.strokeStyle = '#4a1a14'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(w * 0.38, h * 0.76); ctx.quadraticCurveTo(w * 0.5, h * 0.74, w * 0.62, h * 0.76); ctx.stroke();
}

const FACE_DRAW = { concierge: drawConcierge, maid: drawMaid, bellhop: drawBellhop, manager: drawManager, porter: drawPorter };
const faceCache = new Map();

/** Returns the (cached) face canvas for a monster type. */
export function faceCanvas(type) {
  if (faceCache.has(type)) return faceCache.get(type);
  const c = mk(FACE_W, FACE_H), ctx = c.getContext('2d');
  const rng = mulberry32(0xface00 + type.length * 977 + type.charCodeAt(0));
  FACE_DRAW[type](ctx, FACE_W, FACE_H, rng);
  grain(ctx, FACE_W, FACE_H, 22, rng);
  faceCache.set(type, c);
  return c;
}

function torso(type) {
  const W = 128, H = 192;
  const c = mk(W, H), ctx = c.getContext('2d');
  const shirtV = (col) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(W * 0.3, 0); ctx.lineTo(W * 0.7, 0); ctx.lineTo(W * 0.5, H * 0.5); ctx.closePath(); ctx.fill();
  };
  if (type === 'concierge') {
    ctx.fillStyle = '#0b0b0d'; ctx.fillRect(0, 0, W, H);
    shirtV('#cfcabb');
    ctx.fillStyle = '#060606';
    ctx.beginPath(); ctx.moveTo(W * 0.5, 14); ctx.lineTo(W * 0.3, 2); ctx.lineTo(W * 0.3, 28); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(W * 0.5, 14); ctx.lineTo(W * 0.7, 2); ctx.lineTo(W * 0.7, 28); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#b89a3c';
    for (let i = 0; i < 3; i++) { ell(ctx, W * 0.5, H * 0.58 + i * 22, 4, 4); ctx.fill(); }
    ctx.strokeStyle = '#1e1e22'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W * 0.3, 0); ctx.lineTo(W * 0.5, H * 0.5); ctx.lineTo(W * 0.7, 0); ctx.stroke();
  } else if (type === 'maid') {
    ctx.fillStyle = '#0c0c10'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d6d2c6'; ctx.fillRect(W * 0.22, H * 0.12, W * 0.56, H * 0.88);
    for (let i = 0; i < 8; i++) { ell(ctx, W * 0.22, H * 0.14 + i * 22, 7, 11); ctx.fill(); ell(ctx, W * 0.78, H * 0.14 + i * 22, 7, 11); ctx.fill(); }
    ctx.fillStyle = 'rgba(70,6,6,0.75)';
    ell(ctx, W * 0.56, H * 0.5, 16, 24, 0.4); ctx.fill(); ell(ctx, W * 0.4, H * 0.76, 9, 16); ctx.fill();
    ctx.fillStyle = '#d6d2c6'; ctx.fillRect(W * 0.3, 0, W * 0.4, 12);
  } else if (type === 'bellhop' || type === 'porter') {
    ctx.fillStyle = type === 'bellhop' ? '#8c1016' : '#5a0f18'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#c9a43c';
    for (let i = 0; i < 6; i++) { ell(ctx, W * 0.36, 18 + i * 30, 5, 5); ctx.fill(); ell(ctx, W * 0.64, 18 + i * 30, 5, 5); ctx.fill(); }
    ctx.strokeStyle = '#c9a43c'; ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(W * 0.36, 18 + i * 30); ctx.lineTo(W * 0.64, 18 + i * 30); ctx.stroke(); }
    ctx.fillStyle = '#0c0c0c'; ctx.fillRect(0, 0, W, 8);
  } else {
    ctx.fillStyle = '#17171b'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(150,150,160,0.16)'; ctx.lineWidth = 1;
    for (let x = 4; x < W; x += 9) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    shirtV('#bdb8aa');
    ctx.fillStyle = '#7a0a0a';
    ctx.beginPath(); ctx.moveTo(W * 0.45, 4); ctx.lineTo(W * 0.55, 4); ctx.lineTo(W * 0.58, H * 0.42); ctx.lineTo(W * 0.5, H * 0.5); ctx.lineTo(W * 0.42, H * 0.42); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c9a43c'; ctx.fillRect(W * 0.66, H * 0.3, 30, 12);
    ctx.fillStyle = '#17100a'; ctx.font = 'bold 7px Arial'; ctx.fillText('MANAGER', W * 0.67, H * 0.3 + 9);
  }
  return toTex(c, false);
}

export function nameTag(text, color = '#e8dcc0') {
  const W = 256, H = 64;
  const c = mk(W, H), ctx = c.getContext('2d');
  ctx.font = 'bold 30px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(text, W / 2, H / 2);
  ctx.fillStyle = color; ctx.fillText(text, W / 2, H / 2);
  return toTex(c, false);
}

// ---------------------------------------------------------------------------

let cached = null;

/** Builds every shared texture once. */
export function getTextures() {
  if (cached) return cached;
  const t = {};
  t.hallWall = wallpaper({ base: '#4d0f1b', stripe: '#430c17', motif: '#6e1c2a', motifDark: '#2c060d' }, 11);
  t.roomWall = wallpaper({ base: '#3f4636', stripe: '#374030', motif: '#59604a', motifDark: '#252b1f' }, 23);
  t.hallFloor = carpet(31, { base: '#5c1017', dark: '#3a090d', line: '#9a7430' });
  t.roomFloor = planks(47);
  t.ceiling = ceiling(53);
  t.wood = wood(61, '#2c170c', '#070301');
  t.woodLight = wood(67, '#4a2a16', '#120803');
  t.door = doorLeaf(71);
  t.wardrobe = wardrobeFront(73);
  t.sheet = fabric(79, '#a9a493', 'rgba(70,50,20,0.25)', null);
  t.blanket = fabric(83, '#4a1018', 'rgba(0,0,0,0.3)', '#7a5a22');
  t.metal = metal(89);
  t.keycard = keycard();
  t.glow = glow();
  t.noExit = noExit(97);
  t.elevSign = sign('ELEVATOR', '#f0d890', '#14100a');
  t.blood = [0, 1, 2, 3].map((v) => blood(v, 101 + v * 7));
  t.portraits = [];
  for (let i = 0; i < 8; i++) t.portraits.push(portrait(211 + i * 13));
  t.faces = {};
  t.torsos = {};
  for (const type of ['concierge', 'maid', 'bellhop', 'manager', 'porter']) {
    t.faces[type] = toTex(faceCanvas(type), false);
    t.torsos[type] = torso(type);
  }
  t.plate = plate;
  cached = t;
  return t;
}

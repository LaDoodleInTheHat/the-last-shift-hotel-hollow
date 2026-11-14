// ui.js - menus, HUD, the typewriter intro, the jumpscare and the spectator map. Plain DOM.
import { GRID, CELL, T, idx } from './maze.js';
import { faceCanvas, FACE_W, FACE_H } from './textures.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['title', 'menu', 'lobby', 'pause', 'death', 'win'];
const INTRO = `It's 3:17 AM.
You are the night porter at the Hotel Hollow.
The front doors have vanished. The guests have all checked out.
But the staff never left.
And the floor plan changes every time you wake up.`;

export function formatTime(s) {
  if (!Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export function getBest(diff) {
  try { const v = parseFloat(localStorage.getItem('tls_best_' + diff)); return Number.isFinite(v) ? v : null; } catch { return null; }
}

export function saveBest(diff, time) {
  const prev = getBest(diff);
  if (prev !== null && prev <= time) return false;
  try { localStorage.setItem('tls_best_' + diff, String(time)); } catch { /* private mode */ }
  return true;
}

function stored(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key, v) { try { localStorage.setItem(key, v); } catch { /* private mode */ } }

export class UI {
  /** handlers: callbacks into the game (see main.js) */
  constructor(h, audio) {
    this.h = h;
    this.audio = audio;
    this.screen = 'title';
    this.diff = stored('tls_diff', 'normal');
    if (!['easy', 'normal', 'nightmare'].includes(this.diff)) this.diff = 'normal';
    this.introState = 'wait'; // wait -> typing -> done
    this.introTimer = null;
    this.mapStatic = null;
    this.mapHotel = null;
    this.bigMap = false;
    this.last = {};

    $('name-input').value = stored('tls_name', '');
    const click = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); this.audio.init(); this.audio.play('click'); fn(e); });

    $('screen-title').addEventListener('click', () => this.advanceIntro());
    window.addEventListener('keydown', (e) => { if (this.screen === 'title' && (e.code === 'Enter' || e.code === 'Space')) this.advanceIntro(); });

    for (const b of $('diff-seg').querySelectorAll('button')) {
      b.addEventListener('click', () => { this.audio.play('click'); this.setDiff(b.dataset.diff); });
    }
    for (const b of $('lobby-diff').querySelectorAll('button')) {
      b.addEventListener('click', () => { if (!b.disabled) { this.audio.play('click'); this.h.onLobbyDiff(b.dataset.diff); } });
    }
    this.setDiff(this.diff);

    click('btn-solo', () => this.h.onSolo(this.diff, $('seed-input').value.trim()));
    click('btn-create', () => { this.menuError(''); this.h.onCreate(this.playerName(), this.diff); });
    click('btn-join', () => {
      const code = $('code-input').value.trim().toUpperCase();
      if (code.length !== 4) return this.menuError('Enter the 4-letter shift code.');
      this.menuError('');
      this.h.onJoin(this.playerName(), code);
    });
    $('code-input').addEventListener('keydown', (e) => { if (e.code === 'Enter') $('btn-join').click(); });
    click('btn-start', () => this.h.onStartCoop());
    click('btn-leave', () => this.h.onLeave());
    click('btn-voice', () => this.h.onVoice());
    click('btn-resume', () => this.h.onResume());
    click('btn-quit', () => this.h.onMenu());
    click('btn-retry', () => this.h.onRetry());
    click('btn-spectate', () => this.h.onSpectate());
    click('btn-menu', () => this.h.onMenu());
    click('btn-again', () => this.h.onRetry());
    click('btn-win-menu', () => this.h.onMenu());

    // keep game keys from leaking into text fields and vice versa
    for (const el of document.querySelectorAll('input')) {
      el.addEventListener('keydown', (e) => e.stopPropagation());
      el.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.refreshBest();
  }

  playerName() {
    const n = $('name-input').value.trim().slice(0, 14) || 'Porter';
    store('tls_name', n);
    return n;
  }

  setDiff(d) {
    this.diff = d;
    store('tls_diff', d);
    for (const b of $('diff-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.diff === d);
  }

  refreshBest() {
    const rows = [['easy', 'Easy'], ['normal', 'Normal'], ['nightmare', 'Nightmare']]
      .map(([k, label]) => { const b = getBest(k); return `${label}: <b>${b === null ? '—' : formatTime(b)}</b>`; });
    $('best-times').innerHTML = 'BEST TIMES &nbsp; ' + rows.join(' &nbsp;·&nbsp; ');
  }

  menuError(msg) { $('menu-error').textContent = msg || ''; }

  show(name) {
    this.screen = name;
    for (const s of SCREENS) $('screen-' + s).classList.toggle('hidden', s !== name);
    if (name === 'menu') this.refreshBest();
  }

  fade(on) { $('fade').classList.toggle('on', on); }

  // --- title / typewriter ---------------------------------------------------
  advanceIntro() {
    if (this.screen !== 'title') return;
    this.audio.init();
    const el = $('intro'), press = $('press');
    if (this.introState === 'wait') {
      this.introState = 'typing';
      press.classList.add('hidden');
      let i = 0;
      const step = () => {
        if (this.introState !== 'typing') return;
        i++;
        el.textContent = INTRO.slice(0, i);
        const ch = INTRO[i - 1];
        if (ch && ch.trim()) this.audio.play('type');
        if (i >= INTRO.length) return this.finishIntro();
        this.introTimer = setTimeout(step, ch === '\n' ? 520 : ch === '.' ? 260 : 34 + Math.random() * 30);
      };
      step();
    } else if (this.introState === 'typing') {
      this.finishIntro();
    } else {
      this.audio.play('click');
      this.h.onIntroDone();
    }
  }

  finishIntro() {
    clearTimeout(this.introTimer);
    this.introState = 'done';
    $('intro').textContent = INTRO;
    const press = $('press');
    press.textContent = 'CLICK TO BEGIN YOUR SHIFT';
    press.classList.remove('hidden');
  }

  // --- lobby ------------------------------------------------------------------
  setLobby({ code, players, isHost, diff, micOn, micMuted, micLevel, micError }) {
    $('lobby-code').textContent = code;
    const rows = players.map((p) =>
      `<div class="lp${p.talking ? ' talk' : ''}"><div>${escapeHtml(p.name)}${p.self ? ' <small>(you)</small>' : ''}<em class="${p.voiceOk ? 'ok' : ''}">${escapeHtml(p.voice || '')}</em></div><span>${p.host ? 'HOST' : ''}</span></div>`).join('');
    if (rows !== this.last.lobbyRows) { this.last.lobbyRows = rows; $('lobby-players').innerHTML = rows; }
    for (const b of $('lobby-diff').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.diff === diff);
      b.disabled = !isHost;
    }
    $('btn-start').classList.toggle('hidden', !isHost);
    $('lobby-wait').classList.toggle('hidden', isHost);
    const vb = $('btn-voice');
    const label = micOn ? (micMuted ? 'MICROPHONE MUTED — CLICK TO UNMUTE' : 'MICROPHONE LIVE — CLICK TO MUTE') : 'ENABLE MICROPHONE';
    if (vb.textContent !== label) vb.textContent = label;
    vb.classList.toggle('on', !!micOn && !micMuted);
    $('lobby-mic').classList.toggle('hidden', !micOn);
    $('lobby-mic-level').style.width = Math.min(100, (micLevel || 0) * 450) + '%';
    const hint = micError ? micError + ' You can still hear the others.'
      : 'Voices carry about 25 metres and are muffled through walls. Headphones recommended. The Bellhop can hear you too.';
    if (this.last.voiceHint !== hint) { this.last.voiceHint = hint; $('voice-hint').textContent = hint; }
  }

  // --- HUD ----------------------------------------------------------------------
  showHUD(on) {
    $('hud').classList.toggle('hidden', !on);
  }

  setHUD({ battery, flashlightOn, stamina, keys, rockets, objective }) {
    const L = this.last;
    const b = Math.ceil(battery);
    if (L.battery !== b || L.fl !== flashlightOn) {
      L.battery = b; L.fl = flashlightOn;
      $('battery-bar').style.width = b + '%';
      $('battery-bar').classList.toggle('low', b < 20);
      $('battery-pct').textContent = b + '%';
      $('battery-meter').style.opacity = flashlightOn ? 1 : 0.55;
    }
    const st = Math.round(stamina * 50);
    if (L.st !== st) { L.st = st; $('stamina-bar').style.width = (st * 2) + '%'; }
    if (L.keys !== keys) {
      L.keys = keys;
      $('hud-keys').innerHTML = [0, 1, 2, 3, 4].map((i) => `<i class="${i < keys ? 'got' : ''}"></i>`).join('');
    }
    if (L.rockets !== rockets) { L.rockets = rockets; $('hud-rockets').textContent = rockets > 0 ? '▲'.repeat(Math.min(rockets, 8)) : '—'; }
    if (L.obj !== objective) { L.obj = objective; $('hud-objective').textContent = objective; }
  }

  prompt(key, text) {
    const v = text ? key + '|' + text : '';
    if (this.last.prompt === v) return;
    this.last.prompt = v;
    $('hud-prompt').innerHTML = text ? `<b>${key}</b>${escapeHtml(text)}` : '';
  }

  toast(text, cls = '', ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.style.setProperty('--life', ms + 'ms');
    el.textContent = text;
    const box = $('toasts');
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => el.remove(), ms);
  }

  setHidden(on) { $('slats').classList.toggle('hidden', !on); }

  /** A short red line of advice, lower centre. */
  warn(text) {
    const el = $('hud-warn');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.warnTimer);
    this.warnTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  /**
   * The porter's own map: only what you have walked past is drawn, but keycards are marked.
   * o: { me:{x,z,yaw}, keys:[{x,z}], mates:[{x,z}], elevUnlocked }
   */
  drawMini(hotel, explored, o) {
    const cv = $('minimap'), ctx = cv.getContext('2d');
    const S = cv.width, px = S / GRID;
    ctx.clearRect(0, 0, S, S);
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const k = idx(x, y);
      if (!explored[k]) continue;
      const t = hotel.grid[k];
      ctx.fillStyle = t === T.HALL ? '#7a2c35' : t === T.ROOM ? '#4d5c3e' : t === T.DOOR ? '#c9a84f' : o.elevUnlocked ? '#40ff70' : '#c02020';
      ctx.fillRect(x * px, y * px, px, px);
    }
    const w2m = (v) => (v / CELL) * px;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
    const e = hotel.elevator;
    if (o.elevUnlocked) {
      const ex = (e.x + 0.5) * px, ey = (e.y + 0.5) * px;
      ctx.fillStyle = '#40ff70'; ctx.fillRect(e.x * px, e.y * px, px, px);
      ctx.strokeStyle = `rgba(64,255,112,${0.9 - pulse * 0.6})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ex, ey, 5 + pulse * 7, 0, Math.PI * 2); ctx.stroke();
    }
    for (const k of o.keys) {
      const x = w2m(k.x), y = w2m(k.z);
      ctx.strokeStyle = `rgba(255,224,138,${0.8 - pulse * 0.6})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 4 + pulse * 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffe08a'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    for (const m of o.mates) { ctx.fillStyle = '#6ad0ff'; ctx.beginPath(); ctx.arc(w2m(m.x), w2m(m.z), 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.save();
    ctx.translate(w2m(o.me.x), w2m(o.me.z)); ctx.rotate(-o.me.yaw);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(4.5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4.5, 5); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  setPlayers(list) {
    const el = $('hud-players');
    if (!list || !list.length) { el.classList.add('hidden'); this.last.players = ''; return; }
    const html = list.map((p) =>
      `<div class="pl${p.alive ? '' : ' dead'}${p.talking ? ' talk' : ''}">${escapeHtml(p.name)}${p.self ? ' <small>you</small>' : ''}${p.host ? ' <small>host</small>' : ''}</div>`).join('');
    if (html !== this.last.players) { this.last.players = html; el.innerHTML = html; }
    el.classList.remove('hidden');
  }

  setMic(state, level = 0) {
    const el = $('hud-mic');
    if (!state) { el.classList.add('hidden'); this.last.mic = ''; return; }
    el.classList.remove('hidden');
    if (this.last.mic !== state) {
      this.last.mic = state;
      el.classList.toggle('muted', state === 'muted');
      el.innerHTML = state === 'off' ? 'MIC OFF &nbsp;— press V to talk' : state === 'muted' ? 'MIC MUTED &nbsp;[V]' : 'MIC LIVE &nbsp;[V]<i><b id="mic-level"></b></i>';
    }
    const lv = $('mic-level');
    if (lv) lv.style.width = Math.min(100, level * 500) + '%';
  }

  // --- end screens ----------------------------------------------------------------
  showDeath({ cause, stats, coop, isHost, canSpectate }) {
    $('death-cause').textContent = cause;
    $('death-stats').textContent = stats || '';
    $('btn-retry').classList.toggle('hidden', coop && !isHost);
    $('death-wait').classList.toggle('hidden', !(coop && !isHost));
    $('btn-spectate').classList.toggle('hidden', !canSpectate);
    $('btn-menu').textContent = coop ? 'LEAVE SHIFT' : 'MAIN MENU';
    this.show('death');
  }

  showWin({ title, time, keys, rockets, best, newBest, diffLabel, seed, note, coop, isHost }) {
    $('win-title').textContent = title;
    $('win-time').textContent = formatTime(time);
    $('win-keys').textContent = `${keys} / 5`;
    $('win-rockets').textContent = String(rockets);
    $('win-diff').textContent = `(${diffLabel})`;
    $('win-best').textContent = (best === null ? '—' : formatTime(best)) + (newBest ? '  ★ NEW' : '');
    $('win-seed').textContent = String(seed);
    $('win-note').textContent = note || '';
    $('btn-again').classList.toggle('hidden', coop && !isHost);
    $('win-wait').classList.toggle('hidden', !(coop && !isHost));
    $('btn-win-menu').textContent = coop ? 'LEAVE SHIFT' : 'MAIN MENU';
    this.show('win');
  }

  setPauseHint(text) { $('pause-hint').textContent = text; }

  /** Full-screen face. Resolves when the scare is over. */
  jumpscare(type) {
    const wrap = $('jumpscare'), cv = $('scare-canvas');
    cv.width = FACE_W; cv.height = FACE_H;
    cv.getContext('2d').drawImage(faceCanvas(type), 0, 0);
    wrap.classList.remove('hidden');
    cv.style.animation = 'none';
    void cv.offsetWidth; // restart the CSS animation
    cv.style.animation = '';
    return new Promise((resolve) => setTimeout(() => { wrap.classList.add('hidden'); resolve(); }, 950));
  }

  // --- spectator ------------------------------------------------------------------
  setSpectate(on, { sub = '', buttons = [] } = {}) {
    $('spectate').classList.toggle('hidden', !on);
    if (!on) return;
    $('spec-sub').textContent = sub;
    const box = $('spec-buttons');
    box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '');
      el.textContent = b.label;
      el.addEventListener('click', (e) => { e.stopPropagation(); this.audio.play('click'); b.fn(); });
      box.appendChild(el);
    }
  }

  toggleBigMap() {
    this.bigMap = !this.bigMap;
    $('spectate').classList.toggle('big', this.bigMap);
  }

  /**
   * Top-down map for spectators.
   * ents: { players:[{x,z,name,alive,self}], monsters:[{x,z,name,color,active,state}], pickups:[{x,z,type}], cam:{x,z,yaw}, elevUnlocked }
   */
  drawMap(hotel, ents) {
    const cv = $('map'), ctx = cv.getContext('2d');
    const S = cv.width, px = S / GRID;
    if (this.mapHotel !== hotel) {
      this.mapHotel = hotel;
      const st = this.mapStatic = document.createElement('canvas');
      st.width = st.height = S;
      const c = st.getContext('2d');
      c.fillStyle = '#060404'; c.fillRect(0, 0, S, S);
      for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
        const t = hotel.grid[idx(x, y)];
        if (t === T.WALL) continue;
        c.fillStyle = t === T.HALL ? '#4a1a20' : t === T.ROOM ? '#2c3526' : t === T.DOOR ? '#b9953a' : '#2a6a3a';
        c.fillRect(x * px, y * px, px + 0.5, px + 0.5);
      }
      c.fillStyle = 'rgba(232,220,192,0.55)'; c.font = `${Math.floor(px * 0.9)}px Georgia`; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const r of hotel.rooms) c.fillText(String(r.number), (r.x0 + r.w / 2) * px, (r.y0 + r.h / 2) * px);
    }
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.mapStatic, 0, 0);
    const w2m = (v) => (v / CELL) * px;
    const dot = (x, z, r, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(w2m(x), w2m(z), r, 0, Math.PI * 2); ctx.fill(); };
    const label = (x, z, text, col) => {
      ctx.font = 'bold 11px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.strokeText(text, w2m(x), w2m(z) - 7);
      ctx.fillStyle = col; ctx.fillText(text, w2m(x), w2m(z) - 7);
    };
    // elevator
    const e = hotel.elevator;
    ctx.fillStyle = ents.elevUnlocked ? '#40ff70' : '#a02020';
    ctx.fillRect(e.x * px, e.y * px, px, px);
    label((e.x + 0.5) * CELL, (e.y + 0.5) * CELL, 'ELEVATOR', ents.elevUnlocked ? '#8dffa6' : '#ff8a8a');
    for (const p of ents.pickups) dot(p.x, p.z, p.type === 'key' ? 4 : 2.5, p.type === 'key' ? '#ffe08a' : p.type === 'battery' ? '#62e07a' : '#ff8a4a');
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 160);
    for (const m of ents.monsters) {
      if (!m.active) continue;
      ctx.globalAlpha = 0.25 * pulse; dot(m.x, m.z, 11, m.color); ctx.globalAlpha = 1;
      dot(m.x, m.z, 5, m.color);
      label(m.x, m.z, m.name, m.color);
    }
    for (const p of ents.players) {
      if (!p.alive) continue;
      dot(p.x, p.z, 4.5, '#6ad0ff');
      label(p.x, p.z, p.name, '#bfe9ff');
    }
    // spectator camera
    const c = ents.cam;
    ctx.save();
    ctx.translate(w2m(c.x), w2m(c.z)); ctx.rotate(-c.yaw);
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  setLegend(html) { if (this.last.legend !== html) { this.last.legend = html; $('spec-legend').innerHTML = html; } }

  fatal(msg) {
    const el = $('fatal');
    el.textContent = 'The hotel failed to open.\n\n' + msg;
    el.classList.remove('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

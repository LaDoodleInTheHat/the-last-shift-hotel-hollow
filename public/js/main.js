// main.js - game state, player controller, co-op glue and the frame loop.
import * as THREE from 'three';
import { generateHotel, hashSeed, CELL, GRID, WALL_H, T, idx, inBounds, lineOfSight } from './maze.js';
import { World } from './render.js';
import { MonsterManager, MONSTER_INFO } from './monsters.js';
import { AudioEngine } from './audio.js';
import { Net } from './net.js';
import { Voice } from './voice.js';
import { UI, getBest, saveBest, formatTime } from './ui.js';

const DIFFS = {
  easy: { label: 'Easy', monsterSpeed: 0.85, managerSpeed: 2.9, drain: 0.8, startRockets: 2, powerMin: 80, powerMax: 140, stunMul: 1.35, grace: 25 },
  normal: { label: 'Normal', monsterSpeed: 1.0, managerSpeed: 3.4, drain: 1.0, startRockets: 1, powerMin: 60, powerMax: 120, stunMul: 1, grace: 18 },
  nightmare: { label: 'Nightmare', monsterSpeed: 1.14, managerSpeed: 3.8, drain: 1.3, startRockets: 0, powerMin: 45, powerMax: 90, stunMul: 0.75, grace: 10 },
};
const DEATH_LINES = {
  concierge: 'The Concierge has attended to you.',
  maid: 'The Maid has turned down your bed.',
  bellhop: 'The Bellhop has collected your luggage.',
  manager: 'The Manager has accepted your resignation.',
};
const PLAYER_R = 0.35, EYE = 1.62, EYE_CROUCH = 1.02;
const WALK = 2.7, SPRINT = 4.7, CROUCH = 1.4;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;

const canvas = document.getElementById('game');
const keys = new Set();
let world, audio, net, ui, voice = null;

const game = {
  mode: 'menu',            // menu | playing | dead | spectating | ended
  coop: false, hotel: null, cfg: DIFFS.normal, diff: 'normal', lobbyDiff: 'normal', seed: 0,
  monsters: null, pickups: new Map(), keys: 0, time: 0, clock: 0,
  over: false, dying: false, deathBy: null,
  elevUnlocked: false, managerAt: -1, managerAnnounced: false,
  nextPower: 90, powerUntil: -1,
  paused: false, locked: false,
  rockets: [], remotes: new Map(),
  seesMaid: false, maidT: 0, sendT: 0, monT: 0, hudT: 0, shake: 0, flash: 0, fear: 0,
};

const me = {
  id: 'local', name: 'Porter', x: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, eye: EYE,
  alive: true, hidden: null, crouch: false, stamina: 1, staminaDelay: 0, exhausted: false,
  battery: 100, flashOn: true, flashLevel: 1, rockets: 0, rocketsUsed: 0,
  bob: 0, speed: 0, moveNoise: 0, noiseBurst: 0, noise: 0, swayX: 0, swayY: 0, prevYaw: 0, prevPitch: 0,
};
const spec = { x: 0, y: 12, z: 0, yaw: 0, pitch: -1, target: -1 };
const tmpV = new THREE.Vector3();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const doorClosed = (c) => world.isDoorClosed(c);
const isHost = () => !game.coop || net.isHost;
const inGame = () => game.mode !== 'menu';

// ---------------------------------------------------------------------------
// Collision: circle vs wall cells + furniture / door-jamb boxes
// ---------------------------------------------------------------------------
let cx_ = 0, cz_ = 0;
function pushOut(x0, z0, x1, z1) {
  const nx = clamp(cx_, x0, x1), nz = clamp(cz_, z0, z1);
  const dx = cx_ - nx, dz = cz_ - nz, d2 = dx * dx + dz * dz;
  if (d2 >= PLAYER_R * PLAYER_R) return;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    cx_ = nx + (dx / d) * PLAYER_R; cz_ = nz + (dz / d) * PLAYER_R;
  } else {
    const l = cx_ - x0, r = x1 - cx_, t = cz_ - z0, b = z1 - cz_, m = Math.min(l, r, t, b);
    if (m === l) cx_ = x0 - PLAYER_R; else if (m === r) cx_ = x1 + PLAYER_R; else if (m === t) cz_ = z0 - PLAYER_R; else cz_ = z1 + PLAYER_R;
  }
}

function solidCell(x, y) {
  if (!inBounds(x, y)) return true;
  const t = game.hotel.grid[idx(x, y)];
  return t === T.WALL || (t === T.ELEV && !game.elevUnlocked);
}

function collide(x, z) {
  cx_ = x; cz_ = z;
  for (let iter = 0; iter < 2; iter++) {
    const cx = Math.floor(cx_ / CELL), cy = Math.floor(cz_ / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (solidCell(cx + dx, cy + dy)) pushOut((cx + dx) * CELL, (cy + dy) * CELL, (cx + dx + 1) * CELL, (cy + dy + 1) * CELL);
    }
    const list = inBounds(cx, cy) ? game.hotel.colliderGrid.get(idx(cx, cy)) : null;
    if (list) for (const c of list) pushOut(c.x0, c.z0, c.x1, c.z1);
  }
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------
function cleanupGame() {
  if (game.monsters) { game.monsters.dispose(); game.monsters = null; }
  for (const r of game.rockets) world.dyn.remove(r.mesh);
  game.rockets.length = 0;
  for (const r of game.remotes.values()) dropVisuals(r);
  ui.setSpectate(false);
  ui.setHidden(false);
  ui.showHUD(false);
  ui.prompt('', '');
  world.setSpectate(false);
  world.setFear(0); world.setScreenFlash(0);
  if (audio.ready) audio.silenceMonsters();
}

function setBackdrop() {
  cleanupGame();
  game.mode = 'menu';
  game.over = false; game.paused = false; game.elevUnlocked = false;
  const hotel = game.hotel = generateHotel(randomSeed());
  world.buildHotel(hotel);
  me.x = hotel.start.x; me.z = hotel.start.z;
  me.yaw = Math.atan2(-hotel.startFacing.x, -hotel.startFacing.z);
  me.pitch = 0;
  audio.setAmbience(false);
  ui.setPlayers(null); ui.setMic(null);
}

function startGame(seed, diff, opts = {}) {
  cleanupGame();
  game.seed = seed >>> 0;
  game.diff = DIFFS[diff] ? diff : 'normal';
  game.cfg = DIFFS[game.diff];
  const hotel = game.hotel = generateHotel(game.seed);
  world.buildHotel(hotel);
  game.monsters = new MonsterManager(world, hotel, game.cfg);
  game.pickups = new Map(hotel.pickups.map((p) => [p.id, p]));
  game.keys = 0; game.time = opts.elapsed || 0;
  game.over = false; game.dying = false; game.deathBy = null; game.paused = false;
  game.elevUnlocked = false; game.managerAt = -1; game.managerAnnounced = false;
  game.nextPower = game.time + rand(game.cfg.powerMin, game.cfg.powerMax); game.powerUntil = -1;
  game.seesMaid = false; game.shake = 0; game.flash = 0; game.fear = 0;
  world.setElevatorUnlocked(false);

  Object.assign(me, {
    id: game.coop ? net.id : 'local', x: hotel.start.x, z: hotel.start.z,
    yaw: Math.atan2(-hotel.startFacing.x, -hotel.startFacing.z), pitch: 0, vx: 0, vz: 0, eye: EYE,
    alive: true, hidden: null, crouch: false, stamina: 1, staminaDelay: 0, exhausted: false,
    battery: 100, flashOn: true, flashLevel: 1, rockets: game.cfg.startRockets, rocketsUsed: 0,
    bob: 0, speed: 0, moveNoise: 0, noiseBurst: 0, noise: 0, swayX: 0, swayY: 0,
  });
  me.prevYaw = me.yaw; me.prevPitch = 0;

  for (const id of opts.picked || []) takePickup(id, null, true);
  for (const r of game.remotes.values()) {
    Object.assign(r, { x: hotel.start.x, z: hotel.start.z, tx: hotel.start.x, tz: hotel.start.z, alive: true, hidden: false, got: false, noise: 0, seesMaid: false, fl: false });
    addVisuals(r);
  }

  game.mode = 'playing';
  ui.show(null);
  ui.showHUD(true);
  ui.last = {};
  audio.init();
  audio.resume();
  audio.setAmbience(true);
  ui.fade(true);
  setTimeout(() => ui.fade(false), 350);
  ui.toast('3:17 AM', '', 3200);
  setTimeout(() => { if (game.mode === 'playing') ui.toast('Find the five master keycards. Do not be found.', 'small', 5000); }, 1800);
  lockPointer();
}

function lockPointer() {
  if (document.pointerLockElement === canvas) return;
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { if (ui.screen === 'pause') ui.setPauseHint('Click once more to take the flashlight back.'); });
  } catch { /* pointer lock unavailable: arrow keys still turn */ }
}

function setPaused(p) {
  game.paused = p;
  if (p) audio.suspend(); else audio.resume();
}

function leaveToMenu() {
  if (document.pointerLockElement) document.exitPointerLock();
  if (game.coop) {
    net.leave();
    if (voice) { voice.dispose(); voice = null; }
    for (const r of game.remotes.values()) dropVisuals(r);
    game.remotes.clear();
    game.coop = false;
  }
  setPaused(false);
  setBackdrop();
  ui.show('menu');
}

// ---------------------------------------------------------------------------
// Pickups, elevator, power
// ---------------------------------------------------------------------------
function takePickup(id, byName, silent) {
  const p = game.pickups.get(id);
  if (!p) return null;
  game.pickups.delete(id);
  world.removePickup(id);
  if (p.type === 'key') {
    game.keys++;
    if (!silent) {
      ui.toast(`${byName ? byName + ' found a keycard' : 'MASTER KEYCARD'}  ${game.keys} / 5`, byName ? 'small' : '');
      audio.play('key');
    }
    if (game.keys >= 5 && !game.elevUnlocked) unlockElevator(silent);
  }
  return p;
}

function collect(p) {
  takePickup(p.id, null, false);
  if (p.type === 'battery') {
    me.battery = Math.min(100, me.battery + 45);
    audio.play('battery'); ui.toast('Battery  +45%', 'small', 1800);
  } else if (p.type === 'rocket') {
    me.rockets++;
    audio.play('rocketPickup'); ui.toast('Signal rocket', 'small', 1800);
  }
  if (game.coop) net.event('pickup', { pid: p.id });
}

function unlockElevator(silent) {
  game.elevUnlocked = true;
  world.setElevatorUnlocked(true);
  game.managerAt = game.time + (silent ? 0.5 : 5);
  if (!silent) {
    setTimeout(() => { if (inGame()) { audio.play('elevDing'); ui.toast('THE ELEVATOR IS UNLOCKED', '', 5000); } }, 1200);
  }
}

function startPower(dur) {
  game.powerUntil = game.time + dur;
  world.setPower(true);
  audio.play('powerDown');
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
function nearWardrobe() {
  let best = null, bd = 1.25;
  for (const room of game.hotel.rooms) {
    const w = room.wardrobe;
    const depth = w.front.x !== 0 ? w.sx : w.sz;
    const fx = w.x + w.front.x * (depth / 2 + 0.5), fz = w.z + w.front.z * (depth / 2 + 0.5);
    const d = Math.hypot(me.x - fx, me.z - fz);
    if (d < bd) { bd = d; best = w; }
  }
  return best;
}

function hide(w) {
  me.hidden = w;
  me.x = w.x; me.z = w.z; me.vx = me.vz = 0;
  me.yaw = Math.atan2(-w.front.x, -w.front.z); me.pitch = 0;
  audio.play('hide');
  ui.setHidden(true);
}

function unhide() {
  const w = me.hidden;
  if (!w) return;
  const depth = w.front.x !== 0 ? w.sx : w.sz;
  me.x = w.x + w.front.x * (depth / 2 + 0.5); me.z = w.z + w.front.z * (depth / 2 + 0.5);
  me.hidden = null;
  audio.play('hide');
  ui.setHidden(false);
}

function interact() {
  if (game.mode !== 'playing' || !me.alive || game.over) return;
  if (me.hidden) return unhide();
  const w = nearWardrobe();
  if (w) hide(w);
}

function toggleFlashlight() {
  if (game.mode !== 'playing' || !me.alive) return;
  if (me.battery <= 0) { audio.play('empty'); ui.toast('The flashlight is dead. Find a battery.', 'small', 2000); return; }
  me.flashOn = !me.flashOn;
  audio.play('toggle');
}

function updatePlayer(dt) {
  const t = game.time;
  // arrow keys turn too (useful where pointer lock is unavailable)
  const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
  const look = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
  me.yaw += turn * 2.2 * dt;
  me.pitch = clamp(me.pitch + look * 1.6 * dt, -1.45, 1.45);

  if (!me.hidden) {
    let f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    let s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const moving = f !== 0 || s !== 0;
    const len = Math.hypot(f, s) || 1; f /= len; s /= len;
    me.crouch = keys.has('KeyC') || keys.has('ControlLeft');
    const wantSprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const sprinting = wantSprint && moving && !me.crouch && !me.exhausted && me.stamina > 0 && f > -0.1;
    if (sprinting) {
      me.stamina = Math.max(0, me.stamina - dt / 6.5); me.staminaDelay = 0.9;
      if (me.stamina <= 0) me.exhausted = true;
    } else {
      me.staminaDelay -= dt;
      if (me.staminaDelay <= 0) me.stamina = Math.min(1, me.stamina + dt / 8);
      if (me.stamina > 0.3) me.exhausted = false;
    }
    const speed = me.crouch ? CROUCH : sprinting ? SPRINT : WALK;
    const sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
    const tvx = (-sy * f + cy * s) * speed, tvz = (-cy * f - sy * s) * speed;
    const k = Math.min(1, dt * 12);
    me.vx += (tvx - me.vx) * k; me.vz += (tvz - me.vz) * k;
    const ox = me.x, oz = me.z;
    collide(me.x + me.vx * dt, me.z + me.vz * dt);
    me.x = cx_; me.z = cz_;
    const moved = Math.hypot(me.x - ox, me.z - oz);
    me.speed = moved / Math.max(dt, 1e-4);
    const prevBob = me.bob;
    me.bob += moved * (me.crouch ? 2.7 : sprinting ? 1.9 : 2.2);
    if (Math.floor(me.bob / Math.PI) !== Math.floor(prevBob / Math.PI)) audio.step(me.crouch ? 'crouch' : sprinting ? 'sprint' : 'walk');
    me.moveNoise = me.speed < 0.5 || me.crouch ? 0 : sprinting ? 11 : 3.5;

    // pickups
    for (const p of game.pickups.values()) {
      const r = p.type === 'key' ? 1.5 : 1.25;
      const dx = p.x - me.x, dz = p.z - me.z;
      if (dx * dx + dz * dz < r * r) { collect(p); break; }
    }
    // prompts
    const w = nearWardrobe();
    const e = game.hotel.elevator;
    const ex = (e.hallX + 0.5) * CELL + e.dx * CELL / 2, ez = (e.hallY + 0.5) * CELL + e.dy * CELL / 2;
    if (w) ui.prompt('E', 'Hide in the wardrobe');
    else if (!game.elevUnlocked && Math.hypot(me.x - ex, me.z - ez) < 2.4) ui.prompt('LOCKED', `Needs all five master keycards (${game.keys}/5)`);
    else ui.prompt('', '');
    // the way out
    const c = idx(Math.floor(me.x / CELL), Math.floor(me.z / CELL));
    if (game.elevUnlocked && game.hotel.grid[c] === T.ELEV) win();
  } else {
    me.speed = 0; me.moveNoise = 0;
    ui.prompt('E', 'Climb out');
  }

  // flashlight
  let level = 0;
  if (me.flashOn && me.battery > 0 && !me.hidden) {
    me.battery = Math.max(0, me.battery - game.cfg.drain * dt);
    level = 1;
    if (me.battery < 20) {
      const n = Math.sin(t * 41) + Math.sin(t * 17.3) + Math.sin(t * 5.1);
      level = n > 0.9 + (me.battery / 20) * 1.4 ? 0.12 : 0.55 + (me.battery / 20) * 0.45;
    }
    if (me.battery <= 0) { me.flashOn = false; level = 0; audio.play('empty'); ui.toast('Your flashlight has died.', 'bad', 3000); }
  }
  me.flashLevel = level;
  // beam sway: lags behind the view and bobs with each step
  let dyaw = me.yaw - me.prevYaw;
  if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
  const dpitch = me.pitch - me.prevPitch;
  me.prevYaw = me.yaw; me.prevPitch = me.pitch;
  const ks = Math.min(1, dt * 6);
  me.swayX += (clamp((dyaw / Math.max(dt, 1e-3)) * 0.28, -1.3, 1.3) - me.swayX) * ks;
  me.swayY += (clamp((-dpitch / Math.max(dt, 1e-3)) * 0.28, -1, 1) - me.swayY) * ks;
  const mv = Math.min(1, me.speed / WALK);
  world.setFlashlight(level, me.swayX + Math.sin(me.bob) * 0.13 * mv, me.swayY + Math.cos(me.bob * 2) * 0.07 * mv + Math.sin(t * 0.9) * 0.02);

  me.noiseBurst = Math.max(0, me.noiseBurst - dt);
  const voiceNoise = voice && voice.talking ? Math.min(13, 5 + voice.level * 60) : 0;
  me.noise = Math.max(me.moveNoise, voiceNoise, me.noiseBurst > 0 ? 16 : 0);
}

function updateSpectator(dt) {
  const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
  const look = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
  spec.yaw += turn * 2 * dt;
  spec.pitch = clamp(spec.pitch + look * 1.5 * dt, -1.55, 1.55);
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const u = (keys.has('Space') ? 1 : 0) - (keys.has('KeyC') || keys.has('ControlLeft') ? 1 : 0);
  const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 24 : 9) * dt;
  const sy = Math.sin(spec.yaw), cy = Math.cos(spec.yaw), cp = Math.cos(spec.pitch), spn = Math.sin(spec.pitch);
  spec.x += (-sy * cp * f + cy * s) * sp;
  spec.z += (-cy * cp * f - sy * s) * sp;
  spec.y += (spn * f + u) * sp;
  const size = GRID * CELL;
  spec.x = clamp(spec.x, -25, size + 25); spec.z = clamp(spec.z, -25, size + 25); spec.y = clamp(spec.y, 0.4, 70);
}

function specTargets() {
  const list = [];
  if (me.alive) list.push({ x: me.x, z: me.z });
  for (const r of game.remotes.values()) if (r.alive) list.push({ x: r.x, z: r.z });
  if (game.monsters) for (const m of game.monsters.list) if (m.active) list.push({ x: m.x, z: m.z });
  return list;
}

function specCycle() {
  const list = specTargets();
  if (!list.length) return;
  spec.target = (spec.target + 1) % list.length;
  const t = list[spec.target];
  spec.x = t.x; spec.z = t.z + 5.5; spec.y = 9; spec.yaw = 0; spec.pitch = -1.02;
}

function enterSpectate() {
  if (!game.hotel || game.mode === 'menu') return;
  game.mode = 'spectating';
  if (me.hidden) { me.hidden = null; ui.setHidden(false); }
  world.setSpectate(true);
  Object.assign(spec, { x: me.x, y: 13, z: me.z + 7, yaw: 0, pitch: -1.05, target: -1 });
  ui.show(null);
  ui.showHUD(false);
  refreshSpectateUI();
  lockPointer();
}

function refreshSpectateUI() {
  if (game.mode !== 'spectating') return;
  const buttons = [];
  const canRestart = !game.coop || (game.over && net.isHost);
  if (canRestart) buttons.push({ label: game.coop ? 'OPEN A NEW SHIFT' : 'CLOCK IN AGAIN', primary: true, fn: () => handlers.onRetry() });
  buttons.push({ label: game.coop ? 'LEAVE SHIFT' : 'MAIN MENU', fn: () => handlers.onMenu() });
  const sub = game.over ? 'The shift has ended. The hotel is still open.' : game.coop ? 'Your colleagues are still working. Only the dead can hear you now.' : 'The hotel carries on without you.';
  ui.setSpectate(true, { sub, buttons });
  ui.setLegend(
    '<div><i style="background:#6ad0ff"></i>Porters</div>' +
    Object.values(MONSTER_INFO).map((m) => `<div><i style="background:#${m.color.toString(16).padStart(6, '0')}"></i>${m.name}</div>`).join('') +
    '<div><i style="background:#ffe08a"></i>Keycards</div><div><i style="background:#62e07a"></i>Batteries</div><div><i style="background:#ff8a4a"></i>Rockets</div>');
}

// ---------------------------------------------------------------------------
// Rockets
// ---------------------------------------------------------------------------
function spawnRocket(x, y, z, dx, dy, dz, owned, ownerId) {
  game.rockets.push({ mesh: world.makeRocketMesh(), x, y, z, dx, dy, dz, life: 0, owned, ownerId });
}

function fireRocket() {
  if (game.mode !== 'playing' || !me.alive || me.hidden || game.over || game.dying) return;
  if (me.rockets <= 0) { audio.play('empty'); ui.toast('No rockets.', 'small', 1200); return; }
  me.rockets--; me.rocketsUsed++;
  world.camera.getWorldDirection(tmpV);
  const d = { x: tmpV.x, y: tmpV.y, z: tmpV.z };
  const p = world.camera.position;
  const x = p.x + d.x * 0.45, y = p.y + d.y * 0.45 - 0.12, z = p.z + d.z * 0.45;
  spawnRocket(x, y, z, d.x, d.y, d.z, true, me.id);
  audio.play('launch');
  me.noiseBurst = 0.7;
  if (game.coop) net.event('rocket', { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3) });
}

function rocketHits(r) {
  if (r.y < 0.07 || r.y > WALL_H - 0.07) return true;
  const cx = Math.floor(r.x / CELL), cy = Math.floor(r.z / CELL);
  if (!inBounds(cx, cy)) return true;
  const c = idx(cx, cy), t = game.hotel.grid[c];
  if (t === T.WALL || (t === T.ELEV && !game.elevUnlocked)) return true;
  if (t === T.DOOR && world.isDoorClosed(c)) return true;
  if (game.monsters) for (const m of game.monsters.list) {
    if (m.active && r.y < m.info.eye + 0.45 && Math.hypot(m.x - r.x, m.z - r.z) < 0.6) return true;
  }
  return false;
}

function applyBoom(x, y, z) {
  world.explode(x, y, z);
  audio.play('boom', x, y, z);
  const cam = world.camera.position;
  const d = Math.hypot(cam.x - x, cam.z - z);
  game.shake = Math.max(game.shake, clamp(1 - d / 16, 0, 1));
  if (d < 9) game.flash = Math.max(game.flash, 0.5 * (1 - d / 9));
  if (isHost() && game.monsters) {
    const hit = game.monsters.boom(x, z, doorClosed);
    if (hit.length) audio.play('stun');
  }
}

function updateRockets(dt) {
  for (let i = game.rockets.length - 1; i >= 0; i--) {
    const r = game.rockets[i];
    let remaining = 26 * dt, hit = false;
    while (remaining > 0 && !hit) {
      const s = Math.min(0.25, remaining);
      r.x += r.dx * s; r.y += r.dy * s; r.z += r.dz * s;
      remaining -= s;
      hit = rocketHits(r);
    }
    r.life += dt;
    if (r.life > 3) hit = true;
    r.mesh.position.set(r.x, r.y, r.z);
    r.mesh.lookAt(r.x + r.dx, r.y + r.dy, r.z + r.dz);
    for (let k = 0; k < 3; k++) {
      world.particles.emit(r.x - r.dx * 0.3, r.y - r.dy * 0.3, r.z - r.dz * 0.3, (Math.random() - 0.5) * 1.6 - r.dx * 2, (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6 - r.dz * 2, 0.5, 1, 0.6, 0.2, 2);
    }
    if (!hit) world.fxFlash(r.x, r.y, r.z, 34, 14, 0xff9a40);
    else {
      world.dyn.remove(r.mesh);
      game.rockets.splice(i, 1);
      if (r.owned) {
        const bx = r.x - r.dx * 0.35, by = clamp(r.y - r.dy * 0.35, 0.3, WALL_H - 0.3), bz = r.z - r.dz * 0.35;
        applyBoom(bx, by, bz);
        if (game.coop) net.event('boom', { x: +bx.toFixed(2), y: +by.toFixed(2), z: +bz.toFixed(2) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Death, spectating, winning
// ---------------------------------------------------------------------------
const anyoneAlive = () => me.alive || [...game.remotes.values()].some((r) => r.alive);

function die(type) {
  if (!me.alive || game.dying) return;
  me.alive = false;
  game.dying = true;
  game.deathBy = type;
  if (me.hidden) { me.hidden = null; ui.setHidden(false); }
  ui.showHUD(false);
  ui.prompt('', '');
  world.setFlashlight(0);
  audio.scream(type);
  if (game.coop) net.event('dead', { by: type });
  ui.jumpscare(type).then(() => {
    game.dying = false;
    if (game.mode === 'menu') return;
    audio.play('death');
    if (game.coop && anyoneAlive()) {
      enterSpectate();
      ui.toast('YOUR SHIFT IS OVER', 'bad', 4000);
    } else {
      finishLost();
    }
  });
}

function deathStats() {
  return `Keycards ${game.keys}/5  ·  ${formatTime(game.time)} on shift  ·  Seed ${game.seed}`;
}

function finishLost() {
  if (game.over) return;
  game.over = true;
  if (game.mode === 'playing') game.mode = 'dead';
  if (game.coop && net.isHost) net.event('end');
  if (document.pointerLockElement) document.exitPointerLock();
  ui.showHUD(false);
  const cause = game.coop
    ? (game.deathBy ? DEATH_LINES[game.deathBy] + ' ' : '') + 'No one is left on shift.'
    : DEATH_LINES[game.deathBy] || 'The hotel has taken you.';
  ui.showDeath({ cause, stats: deathStats(), coop: game.coop, isHost: isHost(), canSpectate: true });
  refreshSpectateUI();
}

function finishWin(time, byMe, winnerName) {
  if (game.over) return;
  game.over = true;
  const survived = me.alive;
  if (game.mode === 'playing') game.mode = 'ended';
  if (document.pointerLockElement) document.exitPointerLock();
  ui.showHUD(false);
  ui.setHidden(false);
  ui.setSpectate(false);
  world.setSpectate(false);
  let newBest = false;
  if (survived) newBest = saveBest(game.diff, time);
  audio.play('win');
  ui.showWin({
    title: survived ? (game.coop ? 'THE NIGHT SHIFT CLOCKED OUT' : 'YOU SURVIVED THE SHIFT') : 'YOUR COLLEAGUES CLOCKED OUT',
    time, keys: game.keys, rockets: me.rocketsUsed, best: getBest(game.diff), newBest,
    diffLabel: game.cfg.label, seed: game.seed, coop: game.coop, isHost: isHost(),
    note: survived ? (game.coop && !byMe ? `${winnerName} reached the elevator and held the doors.` : 'The elevator doors close. Somewhere below, a bell rings once.') : 'You did not. The hotel keeps what it is owed.',
  });
}

function win() {
  if (game.over || !me.alive) return;
  const time = game.time;
  if (game.coop) { net.event('win', { time: +time.toFixed(1) }); net.event('end'); }
  finishWin(time, true, me.name);
}

// ---------------------------------------------------------------------------
// Co-op
// ---------------------------------------------------------------------------
function addRemote(id, name) {
  if (id === net.id || game.remotes.has(id)) return;
  const s = game.hotel ? game.hotel.start : { x: 0, z: 0 };
  const r = { id, name, x: s.x, z: s.z, yaw: 0, pitch: 0, tx: s.x, tz: s.z, tyaw: 0, tpitch: 0, fl: false, alive: true, hidden: false, crouch: false, noise: 0, seesMaid: false, got: false, avatar: null, beacon: null };
  game.remotes.set(id, r);
  if (inGame()) addVisuals(r);
}

function addVisuals(r) {
  if (!r.avatar) r.avatar = world.createAvatar(r.name);
  if (!r.beacon) r.beacon = world.makeBeacon(0x6ad0ff, r.name);
}

function dropVisuals(r) {
  if (r.avatar) { r.avatar.dispose(); r.avatar = null; }
  if (r.beacon) { r.beacon.dispose(); r.beacon = null; }
}

function refreshLobby() {
  if (!game.coop) return;
  const players = [...net.players.values()].map((p) => ({ name: p.name, self: p.id === net.id, host: p.id === net.hostId }));
  ui.setLobby({ code: net.code, players, isHost: net.isHost, diff: game.lobbyDiff, micOn: voice && voice.micOn, micError: voice && voice.error });
}

function updateRemotes(dt) {
  const k = Math.min(1, dt * 12);
  for (const r of game.remotes.values()) {
    r.x += (r.tx - r.x) * k; r.z += (r.tz - r.z) * k;
    let dy = r.tyaw - r.yaw;
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    r.yaw += dy * k; r.pitch += (r.tpitch - r.pitch) * k;
    if (r.avatar) r.avatar.update(dt, { x: r.x, z: r.z, yaw: r.yaw, pitch: r.pitch, fl: r.fl, alive: r.alive && r.got, hidden: r.hidden, crouch: r.crouch });
    if (r.beacon) r.beacon.set(r.x, r.z, r.alive && r.got);
  }
}

function setupNet() {
  net.on('joined', (m) => {
    game.coop = true;
    me.id = net.id;
    me.name = net.nameOf(net.id);
    game.lobbyDiff = m.diff;
    for (const r of game.remotes.values()) dropVisuals(r);
    game.remotes.clear();
    if (voice) voice.dispose();
    voice = new Voice(net, audio);
    for (const p of m.players) if (p.id !== net.id) { addRemote(p.id, p.name); voice.addPeer(p.id); }
    if (m.started) startGame(m.seed, m.diff, { picked: m.picked, elapsed: m.elapsed });
    else { ui.show('lobby'); refreshLobby(); }
  });
  net.on('error', (m) => ui.menuError(m.msg));
  net.on('peer-join', (m) => {
    addRemote(m.id, m.name);
    if (voice) voice.addPeer(m.id);
    refreshLobby();
    if (inGame()) ui.toast(`${m.name} clocked in`, 'small', 2500);
  });
  net.on('peer-leave', (m) => {
    const r = game.remotes.get(m.id);
    if (r) { dropVisuals(r); game.remotes.delete(m.id); }
    if (voice) voice.removePeer(m.id);
    refreshLobby();
    if (inGame()) {
      ui.toast(`${m.name} left the building`, 'small', 2500);
      if (!game.over && !game.dying && !anyoneAlive()) finishLost();
    }
  });
  net.on('host', () => {
    refreshLobby();
    refreshSpectateUI();
    if (net.isHost) ui.toast('You are now the shift supervisor (host).', 'small', 3500);
    if (game.over && ui.screen === 'death') ui.showDeath({ cause: 'No one is left on shift.', stats: deathStats(), coop: true, isHost: net.isHost, canSpectate: true });
  });
  net.on('diff', (m) => { game.lobbyDiff = m.diff; refreshLobby(); });
  net.on('start', (m) => startGame(m.seed, m.diff));
  net.on('state', (m) => {
    const r = game.remotes.get(m.id);
    if (!r) return;
    r.tx = m.x; r.tz = m.z; r.tyaw = m.y; r.tpitch = m.p;
    r.fl = !!m.f; r.alive = !!m.a; r.hidden = !!m.h; r.crouch = !!m.c; r.noise = m.n || 0; r.seesMaid = !!m.m;
    if (!r.got) { r.x = m.x; r.z = m.z; r.yaw = m.y; r.got = true; }
  });
  net.on('mon', (m) => { if (!net.isHost && game.monsters) game.monsters.applyNet(m.m); });
  net.on('rtc', (m) => { if (voice) voice.handleSignal(m.from, m.d); });
  net.on('ev', (m) => {
    if (!inGame()) return;
    const name = net.nameOf(m.id);
    switch (m.k) {
      case 'pickup': takePickup(m.pid, name, false); break;
      case 'rocket': spawnRocket(m.x, m.y, m.z, m.dx, m.dy, m.dz, false, m.id); audio.play('launch'); break;
      case 'boom':
        for (let i = game.rockets.length - 1; i >= 0; i--) {
          if (game.rockets[i].ownerId === m.id) { world.dyn.remove(game.rockets[i].mesh); game.rockets.splice(i, 1); }
        }
        applyBoom(m.x, m.y, m.z);
        break;
      case 'power': startPower(m.dur); break;
      case 'dead': {
        const r = game.remotes.get(m.id);
        if (r) r.alive = false;
        ui.toast(`${name} — ${(MONSTER_INFO[m.by] || { name: 'the hotel' }).name.toLowerCase()}`, 'bad', 4000);
        if (!game.over && !game.dying && !anyoneAlive()) finishLost();
        break;
      }
      case 'win': finishWin(m.time, false, name); break;
      default: break;
    }
  });
  net.on('closed', (m) => {
    if (!m.wasInRoom && !game.coop) return;
    if (voice) { voice.dispose(); voice = null; }
    for (const r of game.remotes.values()) dropVisuals(r);
    game.remotes.clear();
    game.coop = false;
    if (document.pointerLockElement) document.exitPointerLock();
    setPaused(false);
    setBackdrop();
    ui.show('menu');
    ui.menuError('Connection to the hotel was lost.');
  });
}

const handlers = {
  onIntroDone: () => ui.show('menu'),
  onSolo: (diff, seedStr) => {
    game.coop = false;
    startGame(seedStr ? hashSeed(seedStr) : randomSeed(), diff);
  },
  onCreate: (name, diff) => { me.name = name; net.createRoom(name, diff).catch((e) => ui.menuError(e.message)); },
  onJoin: (name, code) => { me.name = name; net.joinRoom(code, name).catch((e) => ui.menuError(e.message)); },
  onLobbyDiff: (d) => { if (net.isHost) net.send({ t: 'diff', diff: d }); },
  onStartCoop: () => { if (net.isHost) net.start(game.lobbyDiff); },
  onLeave: () => leaveToMenu(),
  onMenu: () => leaveToMenu(),
  onRetry: () => {
    if (game.coop) { if (net.isHost) net.start(game.diff); } else startGame(randomSeed(), game.diff);
  },
  onSpectate: () => enterSpectate(),
  onResume: () => lockPointer(),
  onVoice: async () => {
    if (!voice) return;
    await voice.enableMic();
    refreshLobby();
  },
};

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------
function playerStates() {
  const list = [{ id: me.id, x: me.x, z: me.z, alive: me.alive, hidden: !!me.hidden, noise: me.noise, seesMaid: game.seesMaid }];
  for (const r of game.remotes.values()) if (r.got) list.push({ id: r.id, x: r.x, z: r.z, alive: r.alive, hidden: r.hidden, noise: r.noise, seesMaid: r.seesMaid });
  return list;
}

function checkSeesMaid() {
  const m = game.monsters.byType.maid;
  if (!m.active || !me.alive || me.hidden || game.mode !== 'playing') return false;
  const cam = world.camera;
  const d = Math.hypot(m.x - cam.position.x, m.z - cam.position.z);
  if (d > 34) return false;
  cam.updateMatrixWorld();
  projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  sphere.center.set(m.x, 1.0, m.z); sphere.radius = 0.75;
  if (!frustum.intersectsSphere(sphere)) return false;
  return lineOfSight(game.hotel.grid, me.x, me.z, m.x, m.z, doorClosed);
}

const actors = [];
function tick(dt) {
  game.clock += dt;
  const cam = world.camera;
  if (game.mode === 'menu') {
    me.yaw += dt * 0.07;
    cam.position.set(me.x, 1.6, me.z);
    cam.rotation.set(Math.sin(game.clock * 0.3) * 0.05, me.yaw, 0);
    world.setFlashlight(0.9 + Math.sin(game.clock * 23) * 0.03, Math.sin(game.clock * 0.6) * 0.3, Math.sin(game.clock * 0.9) * 0.15);
    world.update(dt, game.clock, cam.position, actors);
    return;
  }
  const t = (game.time += game.over ? 0 : dt);
  const host = isHost();

  if (game.mode === 'playing' && me.alive && !game.dying) updatePlayer(dt);
  else if (game.mode === 'spectating') updateSpectator(dt);
  updateRemotes(dt);

  // --- host: power failures and the Manager's arrival
  const states = playerStates();
  if (host && !game.over) {
    if (game.powerUntil < 0 && t >= game.nextPower) {
      const dur = rand(5, 10);
      startPower(dur);
      if (game.coop) net.event('power', { dur: +dur.toFixed(1) });
      game.nextPower = t + dur + rand(game.cfg.powerMin, game.cfg.powerMax);
    }
    if (game.elevUnlocked && game.managerAt >= 0 && t >= game.managerAt && !game.monsters.manager.active) game.monsters.spawnManager(states);
  }
  if (game.powerUntil >= 0 && t >= game.powerUntil) { game.powerUntil = -1; world.setPower(false); audio.play('powerUp'); }

  // --- monsters
  game.monsters.update(dt, game.clock, { players: states, isDoorClosed: doorClosed, time: game.clock, grace: t < game.cfg.grace }, host);
  if (game.monsters.manager.active && !game.managerAnnounced) {
    game.managerAnnounced = true;
    audio.play('managerPA');
    ui.toast('THE MANAGER WOULD LIKE A WORD.', 'bad', 6000);
  }
  game.maidT -= dt;
  if (game.maidT <= 0) { game.maidT = 0.08; game.seesMaid = checkSeesMaid(); }
  if (me.alive && !game.over && !game.dying && game.mode === 'playing') {
    const m = game.monsters.catchCheck(me);
    if (m) die(m.type);
  }
  updateRockets(dt);

  // --- camera
  game.shake = Math.max(0, game.shake - dt * 1.6);
  game.flash = Math.max(0, game.flash - dt * 1.5);
  const sh = game.shake * game.shake * 0.12;
  if (game.mode === 'spectating') {
    cam.position.set(spec.x, spec.y, spec.z);
    cam.rotation.set(spec.pitch, spec.yaw, 0);
  } else if (me.alive) {
    const targetEye = me.hidden ? 1.45 : me.crouch ? EYE_CROUCH : EYE;
    me.eye += (targetEye - me.eye) * Math.min(1, dt * 10);
    const mv = Math.min(1, me.speed / WALK);
    cam.position.set(me.x + (Math.random() - 0.5) * sh, me.eye + Math.sin(me.bob * 2) * 0.028 * mv + (Math.random() - 0.5) * sh, me.z + (Math.random() - 0.5) * sh);
    cam.rotation.set(me.pitch, me.yaw, Math.sin(me.bob) * 0.006 * mv);
  } else if (!game.dying) {
    // on the floor where you fell
    me.eye += (0.32 - me.eye) * Math.min(1, dt * 2);
    cam.position.set(me.x, me.eye, me.z);
    cam.rotation.set(me.pitch * 0.5 + 0.2, me.yaw, 0.9 * (1 - (me.eye - 0.32) / 1.3));
    world.setFlashlight(0.5, 0, -0.6);
  }

  // --- world
  actors.length = 0;
  for (const p of states) if (p.alive && !p.hidden) actors.push(p);
  for (const m of game.monsters.list) if (m.active) actors.push(m);
  world.update(dt, game.clock, cam.position, actors);

  // --- fear + audio
  const near = game.monsters.nearest(cam.position.x, cam.position.z);
  const tension = me.alive && game.mode === 'playing' && !game.over ? clamp(1 - near.dist / 15, 0, 1) : 0;
  game.fear += (tension - game.fear) * Math.min(1, dt * 3);
  world.setFear(game.mode === 'spectating' ? 0 : game.fear * 0.85);
  world.setScreenFlash(game.flash);
  cam.getWorldDirection(tmpV);
  audio.setListener(cam.position.x, cam.position.y, cam.position.z, tmpV.x, tmpV.y, tmpV.z);
  audio.update(dt, game.mode === 'spectating' ? 0 : world.buzz, game.fear, me.speed > 0.5);
  for (const m of game.monsters.list) audio.updateMonster({ type: m.type, x: m.x, z: m.z, active: m.active && !game.over, state: m.state, speed: m.speed, eye: m.info.eye }, dt);

  // --- voice
  if (voice) {
    const L = cam.position;
    const proximity = !game.over;
    voice.update(L, (id) => {
      const r = game.remotes.get(id);
      if (!r || !proximity) return { audible: true, spatial: false };
      if (!r.alive) return { audible: !me.alive, spatial: false };
      const muffled = L.y < WALL_H && !lineOfSight(game.hotel.grid, L.x, L.z, r.x, r.z, doorClosed);
      return { audible: true, spatial: true, x: r.x, y: 1.5, z: r.z, muffled };
    });
  }

  // --- network
  if (game.coop) {
    game.sendT -= dt;
    if (game.sendT <= 0) {
      game.sendT = 1 / 15;
      net.send({ t: 'state', x: +me.x.toFixed(2), z: +me.z.toFixed(2), y: +me.yaw.toFixed(3), p: +me.pitch.toFixed(3), f: me.flashLevel > 0.3 ? 1 : 0, a: me.alive ? 1 : 0, h: me.hidden ? 1 : 0, c: me.crouch ? 1 : 0, n: +me.noise.toFixed(1), m: game.seesMaid ? 1 : 0 });
    }
    if (host) {
      game.monT -= dt;
      if (game.monT <= 0) { game.monT = 1 / 12; net.send({ t: 'mon', m: game.monsters.serialize() }); }
    }
  }

  // --- HUD
  if (game.mode === 'playing' && me.alive) {
    ui.setHUD({
      battery: me.battery, flashlightOn: me.flashOn, stamina: me.stamina, keys: game.keys, rockets: me.rockets,
      objective: game.elevUnlocked ? 'Reach the elevator.' : `Find the master keycards hidden in the guest rooms.`,
    });
  }
  if (game.mode === 'spectating') {
    ui.drawMap(game.hotel, {
      players: [{ x: me.x, z: me.z, name: me.name, alive: me.alive }, ...[...game.remotes.values()].map((r) => ({ x: r.x, z: r.z, name: r.name, alive: r.alive && r.got }))],
      monsters: game.monsters.list.map((m) => ({ x: m.x, z: m.z, name: m.info.name.replace('THE ', ''), color: '#' + m.info.color.toString(16).padStart(6, '0'), active: m.active })),
      pickups: [...game.pickups.values()], cam: spec, elevUnlocked: game.elevUnlocked,
    });
  }
  game.hudT -= dt;
  if (game.hudT <= 0) {
    game.hudT = 0.2;
    if (game.coop) {
      ui.setPlayers([{ name: me.name, self: true, alive: me.alive, talking: voice && voice.talking, host: net.isHost },
        ...[...game.remotes.values()].map((r) => ({ name: r.name, alive: r.alive, talking: voice && voice.isSpeaking(r.id), host: r.id === net.hostId }))]);
    } else ui.setPlayers(null);
  }
  if (game.coop && voice) ui.setMic(voice.micOn ? (voice.muted ? 'muted' : 'on') : 'off', voice.level); else ui.setMic(null);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!game.paused) tick(dt);
  world.render();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function setupInput() {
  window.addEventListener('keydown', (e) => {
    if (inGame() && ['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (!inGame()) return;
    switch (e.code) {
      case 'KeyE': interact(); break;
      case 'KeyF': toggleFlashlight(); break;
      case 'KeyR': fireRocket(); break;
      case 'KeyV':
        if (voice && voice.micOn) { voice.setMuted(!voice.muted); ui.toast(voice.muted ? 'Microphone muted' : 'Microphone live', 'small', 1200); }
        else if (voice) voice.enableMic().then((ok) => { if (!ok && voice) ui.toast(voice.error || 'No microphone.', 'small', 3000); });
        break;
      case 'KeyM': if (game.mode === 'spectating') ui.toggleBigMap(); break;
      case 'Tab': if (game.mode === 'spectating') specCycle(); break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('mousedown', (e) => {
    audio.init();
    if (ui.screen !== null) return;
    if (!game.locked) { if (game.mode === 'playing' || game.mode === 'spectating') lockPointer(); return; }
    if (e.button === 0) fireRocket();
  });
  document.addEventListener('mousemove', (e) => {
    if (!game.locked) return;
    const sx = e.movementX * 0.0021, sy = e.movementY * 0.0021;
    if (game.mode === 'spectating') {
      spec.yaw -= sx; spec.pitch = clamp(spec.pitch - sy, -1.55, 1.55);
    } else if (game.mode === 'playing' && me.alive && !game.dying) {
      me.yaw -= sx; me.pitch = clamp(me.pitch - sy, -1.45, 1.45);
    }
  });
  document.addEventListener('pointerlockchange', () => {
    game.locked = document.pointerLockElement === canvas;
    if (game.locked) {
      if (ui.screen === 'pause') ui.show(null);
      setPaused(false);
    } else if (game.mode === 'playing' && me.alive && !game.over && !game.dying && ui.screen === null) {
      ui.setPauseHint(game.coop ? 'The hotel does not pause for you. Your colleagues are still out there.' : 'The hotel waits.');
      ui.show('pause');
      setPaused(!game.coop);
      keys.clear();
    }
  });
  // A hidden tab stops rendering; keep the host's simulation ticking so co-op monsters do not freeze.
  setInterval(() => {
    if (document.hidden && game.coop && net.isHost && inGame() && !game.over) for (let i = 0; i < 20; i++) tick(0.05);
  }, 1000);
}

function boot() {
  audio = new AudioEngine();
  world = new World(canvas);
  net = new Net();
  ui = new UI(handlers, audio);
  setupNet();
  setupInput();
  setBackdrop();
  ui.show('title');
  window.__tls = { game, me, spec, world, audio, net, ui, handlers, startGame, enterSpectate, die, keys, tick, get voice() { return voice; } };
  requestAnimationFrame(frame);
}

try {
  boot();
} catch (e) {
  console.error(e);
  const el = document.getElementById('fatal');
  el.textContent = 'The hotel failed to open.\n\n' + (e && e.stack ? e.stack : e);
  el.classList.remove('hidden');
}

// monsters.js - the staff who never left.
// The host simulates all AI (A* on the maze grid) and broadcasts positions; other clients
// interpolate. Each monster is built from primitives with a procedurally painted face.
import * as THREE from 'three';
import { CELL, GRID, idx, inBounds, astar, bfs, lineOfSight, walkable } from './maze.js';

export const MONSTER_TYPES = ['concierge', 'maid', 'bellhop', 'manager'];
export const MONSTER_INFO = {
  concierge: { name: 'THE CONCIERGE', color: 0xff5040, catchR: 0.95, stun: 7, eye: 2.0 },
  maid: { name: 'THE MAID', color: 0xd0d8ff, catchR: 0.9, stun: 7, eye: 1.55 },
  bellhop: { name: 'THE BELLHOP', color: 0xff9020, catchR: 1.0, stun: 8, eye: 0.6 },
  manager: { name: 'THE MANAGER', color: 0xff0020, catchR: 1.1, stun: 3, eye: 2.3 },
};
const STATES = ['idle', 'wander', 'hunt', 'frozen', 'alert', 'charge', 'rest', 'stunned'];
const S = Object.fromEntries(STATES.map((s, i) => [s, i]));

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

function part(parent, w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;  
  parent.add(m);
  return m;
}

function pivot(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

function faced(tex, skin) {
  return [skin, skin, skin, skin, new THREE.MeshLambertMaterial({ map: tex }), skin];
}

function buildConcierge(tx) {
  const g = new THREE.Group();
  const suit = lam(0x0b0b0d), skin = lam(0xa9a596);
  const legL = pivot(g, -0.09, 1.08, 0), legR = pivot(g, 0.09, 1.08, 0);
  part(legL, 0.12, 1.08, 0.13, suit, 0, -0.54, 0); part(legR, 0.12, 1.08, 0.13, suit, 0, -0.54, 0);
  const body = pivot(g, 0, 0, 0);
  part(body, 0.38, 0.7, 0.2, [suit, suit, suit, suit, lam(0xffffff, { map: tx.torsos.concierge }), suit], 0, 1.43, 0);
  part(body, 0.08, 0.1, 0.08, skin, 0, 1.83, 0);
  const head = part(body, 0.25, 0.34, 0.23, faced(tx.faces.concierge, skin), 0, 2.03, 0);
  const armL = pivot(body, -0.24, 1.74, 0), armR = pivot(body, 0.24, 1.74, 0);
  part(armL, 0.09, 0.98, 0.1, suit, 0, -0.49, 0); part(armL, 0.08, 0.14, 0.09, skin, 0, -1.04, 0);
  part(armR, 0.09, 0.62, 0.1, suit, 0, -0.31, 0);
  const fore = pivot(armR, 0, -0.62, 0);
  part(fore, 0.085, 0.46, 0.095, suit, 0, -0.23, 0); part(fore, 0.08, 0.12, 0.09, skin, 0, -0.52, 0);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), lam(0xc9a43c, { emissive: 0x3a2c08 }));
  bell.position.set(0, -0.68, 0); bell.rotation.x = Math.PI; bell.castShadow = true;
  fore.add(bell);
  armR.rotation.x = -0.5; fore.rotation.x = -1.3;
  return { group: g, legL, legR, armL, armR, fore, head, body };
}

function buildMaid(tx) {
  const g = new THREE.Group();
  const dress = lam(0x0c0c10), skin = lam(0xdedbd2), hair = lam(0x040405), white = lam(0xcfcbbe);
  const body = pivot(g, 0, 0, 0);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.36, 1.0, 12), dress);
  skirt.position.y = 0.5; skirt.castShadow = true; body.add(skirt);
  const apron = part(body, 0.3, 0.62, 0.02, white, 0, 0.58, 0.255); apron.rotation.x = -0.21;
  part(body, 0.32, 0.5, 0.2, [dress, dress, dress, dress, lam(0xffffff, { map: tx.torsos.maid }), dress], 0, 1.22, 0);
  const head = part(body, 0.24, 0.3, 0.22, faced(tx.faces.maid, skin), 0, 1.62, 0);
  part(body, 0.3, 0.8, 0.1, hair, 0, 1.38, -0.14);
  part(body, 0.05, 0.62, 0.2, hair, -0.14, 1.44, -0.02); part(body, 0.05, 0.62, 0.2, hair, 0.14, 1.44, -0.02);
  part(body, 0.27, 0.05, 0.25, hair, 0, 1.79, 0);
  const arms = [-1, 1].map((s) => {
    const sh = pivot(body, s * 0.2, 1.42, 0);
    part(sh, 0.08, 0.32, 0.08, dress, 0, -0.16, 0);
    const el = pivot(sh, 0, -0.32, 0);
    part(el, 0.07, 0.3, 0.07, dress, 0, -0.15, 0);
    part(el, 0.075, 0.1, 0.085, skin, 0, -0.34, 0);
    return { sh, el, s };
  });
  return { group: g, arms, head, body, cover: 0 };
}

function buildBellhop(tx) {
  const g = new THREE.Group();
  const red = lam(0x8c1016), skin = lam(0x9aa089), gold = lam(0xc9a43c, { emissive: 0x2a2008 });
  const body = pivot(g, 0, 0.5, 0);
  part(body, 0.42, 0.26, 0.8, [red, red, lam(0xffffff, { map: tx.torsos.bellhop }), red, red, red], 0, 0, 0);
  const neck = pivot(body, 0, 0.08, 0.42);
  const head = part(neck, 0.26, 0.32, 0.24, faced(tx.faces.bellhop, skin), 0, 0.1, 0.12);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12), red);
  hat.position.set(0, 0.31, 0.12); hat.castShadow = true; neck.add(hat);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.133, 0.133, 0.025, 12), gold);
  band.position.set(0, 0.29, 0.12); neck.add(band);
  neck.rotation.x = -0.3;
  const limbs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const hip = pivot(body, sx * 0.2, 0.02, sz * 0.32);
    hip.rotation.z = sx * 1.05;
    part(hip, 0.085, 0.42, 0.085, red, 0, -0.21, 0);
    const knee = pivot(hip, 0, -0.42, 0);
    knee.rotation.z = -sx * 1.25;
    part(knee, 0.07, 0.5, 0.07, sz > 0 ? red : lam(0x15110f), 0, -0.25, 0);
    part(knee, 0.09, 0.06, 0.14, skin, 0, -0.52, 0.03);
    limbs.push({ hip, knee, phase: (sx * sz > 0 ? 0 : Math.PI), sx });
  }
  return { group: g, limbs, head, neck, body };
}

function buildManager(tx) {
  const g = new THREE.Group();
  const suit = lam(0x17171b), skin = lam(0x3a3632);
  const legL = pivot(g, -0.17, 1.15, 0), legR = pivot(g, 0.17, 1.15, 0);
  part(legL, 0.21, 1.15, 0.23, suit, 0, -0.575, 0); part(legR, 0.21, 1.15, 0.23, suit, 0, -0.575, 0);
  const body = pivot(g, 0, 0, 0);
  part(body, 0.78, 0.95, 0.36, [suit, suit, suit, suit, lam(0xffffff, { map: tx.torsos.manager }), suit], 0, 1.62, 0);
  part(body, 0.96, 0.2, 0.4, suit, 0, 2.06, 0);
  const head = part(body, 0.3, 0.4, 0.28, faced(tx.faces.manager, skin), 0, 2.38, 0);
  const eyes = [-1, 1].map((s) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tx.glow, color: 0xff2000, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    sp.scale.setScalar(0.16); sp.position.set(s * 0.064, 2.42, 0.16);
    body.add(sp);
    return sp;
  });
  const armL = pivot(body, -0.5, 2.06, 0), armR = pivot(body, 0.5, 2.06, 0);
  for (const a of [armL, armR]) { part(a, 0.17, 1.2, 0.19, suit, 0, -0.6, 0); part(a, 0.19, 0.2, 0.21, skin, 0, -1.28, 0); }
  return { group: g, legL, legR, armL, armR, head, body, eyes };
}

const BUILD = { concierge: buildConcierge, maid: buildMaid, bellhop: buildBellhop, manager: buildManager };

// ---------------------------------------------------------------------------

function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Monster {
  constructor(type, world, hotel, cfg) {
    this.type = type;
    this.info = MONSTER_INFO[type];
    this.world = world;
    this.hotel = hotel;
    this.cfg = cfg;
    this.model = BUILD[type](world.tex);
    this.group = this.model.group;
    this.group.visible = false;
    world.dyn.add(this.group);
    this.beacon = world.makeBeacon(this.info.color, this.info.name);

    this.active = false;
    this.x = 0; this.z = 0; this.heading = 0;
    this.nx = 0; this.nz = 0; this.nh = 0;       // network targets
    this.state = S.idle;
    this.stun = 0;
    this.targetId = null;
    this.path = null; this.pathI = 0; this.repath = 0; this.goalCell = -1;
    this.pickTimer = 0;
    this.speed = 0;                               // metres/second this frame (for animation + audio)
    this.anim = Math.random() * 10;
    this.knows = new Set();                       // players this monster watched climb into a wardrobe
    this.lastSeen = new Map();
    this.wasHidden = new Map();
    // type specific
    this.thaw = 0;                                // maid: reaction delay after being seen
    this.alertX = 0; this.alertZ = 0; this.timer = 0; this.lostT = 0; this.chargeT = 0; // bellhop
    this.justCharged = false;
  }

  spawn(cx, cy) {
    this.x = this.nx = (cx + 0.5) * CELL;
    this.z = this.nz = (cy + 0.5) * CELL;
    this.active = true;
    this.group.visible = true;
    this.state = S.idle;
    this.path = null;
  }

  cell() { return { x: Math.floor(this.x / CELL), y: Math.floor(this.z / CELL) }; }

  face(dx, dz, dt) {
    this.heading = angleLerp(this.heading, Math.atan2(dx, dz), Math.min(1, dt * 9));
  }

  follow(dt, speed) {
    if (!this.path || this.pathI >= this.path.length) return false;
    const c = this.path[this.pathI];
    const tx = (c % GRID + 0.5) * CELL, tz = (((c / GRID) | 0) + 0.5) * CELL;
    const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz), step = speed * dt;
    if (d <= step) { this.x = tx; this.z = tz; this.pathI++; } else { this.x += (dx / d) * step; this.z += (dz / d) * step; }
    if (d > 0.001) this.face(dx, dz, dt);
    this.speed = speed;
    return true;
  }

  goTo(cx, cy) {
    const c = this.cell();
    this.path = astar(this.hotel.grid, c.x, c.y, cx, cy);
    this.pathI = 1;
    this.goalCell = idx(cx, cy);
    return !!this.path;
  }

  chase(dt, t, speed) {
    const c = this.cell();
    const tcx = Math.floor(t.x / CELL), tcy = Math.floor(t.z / CELL);
    const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz);
    if (Math.abs(c.x - tcx) + Math.abs(c.y - tcy) <= 1) {
      // same or neighbouring cell: close in directly
      if (d > 0.05) {
        const step = Math.min(d, speed * dt);
        this.x += (dx / d) * step; this.z += (dz / d) * step;
        this.face(dx, dz, dt);
      }
      this.path = null;
      this.speed = speed;
      return;
    }
    this.repath -= dt;
    if (!this.path || this.repath <= 0 || this.goalCell !== idx(tcx, tcy)) {
      this.goTo(tcx, tcy);
      this.repath = 0.45;
    }
    this.follow(dt, speed);
  }

  wander(dt, speed, preferRooms = 0) {
    if (!this.path || this.pathI >= this.path.length) {
      const h = this.hotel;
      let cx, cy;
      if (preferRooms > Math.random() && h.rooms.length) {
        const r = h.rooms[(Math.random() * h.rooms.length) | 0];
        cx = r.x0 + ((r.w - 1) >> 1); cy = r.y0 + ((r.h - 1) >> 1);
      } else {
        const c = h.hallCells[(Math.random() * h.hallCells.length) | 0];
        cx = c % GRID; cy = (c / GRID) | 0;
      }
      if (!this.goTo(cx, cy)) return;
    }
    this.follow(dt, speed);
  }

  /** Track who we watched hide. Returns the players this monster may hunt. */
  perceive(ctx) {
    const grid = this.hotel.grid;
    const out = [];
    for (const p of ctx.players) {
      if (!p.alive) continue;
      if (!p.hidden) {
        this.knows.delete(p.id);
        this.wasHidden.set(p.id, false);
        const d = Math.hypot(p.x - this.x, p.z - this.z);
        p._los = d < 30 && lineOfSight(grid, this.x, this.z, p.x, p.z, ctx.isDoorClosed);
        p._dist = d;
        if (p._los && d < 15) this.lastSeen.set(p.id, ctx.time);
        out.push(p);
      } else {
        if (!this.wasHidden.get(p.id)) {
          this.wasHidden.set(p.id, true);
          if (this.type === 'manager' || ctx.time - (this.lastSeen.get(p.id) ?? -99) < 0.8) this.knows.add(p.id);
        }
        if (this.type === 'manager') this.knows.add(p.id);
        p._los = false; p._dist = Math.hypot(p.x - this.x, p.z - this.z);
        if (this.knows.has(p.id)) out.push(p);
      }
    }
    return out;
  }

  nearestByPath(cands, maxCells = Infinity) {
    if (!cands.length) return null;
    const c = this.cell();
    if (!inBounds(c.x, c.y) || !walkable(this.hotel.grid[idx(c.x, c.y)])) return cands[0];
    const field = bfs(this.hotel.grid, c.x, c.y);
    let best = null, bestD = Infinity;
    for (const p of cands) {
      const px = Math.floor(p.x / CELL), py = Math.floor(p.z / CELL);
      const d = inBounds(px, py) ? field[idx(px, py)] : -1;
      if (d >= 0 && d < bestD && d <= maxCells) { bestD = d; best = p; }
    }
    return best;
  }

  pickTarget(dt, cands, maxCells) {
    this.pickTimer -= dt;
    let cur = cands.find((p) => p.id === this.targetId) || null;
    if (!cur || this.pickTimer <= 0) {
      this.pickTimer = 0.6;
      cur = this.nearestByPath(cands, maxCells);
      this.targetId = cur ? cur.id : null;
    }
    return cur;
  }

  // --- host-side AI ---------------------------------------------------------
  simulate(dt, ctx) {
    this.speed = 0;
    if (!this.active) return;
    const cands = this.perceive(ctx);
    if (this.stun > 0) {
      this.stun -= dt;
      this.state = S.stunned;
      this.path = null;
      return;
    }
    if (ctx.grace) { this.state = S.idle; return; }
    const mul = this.cfg.monsterSpeed;
    switch (this.type) {
      case 'concierge': {
        const t = this.pickTarget(dt, cands);
        if (t) { this.state = S.hunt; this.chase(dt, t, 2.05 * mul); }
        else { this.state = S.wander; this.wander(dt, 1.5 * mul); }
        break;
      }
      case 'maid': {
        const observed = ctx.players.some((p) => p.alive && p.seesMaid);
        if (observed) { this.state = S.frozen; this.thaw = 0.35; break; }
        if (this.thaw > 0) { this.thaw -= dt; this.state = S.frozen; break; }
        const t = this.pickTarget(dt, cands, 26);
        if (t) { this.state = S.hunt; this.chase(dt, t, 5.4 * mul); }
        else { this.state = S.wander; this.wander(dt, 1.3 * mul, 0.6); }
        break;
      }
      case 'bellhop':
        this.simBellhop(dt, ctx, cands, mul);
        break;
      case 'manager': {
        const t = this.pickTarget(dt, cands);
        if (t) { this.state = S.hunt; this.chase(dt, t, this.cfg.managerSpeed); }
        else { this.state = S.wander; this.wander(dt, 2 * mul); }
        break;
      }
      default: break;
    }
  }

  simBellhop(dt, ctx, cands, mul) {
    const seen = cands.filter((p) => (p._los && p._dist < 10.5) || this.knows.has(p.id)).sort((a, b) => a._dist - b._dist)[0] || null;
    if (this.state === S.idle || this.state === S.hunt || this.state === S.frozen || this.state === S.stunned) this.state = S.wander;
    if (this.state === S.rest) {
      this.timer -= dt;
      if (this.timer <= 0) { this.state = S.wander; this.path = null; }
      return;
    }
    if (this.state === S.charge) {
      const t = cands.find((p) => p.id === this.targetId);
      this.chargeT -= dt;
      if (t && t._los) this.lostT = 0; else this.lostT += dt;
      if (!t || this.chargeT <= 0 || this.lostT > 2.5) {
        this.state = S.rest; this.timer = 3.5; this.targetId = null; this.path = null;
        return;
      }
      this.chase(dt, t, 5.35 * mul);
      return;
    }
    if (seen) {
      this.state = S.charge; this.targetId = seen.id; this.chargeT = 7; this.lostT = 0; this.path = null;
      this.justCharged = true;
      return;
    }
    // listen: sprinting, voices, anything loud
    let loud = null, loudScore = 0;
    for (const p of ctx.players) {
      if (!p.alive || p.hidden || !(p.noise > 0)) continue;
      const d = Math.hypot(p.x - this.x, p.z - this.z);
      if (d < p.noise && p.noise - d > loudScore) { loudScore = p.noise - d; loud = p; }
    }
    if (loud) this.hear(loud.x, loud.z);
    if (this.state === S.alert) {
      const arrived = !this.follow(dt, 3.9 * mul);
      if (arrived) {
        this.timer -= dt;
        this.heading += dt * 2.4; // looking around
        if (this.timer <= 0) { this.state = S.wander; this.path = null; }
      }
      return;
    }
    this.state = S.wander;
    this.wander(dt, 1.25 * mul, 0.3);
  }

  hear(x, z) {
    if (this.type !== 'bellhop' || !this.active || this.stun > 0) return;
    if (this.state === S.charge || this.state === S.rest) return;
    const cx = Math.floor(x / CELL), cy = Math.floor(z / CELL);
    if (!inBounds(cx, cy) || !walkable(this.hotel.grid[idx(cx, cy)])) return;
    if (this.state === S.alert && this.goalCell === idx(cx, cy)) return;
    if (this.goTo(cx, cy)) { this.state = S.alert; this.timer = 2.5; }
  }

  // --- everyone ---------------------------------------------------------------
  serialize() {
    return [this.active ? 1 : 0, +this.x.toFixed(2), +this.z.toFixed(2), +this.heading.toFixed(2), this.state, this.targetId || 0];
  }

  applyNet(a) {
    const wasActive = this.active;
    this.active = !!a[0];
    this.nx = a[1]; this.nz = a[2]; this.nh = a[3];
    this.state = a[4]; this.targetId = a[5] || null;
    if (this.active && !wasActive) { this.x = this.nx; this.z = this.nz; this.heading = this.nh; }
    this.group.visible = this.active;
  }

  /** Visual update. remote=true interpolates toward the last network state. */
  animate(dt, time, remote) {
    this.beacon.set(this.x, this.z, this.active);
    if (!this.active) return;
    if (remote) {
      const px = this.x, pz = this.z;
      const k = Math.min(1, dt * 12);
      if (Math.hypot(this.nx - this.x, this.nz - this.z) > 8) { this.x = this.nx; this.z = this.nz; }
      this.x += (this.nx - this.x) * k; this.z += (this.nz - this.z) * k;
      this.heading = angleLerp(this.heading, this.nh, k);
      this.speed = Math.hypot(this.x - px, this.z - pz) / Math.max(dt, 0.001);
    }
    const m = this.model, g = this.group;
    const stunned = this.state === S.stunned;
    g.position.set(this.x, 0, this.z);
    g.rotation.y = this.heading;
    this.anim += dt * (0.6 + this.speed * 1.7);
    const sw = Math.sin(this.anim), moving = Math.min(1, this.speed / 1.5);
    if (stunned) {
      g.position.x += (Math.random() - 0.5) * 0.05; g.position.z += (Math.random() - 0.5) * 0.05;
      g.rotation.z = Math.sin(time * 31) * 0.05;
      if (Math.random() < 0.3) this.world.particles.emit(this.x + (Math.random() - 0.5) * 0.4, this.info.eye * (0.5 + Math.random() * 0.6), this.z + (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 0.5, 1, 0.8, 0.3, 4);
    } else g.rotation.z = 0;

    if (this.type === 'concierge') {
      m.legL.rotation.x = sw * 0.45 * moving; m.legR.rotation.x = -sw * 0.45 * moving;
      m.armL.rotation.x = -sw * 0.3 * moving;
      m.fore.rotation.x = -1.3 + Math.sin(time * 9) * 0.22; // forever ringing
      m.head.rotation.z = Math.sin(time * 0.7) * 0.12;
      m.body.rotation.x = 0.06;
    } else if (this.type === 'maid') {
      const frozen = this.state === S.frozen || stunned;
      m.cover += ((frozen ? 1 : 0) - m.cover) * Math.min(1, dt * 14);
      const reach = this.state === S.hunt ? 1 : 0;
      for (const a of m.arms) {
        a.sh.rotation.x = -1.35 * m.cover - 1.45 * reach * (1 - m.cover);
        a.sh.rotation.z = a.s * (0.06 - 0.3 * m.cover);
        a.el.rotation.x = -1.9 * m.cover - 0.25 * reach * (1 - m.cover);
      }
      m.head.rotation.x = 0.28 * m.cover;
      m.body.rotation.z = frozen ? 0 : Math.sin(this.anim * 0.5) * 0.04;
      m.body.position.y = frozen ? 0 : Math.abs(Math.sin(this.anim)) * 0.03 * moving;
    } else if (this.type === 'bellhop') {
      const charging = this.state === S.charge || this.state === S.alert;
      for (const l of m.limbs) {
        const ph = this.anim * (charging ? 1.5 : 1.1) + l.phase;
        l.hip.rotation.x = Math.sin(ph) * 0.55 * Math.max(0.15, moving);
        l.knee.rotation.x = Math.max(0, Math.cos(ph)) * 0.5 * Math.max(0.15, moving);
      }
      m.neck.rotation.x = -0.3 + (charging ? -0.25 : 0) + Math.sin(time * 3) * 0.05;
      m.neck.rotation.z = this.state === S.rest ? Math.sin(time * 14) * 0.08 : Math.sin(time * 1.3) * 0.2;
      m.body.position.y = 0.5 + Math.sin(this.anim * 2) * 0.02 - (this.state === S.rest ? 0.1 : 0);
    } else {
      m.legL.rotation.x = sw * 0.36 * moving; m.legR.rotation.x = -sw * 0.36 * moving;
      m.armL.rotation.x = -0.25 - sw * 0.2 * moving; m.armR.rotation.x = -0.25 + sw * 0.2 * moving;
      m.body.rotation.x = 0.12;
      m.body.position.y = Math.abs(sw) * 0.03 * moving;
      const pulse = 0.14 + Math.sin(time * 6) * 0.03;
      for (const e of m.eyes) e.scale.setScalar(stunned ? 0.05 : pulse);
    }
  }

  dispose() {
    this.world.dyn.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const mat of ms) mat.dispose();
    });
    this.beacon.dispose();
  }
}

// ---------------------------------------------------------------------------

export class MonsterManager {
  constructor(world, hotel, cfg) {
    this.world = world;
    this.hotel = hotel;
    this.cfg = cfg;
    this.list = MONSTER_TYPES.map((t) => new Monster(t, world, hotel, cfg));
    this.byType = Object.fromEntries(this.list.map((m) => [m.type, m]));
    for (const t of ['concierge', 'maid', 'bellhop']) {
      const s = hotel.monsterSpawns[t];
      this.byType[t].spawn(s.x, s.y);
    }
  }

  get manager() { return this.byType.manager; }

  /** Host only: the Manager arrives somewhere out of sight, a fair walk from everyone. */
  spawnManager(players) {
    const m = this.manager;
    if (m.active) return;
    const grid = this.hotel.grid;
    const fields = players.filter((p) => p.alive).map((p) => bfs(grid, Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
    let best = this.hotel.startCell, bestScore = -Infinity;
    for (const c of this.hotel.hallCells) {
      let near = Infinity;
      for (const f of fields) if (f[c] >= 0 && f[c] < near) near = f[c];
      if (near === Infinity) near = 20;
      // prefer about 16 cells of walking from the nearest porter
      const score = -Math.abs(near - 16) + Math.random() * 2;
      if (score > bestScore) { bestScore = score; best = { x: c % GRID, y: (c / GRID) | 0 }; }
    }
    m.spawn(best.x, best.y);
  }

  update(dt, time, ctx, isHost) {
    for (const m of this.list) {
      if (isHost) m.simulate(dt, ctx);
      m.animate(dt, time, !isHost);
    }
  }

  serialize() { return this.list.map((m) => m.serialize()); }

  applyNet(arr) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < this.list.length && i < arr.length; i++) this.list[i].applyNet(arr[i]);
  }

  /** Host only: a rocket went off. Stun what it caught, and the Bellhop hears it. */
  boom(x, z, isDoorClosed) {
    const hit = [];
    for (const m of this.list) {
      if (!m.active) continue;
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < 6 && (d < 1.5 || lineOfSight(this.hotel.grid, x, z, m.x, m.z, isDoorClosed))) {
        m.stun = Math.max(m.stun, m.info.stun * this.cfg.stunMul);
        m.state = S.stunned;
        hit.push(m.type);
      } else if (d < 38) m.hear(x, z);
    }
    return hit;
  }

  /** Is the local player caught? Returns the monster, or null. */
  catchCheck(me) {
    for (const m of this.list) {
      if (!m.active || m.state === S.stunned || m.state === S.idle) continue;
      if (m.type === 'maid' && m.state === S.frozen) continue;
      const d = Math.hypot(m.x - me.x, m.z - me.z);
      if (me.hidden) {
        if (m.targetId === me.id && d < 1.7) return m;
      } else if (d < m.info.catchR) return m;
    }
    return null;
  }

  nearest(x, z) {
    let best = null, bd = Infinity;
    for (const m of this.list) {
      if (!m.active) continue;
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < bd) { bd = d; best = m; }
    }
    return { monster: best, dist: bd };
  }

  dispose() { for (const m of this.list) m.dispose(); }
}

export { STATES, S as MONSTER_STATE };

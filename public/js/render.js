// render.js - builds the hotel out of the generated data and draws it.
// Level geometry is merged into a handful of meshes; ceiling lights are instanced glow panels
// with a small pool of real lights that follow whoever is watching.
import * as THREE from 'three';
import { GRID, CELL, WALL_H, DOOR_W, DOOR_H, ELEV_W, T, idx, inBounds, bfs, walkable } from './maze.js';
import { getTextures, PORTRAIT_W, PORTRAIT_H, nameTag } from './textures.js';

const FOG_DENSITY = 0.072;
const HEMI = 0.26;
const POOL_POWER = 24;
const FLASH_POWER = 62;
const POOL_SIZE = 6;
const REMOTE_SPOTS = 3;
const WARM = new THREE.Color(1.0, 0.72, 0.42);
const LAMP = new THREE.Color(1.0, 0.6, 0.3);
const COLD = new THREE.Color(0.75, 0.9, 1.0);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function mirrored(tex) {
  const t = tex.clone();
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.x = -1;
  t.offset.x = 1;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Geometry builder: accumulates quads/boxes into one BufferGeometry.
// ---------------------------------------------------------------------------
class Builder {
  constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
  get empty() { return this.i.length === 0; }

  quad(a, b, c, d, n, u0, v0, u1, v1) {
    const base = this.p.length / 3;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let k = 0; k < 4; k++) this.n.push(n[0], n[1], n[2]);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Vertical quad centred at (px,pz), facing (nx,nz), half-width hw. */
  vquad(px, pz, nx, nz, hw, y0, y1, u0 = 0, u1 = 1, v0 = 0, v1 = 1) {
    const rx = nz, rz = -nx; // "right" as seen from the front
    this.quad(
      [px - rx * hw, y0, pz - rz * hw], [px + rx * hw, y0, pz + rz * hw],
      [px + rx * hw, y1, pz + rz * hw], [px - rx * hw, y1, pz - rz * hw],
      [nx, 0, nz], u0, v0, u1, v1);
  }

  hquad(x0, z0, x1, z1, y, up, u0, v0, u1, v1) {
    if (up) this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], u0, v0, u1, v1);
    else this.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, -1, 0], u0, v0, u1, v1);
  }

  /** Axis-aligned box. UVs are in world units times uvs so textures keep their scale. */
  box(cx, cy, cz, sx, sy, sz, uvs = 0.6) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 0, 0, sz * uvs, sy * uvs);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0, 0, sz * uvs, sy * uvs);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0, 0, sx * uvs, sy * uvs);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0, 0, sx * uvs, sy * uvs);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], 0, 0, sx * uvs, sz * uvs);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], 0, 0, sx * uvs, sz * uvs);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Particles: one additive point cloud shared by every effect.
// ---------------------------------------------------------------------------
class Particles {
  constructor(scene, tex, max = 800) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.base = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo = g;
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.2, map: tex, vertexColors: true, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, sizeAttenuation: true, fog: false,
    }));
    this.points.frustumCulled = false;
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -100;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, r, g, b, grav = 3) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.base[i * 3] = r; this.base[i * 3 + 1] = g; this.base[i * 3 + 2] = b;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = grav;
  }

  burst(x, y, z, count, speed, life, r, g, b, grav = 3) {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2, e = Math.acos(Math.random() * 2 - 1);
      const s = speed * (0.25 + Math.random() * 0.75);
      this.emit(x, y, z, Math.sin(e) * Math.cos(a) * s, Math.cos(e) * s, Math.sin(e) * Math.sin(a) * s,
        life * (0.4 + Math.random() * 0.6), r, g, b, grav);
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) { this.pos[j + 1] = -100; this.col[j] = this.col[j + 1] = this.col[j + 2] = 0; continue; }
      this.vel[j + 1] -= this.grav[i] * dt;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < 0.03) { this.pos[j + 1] = 0.03; this.vel[j + 1] *= -0.3; this.vel[j] *= 0.6; this.vel[j + 2] *= 0.6; }
      const f = this.life[i] / this.maxLife[i];
      this.col[j] = this.base[j] * f; this.col[j + 1] = this.base[j + 1] * f; this.col[j + 2] = this.base[j + 2] * f;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Post-processing: tone map, vignette, film grain, a touch of chromatic aberration.
// ---------------------------------------------------------------------------
const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uTime, uGrain, uVignette, uFear, uExposure, uFlash;
varying vec2 vUv;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  float ab = (0.004 + 0.02 * uFear) * r2;
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + c * ab).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv - c * ab).b;
  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  float vig = smoothstep(0.86 - 0.22 * uFear, 0.22, length(c * vec2(1.0, 0.82)));
  col *= mix(1.0, vig, uVignette);
  col.r += uFear * 0.05 * (1.0 - vig);
  float n = hash(floor(vUv * uRes / 1.5) + fract(uTime * 13.7) * 311.0);
  col += (n - 0.5) * (uGrain + 0.05 * uFear);
  float line = sin(vUv.y * uRes.y * 1.6) * 0.5 + 0.5;
  col *= 1.0 - 0.025 * line * uVignette;
  col += uFlash;
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Avatar: another night porter (co-op).
// ---------------------------------------------------------------------------
export class Avatar {
  constructor(world, name) {
    const tx = world.tex;
    this.world = world;
    this.group = new THREE.Group();
    const cloth = new THREE.MeshLambertMaterial({ color: 0x5a0f18 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x15110f });
    const skin = new THREE.MeshLambertMaterial({ color: 0xc9a88a });
    const mk = (geo, mat, x, y, z, parent = this.group) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
    };
    this.body = new THREE.Group(); this.group.add(this.body);
    const torsoMats = [cloth, cloth, cloth, cloth, new THREE.MeshLambertMaterial({ map: tx.torsos.porter }), cloth];
    mk(new THREE.BoxGeometry(0.44, 0.62, 0.24), torsoMats, 0, 1.12, 0, this.body);
    const headMats = [skin, skin, skin, skin, new THREE.MeshLambertMaterial({ map: tx.faces.porter }), skin];
    this.head = mk(new THREE.BoxGeometry(0.24, 0.3, 0.24), headMats, 0, 1.6, 0, this.body);
    mk(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 12), cloth, 0, 0.19, 0, this.head);
    this.legL = new THREE.Group(); this.legL.position.set(-0.11, 0.82, 0); this.body.add(this.legL);
    this.legR = new THREE.Group(); this.legR.position.set(0.11, 0.82, 0); this.body.add(this.legR);
    mk(new THREE.BoxGeometry(0.17, 0.82, 0.19), dark, 0, -0.41, 0, this.legL);
    mk(new THREE.BoxGeometry(0.17, 0.82, 0.19), dark, 0, -0.41, 0, this.legR);
    this.armL = new THREE.Group(); this.armL.position.set(-0.29, 1.38, 0); this.body.add(this.armL);
    this.armR = new THREE.Group(); this.armR.position.set(0.29, 1.38, 0); this.body.add(this.armR);
    mk(new THREE.BoxGeometry(0.13, 0.6, 0.15), cloth, 0, -0.3, 0, this.armL);
    mk(new THREE.BoxGeometry(0.13, 0.6, 0.15), cloth, 0, -0.3, 0, this.armR);
    this.torch = mk(new THREE.CylinderGeometry(0.03, 0.04, 0.18, 8), dark, 0, -0.62, 0.06, this.armR);
    this.torch.rotation.x = Math.PI / 2;
    this.lens = new THREE.Mesh(new THREE.CircleGeometry(0.04, 10), new THREE.MeshBasicMaterial({ color: 0xfff1d0 }));
    this.lens.position.set(0, -0.62, 0.16); this.armR.add(this.lens);
    this.armR.rotation.x = -1.2;
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTag(name, '#e8dcc0'), depthTest: true, transparent: true, fog: true }));
    this.tag.scale.set(1.1, 0.275, 1); this.tag.position.y = 2.05;
    this.group.add(this.tag);
    this.x = 0; this.z = 0; this.walk = 0; this.spot = null;
    world.dyn.add(this.group);
  }

  /** s: { x, z, yaw, pitch, fl, alive, hidden, crouch } */
  update(dt, s) {
    const dx = s.x - this.x, dz = s.z - this.z;
    const sp = Math.hypot(dx, dz) / Math.max(dt, 0.001);
    this.x = s.x; this.z = s.z;
    this.group.visible = !!s.alive && !s.hidden;
    this.group.position.set(s.x, 0, s.z);
    this.group.rotation.y = s.yaw + Math.PI;
    this.body.scale.y = s.crouch ? 0.72 : 1;
    this.walk += dt * Math.min(sp, 6) * 2.4;
    const sw = Math.sin(this.walk) * Math.min(1, sp / 2) * 0.6;
    this.legL.rotation.x = sw; this.legR.rotation.x = -sw; this.armL.rotation.x = -sw * 0.7;
    this.armR.rotation.x = -1.25 + s.pitch * 0.8;
    this.head.rotation.x = -s.pitch * 0.7;
    this.lens.visible = !!s.fl;
    if (this.spot) {
      const on = s.fl && s.alive && !s.hidden;
      this.spot.intensity = on ? 40 : 0;
      const cp = Math.cos(s.pitch);
      const fx = -Math.sin(s.yaw) * cp, fy = Math.sin(s.pitch), fz = -Math.cos(s.yaw) * cp;
      const h = s.crouch ? 1.0 : 1.4;
      this.spot.position.set(s.x + fx * 0.35, h, s.z + fz * 0.35);
      this.spot.target.position.set(s.x + fx * 6, h + fy * 6, s.z + fz * 6);
    }
  }

  dispose() {
    this.world.dyn.remove(this.group);
    if (this.spot) { this.spot.intensity = 0; this.spot.userData.used = false; this.spot = null; }
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030202);
    this.scene.fog = new THREE.FogExp2(0x050303, FOG_DENSITY);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.06, 220);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.tex = getTextures();
    this.level = new THREE.Group(); this.scene.add(this.level);   // rebuilt per hotel
    this.dyn = new THREE.Group(); this.scene.add(this.dyn);       // monsters, avatars, fx

    // --- lights (the set is fixed so shaders never recompile mid-game) ---
    this.hemi = new THREE.HemisphereLight(0x4a3434, 0x1a100c, HEMI);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 0);
    this.sun.position.set(30, 80, 20);
    this.scene.add(this.sun);

    this.flash = new THREE.SpotLight(0xfff0d8, 0, 34, 0.5, 0.6, 1.5);
    this.flash.castShadow = true;
    this.flash.shadow.mapSize.set(1024, 1024);
    this.flash.shadow.camera.near = 0.25;
    this.flash.shadow.camera.far = 34;
    this.flash.shadow.bias = -0.0012;
    this.flash.shadow.normalBias = 0.03;
    this.flash.position.set(0.2, -0.18, 0.05);
    this.camera.add(this.flash);
    this.camera.add(this.flash.target);
    this.flash.target.position.set(0, 0, -8);

    this.remoteSpots = [];
    for (let i = 0; i < REMOTE_SPOTS; i++) {
      const s = new THREE.SpotLight(0xfff0d8, 0, 24, 0.46, 0.6, 1.5);
      s.userData.used = false;
      this.scene.add(s); this.scene.add(s.target);
      this.remoteSpots.push(s);
    }

    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xffc890, 0, 13, 1.8);
      this.scene.add(l);
      this.pool.push({ light: l, fixture: null, target: null, gain: 0 });
    }
    this.fxLight = new THREE.PointLight(0xff8a30, 0, 18, 1.8);
    this.scene.add(this.fxLight);
    this.fxDecay = 4;

    this.particles = new Particles(this.scene, this.tex.glow);

    // --- post ---
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.postScene = new THREE.Scene();
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT, fragmentShader: POST_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: this.rt.texture }, uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 }, uGrain: { value: 0.075 }, uVignette: { value: 1 }, uFear: { value: 0 },
        uExposure: { value: 1.0 }, uFlash: { value: 0 },
      },
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));

    // --- shared materials ---
    const L = (opts) => new THREE.MeshLambertMaterial(opts);
    const tx = this.tex;
    this.mats = {
      hallWall: L({ map: tx.hallWall }), roomWall: L({ map: tx.roomWall }),
      hallFloor: L({ map: tx.hallFloor }), roomFloor: L({ map: tx.roomFloor }),
      ceiling: L({ map: tx.ceiling }), wood: L({ map: tx.wood }), woodLight: L({ map: tx.woodLight }),
      sheet: L({ map: tx.sheet }), blanket: L({ map: tx.blanket }), metal: L({ map: tx.metal }),
      wardrobe: L({ map: tx.wardrobe }), door: L({ map: tx.door }), doorBack: L({ map: mirrored(tx.door) }),
      cap: new THREE.MeshBasicMaterial({ color: 0x0b0908, fog: false }),
      glow: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      pupil: new THREE.MeshBasicMaterial({ color: 0x050302 }),
      blood: tx.blood.map((m) => L({ map: m, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })),
    };
    this.matList = Object.values(this.mats).flat();

    this.hotel = null;
    this.fixtures = [];
    this.doors = [];
    this.doorByCell = new Map();
    this.portraits = [];
    this.pickups = new Map();
    this.spectate = false;
    this.powerOut = false;
    this.elevUnlocked = false;
    this.elev = null;
    this.buzz = 0;
    this.poolTimer = 0;
    this.viewerCell = -1;
    this.distField = null;
    this.onDoorMove = null;
    this.beacons = [];
    this._tmpColor = new THREE.Color();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const pw = Math.max(2, Math.floor(w * this.pixelRatio)), ph = Math.max(2, Math.floor(h * this.pixelRatio));
    this.rt.setSize(pw, ph);
    this.postMat.uniforms.uRes.value.set(pw, ph);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clearLevel() {
    const shared = this.sharedMats || new Set(this.matList);
    this.level.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) {
        if (shared.has(m)) continue;
        if (m.userData && m.userData.ownMap && m.map) m.map.dispose();
        m.dispose();
      }
    });
    this.level.clear();
    this.fixtures = []; this.doors = []; this.doorByCell.clear(); this.portraits = []; this.pickups.clear();
    for (const s of this.pool) { s.fixture = null; s.target = null; s.gain = 0; s.light.intensity = 0; }
    this.elev = null; this.elevUnlocked = false; this.powerOut = false; this.viewerCell = -1;
  }

  // -------------------------------------------------------------------------
  buildHotel(hotel) {
    this.clearLevel();
    this.hotel = hotel;
    const { grid } = hotel;
    const M = this.mats;
    const add = (builder, mat, cast = true, receive = true) => {
      if (builder.empty) return null;
      const m = new THREE.Mesh(builder.build(), mat);
      m.castShadow = cast; m.receiveShadow = receive;
      this.level.add(m);
      return m;
    };
    const solid = (x, y) => !inBounds(x, y) || grid[idx(x, y)] === T.WALL;

    // --- walls, floors, ceilings ---
    const bHallWall = new Builder(), bRoomWall = new Builder(), bMetalWall = new Builder();
    const bHallFloor = new Builder(), bRoomFloor = new Builder(), bCeil = new Builder(), bCap = new Builder();
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const t = grid[idx(x, y)];
        const x0 = x * CELL, z0 = y * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
        if (t === T.WALL) { bCap.hquad(x0, z0, x1, z1, WALL_H + 0.02, true, 0, 0, 1, 1); continue; }
        const wallB = t === T.ROOM ? bRoomWall : t === T.ELEV ? bMetalWall : bHallWall;
        for (const [dx, dy] of DIRS) {
          if (!solid(x + dx, y + dy)) continue;
          wallB.vquad(x0 + CELL / 2 + dx * CELL / 2, z0 + CELL / 2 + dy * CELL / 2, -dx, -dy, CELL / 2, 0, WALL_H, 0, 1, 0, 1);
        }
        const fb = t === T.ROOM ? bRoomFloor : bHallFloor;
        const s = t === T.ROOM ? 1 / 1.6 : 1 / 1.25;
        fb.hquad(x0, z0, x1, z1, 0, true, x0 * s, -z1 * s, x1 * s, -z0 * s);
        bCeil.hquad(x0, z0, x1, z1, WALL_H, false, x, y, x + 1, y + 1);
      }
    }
    add(bHallWall, M.hallWall); add(bRoomWall, M.roomWall); add(bMetalWall, M.metal);
    add(bHallFloor, M.hallFloor, false); add(bRoomFloor, M.roomFloor, false);
    add(bCeil, M.ceiling, false); add(bCap, M.cap, false, false);

    // --- furniture + door frames ---
    const bWood = new Builder(), bWoodLight = new Builder(), bSheet = new Builder(), bBlanket = new Builder(), bWardrobe = new Builder();
    const jamb = (CELL - DOOR_W) / 2;
    const plateGeo = new THREE.PlaneGeometry(0.32, 0.16);
    const leafGeo = new THREE.BoxGeometry(DOOR_W - 0.02, DOOR_H - 0.02, 0.06);
    const leafMats = [M.wood, M.wood, M.wood, M.wood, M.door, M.doorBack];
    for (const room of hotel.rooms) {
      const bed = room.bed, f = bed.head;
      bWood.box(bed.x, 0.16, bed.z, bed.sx, 0.32, bed.sz);
      bWood.box(bed.x + f.x * (Math.abs(f.x) * bed.sx / 2 - 0.04), 0.6, bed.z + f.z * (Math.abs(f.z) * bed.sz / 2 - 0.04),
        f.x !== 0 ? 0.08 : bed.sx + 0.08, 1.2, f.z !== 0 ? 0.08 : bed.sz + 0.08);
      bSheet.box(bed.x, 0.43, bed.z, bed.sx - 0.08, 0.22, bed.sz - 0.08, 0.4);
      bSheet.box(bed.x + f.x * 0.72, 0.59, bed.z + f.z * 0.72, f.x !== 0 ? 0.42 : bed.sx * 0.72, 0.12, f.z !== 0 ? 0.42 : bed.sz * 0.72, 0.4);
      bBlanket.box(bed.x - f.x * 0.3, 0.455, bed.z - f.z * 0.3, f.x !== 0 ? bed.sx * 0.68 : bed.sx + 0.03, 0.22, f.z !== 0 ? bed.sz * 0.68 : bed.sz + 0.03, 0.5);

      const ns = room.nightstand;
      bWood.box(ns.x, 0.3, ns.z, ns.sx, 0.6, ns.sz);
      bWoodLight.box(ns.x, 0.615, ns.z, ns.sx + 0.04, 0.03, ns.sz + 0.04);
      bWood.box(ns.x, 0.76, ns.z, 0.07, 0.26, 0.07);

      const wd = room.wardrobe;
      bWood.box(wd.x, wd.h / 2, wd.z, wd.sx, wd.h, wd.sz);
      bWardrobe.vquad(wd.x + wd.front.x * (wd.sx / 2 + 0.006), wd.z + wd.front.z * (wd.sz / 2 + 0.006), wd.front.x, wd.front.z,
        wd.front.x !== 0 ? wd.sz / 2 : wd.sx / 2, 0, wd.h, 0, 1, 0, 1);

      if (room.dresser) { const d = room.dresser; bWoodLight.box(d.x, d.h / 2, d.z, d.sx, d.h, d.sz, 1.4); }
      if (room.suitcase) { const s = room.suitcase; bWoodLight.box(s.x, s.h / 2, s.z, s.sx, s.h, s.sz, 2); }

      // door frame
      const d = room.door;
      const mx = (d.x + 0.5) * CELL, mz = (d.y + 0.5) * CELL;
      const ax = d.dx, az = d.dy;          // passage axis, pointing into the room
      const lx = az, lz = -ax;             // lateral axis
      for (const s of [-1, 1]) {
        const off = s * (DOOR_W / 2 + jamb / 2);
        bWood.box(mx + lx * off, WALL_H / 2, mz + lz * off, Math.abs(lx) * jamb + Math.abs(ax) * 0.28, WALL_H, Math.abs(lz) * jamb + Math.abs(az) * 0.28);
      }
      bWood.box(mx, (DOOR_H + WALL_H) / 2, mz, Math.abs(lx) * DOOR_W + Math.abs(ax) * 0.28, WALL_H - DOOR_H, Math.abs(lz) * DOOR_W + Math.abs(az) * 0.28);

      // swinging leaf
      const theta = Math.atan2(ax, az);
      const pivot = new THREE.Group();
      pivot.position.set(mx - lx * DOOR_W / 2, 0, mz - lz * DOOR_W / 2);
      pivot.rotation.y = theta;
      const leaf = new THREE.Mesh(leafGeo, leafMats);
      leaf.position.set(DOOR_W / 2, DOOR_H / 2, 0);
      leaf.castShadow = true; leaf.receiveShadow = true;
      pivot.add(leaf);
      this.level.add(pivot);
      const door = { cell: idx(d.x, d.y), x: mx, z: mz, pivot, theta, open: 0, target: 0, room: room.id };
      this.doors.push(door);
      this.doorByCell.set(door.cell, door);

      // brass number plate on the corridor side
      const pm = new THREE.MeshLambertMaterial({ map: this.tex.plate(String(room.number)), emissive: 0x332208 });
      pm.userData.ownMap = true;
      const plate = new THREE.Mesh(plateGeo, pm);
      plate.position.set(mx + lx * (DOOR_W / 2 + jamb / 2) - ax * 0.146, 1.66, mz + lz * (DOOR_W / 2 + jamb / 2) - az * 0.146);
      plate.rotation.y = Math.atan2(-ax, -az);
      this.level.add(plate);
    }
    add(bWood, M.wood); add(bWoodLight, M.woodLight); add(bSheet, M.sheet); add(bBlanket, M.blanket); add(bWardrobe, M.wardrobe, false);

    // --- blood ---
    const bBlood = [new Builder(), new Builder(), new Builder(), new Builder()];
    for (const b of hotel.blood) {
      const bb = bBlood[b.variant], s = b.size / 2;
      if (b.wall) {
        const nx = Math.round(Math.sin(b.ry)), nz = Math.round(Math.cos(b.ry));
        bb.vquad(b.x, b.z, nx, nz, s, Math.max(0.02, b.y - s), Math.min(WALL_H - 0.02, b.y + s), 0, 1, 0, 1);
      } else {
        const c = Math.cos(b.ry), sn = Math.sin(b.ry);
        const pt = (px, pz) => [b.x + px * c - pz * sn, b.y, b.z + px * sn + pz * c];
        bb.quad(pt(-s, s), pt(s, s), pt(s, -s), pt(-s, -s), [0, 1, 0], 0, 0, 1, 1);
      }
    }
    bBlood.forEach((b, i) => add(b, M.blood[i], false, true));

    // --- portraits with eyes that follow ---
    const pw = 0.8, ph = 1.0;
    const portraitGeo = new THREE.PlaneGeometry(pw, ph);
    const pupilGeo = new THREE.CircleGeometry(0.0125, 10);
    if (!this.portraitMats) this.portraitMats = this.tex.portraits.map((p) => new THREE.MeshLambertMaterial({ map: p.tex }));
    for (const p of hotel.portraits) {
      const def = this.tex.portraits[p.variant];
      const g = new THREE.Group();
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.ry;
      const m = new THREE.Mesh(portraitGeo, this.portraitMats[p.variant]);
      m.receiveShadow = true;
      g.add(m);
      const pupils = def.eyes.map((e) => {
        const pm = new THREE.Mesh(pupilGeo, M.pupil);
        const bx = (e.x / PORTRAIT_W - 0.5) * pw, by = (0.5 - e.y / PORTRAIT_H) * ph;
        pm.position.set(bx, by, 0.004);
        g.add(pm);
        return { mesh: pm, bx, by };
      });
      this.level.add(g);
      this.portraits.push({ x: p.x, y: p.y, z: p.z, cos: Math.cos(p.ry), sin: Math.sin(p.ry), pupils, ox: 0, oy: 0 });
    }
    this.sharedMats = new Set([...this.matList, ...this.portraitMats]);

    // --- the bricked-up front doors behind the start ---
    if (hotel.noExit) {
      const ne = hotel.noExit;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.7), new THREE.MeshLambertMaterial({ map: this.tex.noExit }));
      m.position.set(ne.x, 1.35, ne.z); m.rotation.y = ne.ry; m.receiveShadow = true;
      this.level.add(m);
    }

    // --- elevator ---
    this.buildElevator(hotel.elevator);

    // --- light fixtures ---
    const ceilN = hotel.lights.filter((l) => l.kind === 'ceiling').length;
    const lampN = hotel.lights.length - ceilN;
    this.ceilMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.06, 0.62), M.glow, Math.max(1, ceilN));
    this.lampMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.17, 0.24, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), Math.max(1, lampN));
    const mat4 = new THREE.Matrix4();
    let ci = 0, li = 0;
    for (const l of hotel.lights) {
      const isCeil = l.kind === 'ceiling';
      const f = {
        x: l.x, y: l.y, z: l.z, kind: l.kind, dead: l.dead, broken: l.broken,
        cell: idx(Math.floor(l.x / CELL), Math.floor(l.z / CELL)),
        level: 0, on: true, t: Math.random() * 20, flick: 0, mesh: isCeil ? this.ceilMesh : this.lampMesh, inst: isCeil ? ci++ : li++,
        color: isCeil ? WARM : LAMP, power: isCeil ? 1 : 0.5, ly: isCeil ? l.y - 0.5 : l.y + 0.2, delay: 0,
      };
      mat4.makeTranslation(l.x, l.y, l.z);
      f.mesh.setMatrixAt(f.inst, mat4);
      f.mesh.setColorAt(f.inst, this._tmpColor.setRGB(0, 0, 0));
      this.fixtures.push(f);
    }
    this.ceilMesh.frustumCulled = false; this.lampMesh.frustumCulled = false;
    this.level.add(this.ceilMesh); this.level.add(this.lampMesh);
    // the elevator's own cold light, off until the doors unlock
    const e = hotel.elevator;
    this.elevFixture = {
      x: (e.x + 0.5) * CELL, y: WALL_H - 0.05, z: (e.y + 0.5) * CELL, kind: 'elev', dead: false, broken: false,
      cell: idx(e.hallX, e.hallY), level: 0, on: true, t: 0, flick: 0, mesh: null, inst: 0, color: COLD, power: 0.9, ly: WALL_H - 0.6, delay: 0,
    };
    this.fixtures.push(this.elevFixture);

    // --- pickups ---
    for (const p of hotel.pickups) this.addPickup(p);
  }

  buildElevator(e) {
    const M = this.mats;
    const g = new THREE.Group();
    const hx = (e.hallX + 0.5) * CELL, hz = (e.hallY + 0.5) * CELL;
    g.position.set(hx + e.dx * CELL / 2, 0, hz + e.dy * CELL / 2);
    g.rotation.y = Math.atan2(e.dx, e.dy); // local +Z points into the car
    const ej = (CELL - ELEV_W) / 2, EH = 2.35;
    const b = new Builder();
    for (const s of [-1, 1]) b.box(s * (ELEV_W / 2 + ej / 2), WALL_H / 2, 0, ej, WALL_H, 0.26, 0.5);
    b.box(0, (EH + WALL_H) / 2, 0, ELEV_W, WALL_H - EH, 0.26, 0.5);
    b.box(0, WALL_H / 2, CELL - 0.1, CELL, WALL_H, 0.2, 0.4);
    const frame = new THREE.Mesh(b.build(), M.metal);
    frame.castShadow = true; frame.receiveShadow = true;
    g.add(frame);
    const doorGeo = new THREE.BoxGeometry(ELEV_W / 2, EH, 0.06);
    const doors = [-1, 1].map((s) => {
      const d = new THREE.Mesh(doorGeo, M.metal);
      d.position.set(s * ELEV_W / 4, EH / 2, 0.04);
      d.castShadow = true; d.receiveShadow = true;
      g.add(d);
      return { mesh: d, side: s };
    });
    const signMat = new THREE.MeshBasicMaterial({ map: this.tex.elevSign });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.24), signMat);
    sign.position.set(0, 2.66, -0.14); sign.rotation.y = Math.PI;
    g.add(sign);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xff2010 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), lampMat);
    lamp.position.set(-(ELEV_W / 2 + 0.22), 1.45, -0.15);
    g.add(lamp);
    const panelMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.9), panelMat);
    panel.position.set(0, WALL_H - 0.04, CELL / 2);
    g.add(panel);
    this.level.add(g);
    this.elev = { group: g, doors, lampMat, panelMat, signMat, open: 0, x: hx + e.dx * CELL / 2, z: hz + e.dy * CELL / 2 };
  }

  addPickup(p) {
    const g = new THREE.Group();
    g.position.set(p.x, p.y, p.z);
    let glowColor;
    if (p.type === 'key') {
      const mats = [0, 1, 2, 3].map(() => new THREE.MeshBasicMaterial({ color: 0x8a8068 }));
      const face = new THREE.MeshBasicMaterial({ map: this.tex.keycard });
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.012, 0.165), [mats[0], mats[1], face, face, mats[2], mats[3]]);
      m.rotation.z = 0.5;
      g.add(m);
      glowColor = 0xffd070;
    } else if (p.type === 'battery') {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.17, 10), new THREE.MeshLambertMaterial({ color: 0x1c6a2a, emissive: 0x0a3010 }));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), new THREE.MeshLambertMaterial({ color: 0xb0b0b0, emissive: 0x303030 }));
      cap.position.y = 0.1;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.05, 10), new THREE.MeshLambertMaterial({ color: 0xc9a43c, emissive: 0x403010 }));
      band.position.y = 0.05;
      g.add(body, cap, band);
      g.rotation.z = 0.35;
      glowColor = 0x60ff80;
    } else {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 10), new THREE.MeshLambertMaterial({ color: 0x9c1414, emissive: 0x400808 }));
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 10), new THREE.MeshLambertMaterial({ color: 0xd8c070, emissive: 0x403010 }));
      tip.position.y = 0.205;
      const stick = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.42, 0.012), new THREE.MeshLambertMaterial({ color: 0x6a5030 }));
      stick.position.set(0.045, -0.2, 0);
      g.add(body, tip, stick);
      g.rotation.z = 0.5;
      glowColor = 0xff7030;
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.glow, color: glowColor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
    halo.scale.setScalar(p.type === 'key' ? 0.75 : 0.5);
    g.add(halo);
    g.traverse((o) => { if (o.material && !o.isSprite) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.userData.own = true; }); });
    this.level.add(g);
    this.pickups.set(p.id, { group: g, halo, baseY: p.y, phase: p.id * 1.7, type: p.type });
  }

  removePickup(id) {
    const p = this.pickups.get(id);
    if (!p) return;
    this.level.remove(p.group);
    p.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.pickups.delete(id);
  }

  isDoorClosed(cell) {
    const d = this.doorByCell.get(cell);
    return d ? d.open < 0.35 : false;
  }

  setElevatorUnlocked(on) {
    this.elevUnlocked = on;
    if (this.elev) this.elev.lampMat.color.setHex(on ? 0x30ff50 : 0xff2010);
  }

  setPower(out) {
    if (this.powerOut && !out) {
      for (const f of this.fixtures) { f.delay = Math.random() * 1.4; f.flick = 2 + 2 * Math.floor(Math.random() * 4); f.t = 0; }
    }
    this.powerOut = out;
  }

  setSpectate(on) {
    this.spectate = on;
    this.scene.fog.density = on ? 0.0035 : FOG_DENSITY;
    this.scene.background.setHex(on ? 0x0a0b10 : 0x030202);
    this.scene.fog.color.setHex(on ? 0x0a0b10 : 0x050303);
    this.hemi.intensity = on ? 3.2 : HEMI;
    this.hemi.color.setHex(on ? 0xfff2e2 : 0x4a3434);
    this.hemi.groundColor.setHex(on ? 0x8a7a70 : 0x1a100c);
    this.sun.intensity = on ? 2.2 : 0;
    const u = this.postMat.uniforms;
    u.uGrain.value = on ? 0.025 : 0.075;
    u.uVignette.value = on ? 0.35 : 1;
    for (const b of this.beacons) b.group.visible = on && b.wanted;
  }

  /** level: 0..1 brightness, sway: small offsets of the beam */
  setFlashlight(level, swayX = 0, swayY = 0) {
    this.flash.intensity = this.spectate ? 0 : FLASH_POWER * level;
    this.flash.target.position.set(swayX, swayY, -8);
  }

  claimRemoteSpot() {
    const s = this.remoteSpots.find((r) => !r.userData.used);
    if (s) s.userData.used = true;
    return s || null;
  }

  createAvatar(name) {
    const a = new Avatar(this, name);
    a.spot = this.claimRemoteSpot();
    return a;
  }

  /** A pillar of light + label, only shown to spectators. */
  makeBeacon(color, label) {
    const group = new THREE.Group();
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 60, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    pillar.position.y = 30;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
    const css = '#' + new THREE.Color(color).getHexString();
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTag(label, css), depthTest: false, transparent: true, fog: false, sizeAttenuation: false }));
    tag.scale.set(0.2, 0.05, 1); tag.position.y = 3.5; tag.renderOrder = 10;
    group.add(pillar, ring, tag);
    group.visible = false;
    this.dyn.add(group);
    const b = { group, wanted: true };
    this.beacons.push(b);
    return {
      set: (x, z, wanted = true) => { group.position.set(x, 0, z); b.wanted = wanted; group.visible = this.spectate && wanted; },
      dispose: () => { this.dyn.remove(group); this.beacons.splice(this.beacons.indexOf(b), 1); },
    };
  }

  makeRocketMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8), new THREE.MeshBasicMaterial({ color: 0xc02020 }));
    body.rotation.x = Math.PI / 2;
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.glow, color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flare.scale.setScalar(0.9); flare.position.z = 0.2;
    g.add(body, flare);
    this.dyn.add(g);
    return g;
  }

  fxFlash(x, y, z, intensity, decay = 4, color = 0xff8a30) {
    this.fxLight.position.set(x, y, z);
    this.fxLight.color.setHex(color);
    this.fxLight.intensity = intensity;
    this.fxDecay = decay;
  }

  explode(x, y, z) {
    this.fxFlash(x, y, z, 420, 3.2, 0xffb060);
    this.particles.burst(x, y, z, 150, 9, 1.3, 1.0, 0.55, 0.15, 5);
    this.particles.burst(x, y, z, 60, 4, 2.0, 1.0, 0.85, 0.5, 1.5);
    this.particles.burst(x, y, z, 40, 14, 0.6, 0.6, 0.8, 1.0, 2);
  }

  // -------------------------------------------------------------------------
  /** viewer: {x,y,z}; actors: [{x,z}] - anyone who can open doors */
  update(dt, time, viewer, actors) {
    if (!this.hotel) return;
    this.updateFixtures(dt);
    this.updatePool(dt, viewer);
    this.updateDoors(dt, actors);
    this.updatePortraits(dt, viewer);
    this.updateElevator(dt, viewer);
    for (const p of this.pickups.values()) {
      p.group.position.y = p.baseY + 0.05 + Math.sin(time * 2 + p.phase) * 0.035;
      p.group.rotation.y = time * 1.2 + p.phase;
      p.halo.material.opacity = 0.4 + Math.sin(time * 3 + p.phase) * 0.15;
    }
    this.particles.update(dt);
    if (this.fxLight.intensity > 0.01) this.fxLight.intensity *= Math.exp(-this.fxDecay * dt); else this.fxLight.intensity = 0;
    this.postMat.uniforms.uTime.value = time;
  }

  updateFixtures(dt) {
    const col = this._tmpColor;
    for (const f of this.fixtures) {
      let target;
      if (f.kind === 'elev') target = this.elevUnlocked ? 1 : 0;
      else if (f.dead || this.powerOut) target = 0;
      else if (f.delay > 0) { f.delay -= dt; target = 0; }
      else {
        f.t -= dt;
        if (f.broken) {
          if (f.t <= 0) { f.on = Math.random() < 0.55; f.t = f.on ? 0.04 + Math.random() * 0.8 : 0.03 + Math.random() * 0.4; }
          target = f.on ? 0.8 + Math.random() * 0.2 : 0.02;
        } else {
          if (f.t <= 0) {
            if (f.flick > 0) { f.flick--; f.on = !f.on; f.t = 0.03 + Math.random() * 0.1; if (f.flick === 0) f.on = true; }
            else { f.on = true; f.t = 5 + Math.random() * 30; f.flick = 2 + 2 * Math.floor(Math.random() * 3); }
          }
          target = f.on ? 1 : 0.06;
        }
      }
      f.level += (target - f.level) * Math.min(1, dt * 28);
      if (f.mesh) {
        const v = f.level * 1.6 + (f.dead ? 0.015 : 0.03);
        f.mesh.setColorAt(f.inst, col.setRGB(f.color.r * v, f.color.g * v, f.color.b * v));
      } else if (this.elev) {
        this.elev.panelMat.color.setRGB(f.color.r * f.level * 1.5, f.color.g * f.level * 1.5, f.color.b * f.level * 1.5);
      }
    }
    if (this.ceilMesh.instanceColor) this.ceilMesh.instanceColor.needsUpdate = true;
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
  }

  updatePool(dt, viewer) {
    this.poolTimer -= dt;
    if (this.poolTimer <= 0) {
      this.poolTimer = 0.15;
      const vx = Math.floor(viewer.x / CELL), vy = Math.floor(viewer.z / CELL);
      const vc = inBounds(vx, vy) && viewer.y < WALL_H ? idx(vx, vy) : -1;
      if (vc !== this.viewerCell) {
        this.viewerCell = vc;
        this.distField = vc >= 0 && this.hotel.grid[vc] !== T.WALL ? bfs(this.hotel.grid, vx, vy) : null;
      }
      const cands = [];
      for (const f of this.fixtures) {
        if (f.dead) continue;
        const e = Math.hypot(f.x - viewer.x, f.z - viewer.z);
        if (e > 30) continue;
        let score = e;
        if (this.distField) {
          const pd = this.distField[f.cell];
          if (pd < 0 || pd > 12) continue;
          score = e + pd * CELL * 0.8;
        }
        cands.push({ f, score });
      }
      cands.sort((a, b) => a.score - b.score);
      const want = cands.slice(0, POOL_SIZE).map((c) => c.f);
      const free = [];
      for (const s of this.pool) {
        const k = want.indexOf(s.target);
        if (k >= 0) want.splice(k, 1); else free.push(s);
      }
      for (const s of free) s.target = want.length ? want.shift() : null;
    }
    let buzz = 0;
    for (const s of this.pool) {
      if (s.fixture !== s.target) {
        // hand over: fade the old fixture out before taking the new one
        s.gain -= dt * 3.5;
        if (s.gain <= 0) { s.gain = 0; s.fixture = s.target; }
      } else if (s.fixture) {
        s.gain = Math.min(1, s.gain + dt * 3.5);
      }
      const f = s.fixture;
      if (!f) { s.light.intensity = 0; continue; }
      const e = Math.hypot(f.x - viewer.x, f.z - viewer.z);
      const fade = THREE.MathUtils.clamp((30 - e) / 8, 0, 1);
      s.light.position.set(f.x, f.ly, f.z);
      s.light.color.copy(f.color);
      s.light.intensity = (this.spectate ? 5 : POOL_POWER) * f.power * f.level * s.gain * fade;
      if (f.kind === 'ceiling') buzz = Math.max(buzz, f.level * THREE.MathUtils.clamp(1 - e / 7, 0, 1));
    }
    this.buzz = buzz;
  }

  updateDoors(dt, actors) {
    for (const d of this.doors) {
      let near = false;
      for (let i = 0; i < actors.length; i++) {
        const a = actors[i];
        const dx = a.x - d.x, dz = a.z - d.z;
        if (dx * dx + dz * dz < 2.9) { near = true; break; } // ~1.7 m from the door's centre
      }
      const target = near ? 1 : 0;
      if (target !== d.target) {
        d.target = target;
        if (this.onDoorMove) this.onDoorMove(d, target === 1);
      }
      if (d.open !== d.target) {
        d.open += (d.target - d.open) * Math.min(1, dt * (d.target ? 5 : 2.2));
        if (Math.abs(d.open - d.target) < 0.002) d.open = d.target;
        d.pivot.rotation.y = d.theta - d.open * 1.72;
      }
    }
  }

  updatePortraits(dt, viewer) {
    for (const p of this.portraits) {
      const dx = viewer.x - p.x, dy = viewer.y - p.y, dz = viewer.z - p.z;
      const d2 = dx * dx + dz * dz;
      let tx = 0, ty = 0;
      if (d2 < 100) {
        const lx = dx * p.cos - dz * p.sin, lz = dx * p.sin + dz * p.cos;
        if (lz > 0.05) {
          tx = THREE.MathUtils.clamp(lx / (lz + 0.4), -1, 1) * 0.0165;
          ty = THREE.MathUtils.clamp(dy / (lz + 0.4), -1, 1) * 0.007;
        }
      } else if (p.ox === 0 && p.oy === 0) continue;
      p.ox += (tx - p.ox) * Math.min(1, dt * 5);
      p.oy += (ty - p.oy) * Math.min(1, dt * 5);
      for (const e of p.pupils) e.mesh.position.set(e.bx + p.ox, e.by + p.oy, 0.004);
    }
  }

  updateElevator(dt, viewer) {
    const el = this.elev;
    if (!el) return;
    const near = Math.hypot(viewer.x - el.x, viewer.z - el.z) < 4.5;
    const target = this.elevUnlocked && near ? 1 : 0;
    el.open += (target - el.open) * Math.min(1, dt * 2.2);
    for (const d of el.doors) d.mesh.position.x = d.side * (ELEV_W / 4 + el.open * ELEV_W * 0.47);
  }

  render() {
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
  }

  setFear(v) { this.postMat.uniforms.uFear.value = v; }
  setScreenFlash(v) { this.postMat.uniforms.uFlash.value = v; }
}

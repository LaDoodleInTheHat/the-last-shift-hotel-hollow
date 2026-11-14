// maze.js - seeded hotel generation, pathfinding and line-of-sight.
// Pure data, no rendering: the same seed always produces the same hotel on every client.

export const GRID = 39;      // cells per side
export const CELL = 2.5;     // metres per cell
export const WALL_H = 3;     // ceiling height
export const DOOR_W = 1.2;   // door opening width
export const DOOR_H = 2.25;  // door opening height
export const ELEV_W = 1.4;   // elevator opening width
export const T = { WALL: 0, HALL: 1, ROOM: 2, DOOR: 3, ELEV: 4 };

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Any string becomes a 32-bit seed. Plain numbers are used as-is so seeds can be shared.
export function hashSeed(str) {
  const s = String(str).trim();
  if (/^\d{1,10}$/.test(s)) return Number(s) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const idx = (x, y) => y * GRID + x;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < GRID && y < GRID;
export const walkable = (t) => t === T.HALL || t === T.ROOM || t === T.DOOR;
export const cellCenter = (x, y) => ({ x: (x + 0.5) * CELL, z: (y + 0.5) * CELL });
export const worldToCell = (wx, wz) => ({ x: Math.floor(wx / CELL), y: Math.floor(wz / CELL) });

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

/** Breadth-first distance field over walkable cells. -1 = unreachable. */
export function bfs(grid, sx, sy) {
  const dist = new Int16Array(GRID * GRID).fill(-1);
  if (!inBounds(sx, sy)) return dist;
  const queue = new Int32Array(GRID * GRID);
  let head = 0, tail = 0;
  dist[idx(sx, sy)] = 0;
  queue[tail++] = idx(sx, sy);
  while (head < tail) {
    const c = queue[head++];
    const cx = c % GRID, cy = (c / GRID) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!inBounds(nx, ny)) continue;
      const n = idx(nx, ny);
      if (dist[n] !== -1 || !walkable(grid[n])) continue;
      dist[n] = dist[c] + 1;
      queue[tail++] = n;
    }
  }
  return dist;
}

/** A* on the grid (4-connected, Manhattan heuristic). Returns [cellIndex...] start..goal, or null. */
export function astar(grid, sx, sy, tx, ty) {
  if (!inBounds(sx, sy) || !inBounds(tx, ty)) return null;
  const start = idx(sx, sy), goal = idx(tx, ty);
  if (!walkable(grid[goal]) || !walkable(grid[start])) return null;
  if (start === goal) return [start];
  const N = GRID * GRID;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  // binary heap of [f, cell]
  const heapF = [], heapC = [];
  const push = (f, c) => {
    let i = heapF.length;
    heapF.push(f); heapC.push(c);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      const tf = heapF[p]; heapF[p] = heapF[i]; heapF[i] = tf;
      const tc = heapC[p]; heapC[p] = heapC[i]; heapC[i] = tc;
      i = p;
    }
  };
  const pop = () => {
    const c = heapC[0];
    const lf = heapF.pop(), lc = heapC.pop();
    if (heapF.length) {
      heapF[0] = lf; heapC[0] = lc;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        const tf = heapF[m]; heapF[m] = heapF[i]; heapF[i] = tf;
        const tc = heapC[m]; heapC[m] = heapC[i]; heapC[i] = tc;
        i = m;
      }
    }
    return c;
  };
  g[start] = 0;
  push(Math.abs(tx - sx) + Math.abs(ty - sy), start);
  while (heapF.length) {
    const c = pop();
    if (c === goal) {
      const path = [];
      for (let p = goal; p !== -1; p = came[p]) path.push(p);
      return path.reverse();
    }
    if (closed[c]) continue;
    closed[c] = 1;
    const cx = c % GRID, cy = (c / GRID) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!inBounds(nx, ny)) continue;
      const n = idx(nx, ny);
      if (closed[n] || !walkable(grid[n])) continue;
      const ng = g[c] + 1;
      if (ng < g[n]) {
        g[n] = ng;
        came[n] = c;
        push(ng + Math.abs(tx - nx) + Math.abs(ty - ny), n);
      }
    }
  }
  return null;
}

/**
 * Grid line-of-sight between two world points (Amanatides & Woo traversal).
 * Walls block; doors block when isDoorClosed(cellIndex) says so.
 */
export function lineOfSight(grid, x0, z0, x1, z1, isDoorClosed) {
  let cx = Math.floor(x0 / CELL), cy = Math.floor(z0 / CELL);
  const ex = Math.floor(x1 / CELL), ey = Math.floor(z1 / CELL);
  const dx = x1 - x0, dz = z1 - z0;
  const stepX = dx > 0 ? 1 : -1, stepY = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
  const tDeltaY = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * CELL - x0 : x0 - cx * CELL) / Math.abs(dx)) : Infinity;
  let tMaxY = dz !== 0 ? ((dz > 0 ? (cy + 1) * CELL - z0 : z0 - cy * CELL) / Math.abs(dz)) : Infinity;
  for (let guard = 0; guard < GRID * 3; guard++) {
    if (!inBounds(cx, cy)) return false;
    const c = idx(cx, cy);
    const t = grid[c];
    if (t === T.WALL) return false;
    if (t === T.DOOR && isDoorClosed && isDoorClosed(c) && !(cx === ex && cy === ey)) return false;
    if (cx === ex && cy === ey) return true;
    if (tMaxX < tMaxY) { tMaxX += tDeltaX; cx += stepX; } else { tMaxY += tDeltaY; cy += stepY; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateHotel(seed) {
  seed = seed >>> 0;
  const rng = mulberry32(seed);
  const ri = (n) => Math.floor(rng() * n);
  const grid = new Uint8Array(GRID * GRID); // all WALL
  const inRoom = new Uint8Array(GRID * GRID);

  // --- 1. Guest rooms: odd-aligned rectangles, alone or in adjoining pairs --------------
  let rooms = [];
  for (let attempt = 0; attempt < 4000 && rooms.length < 40; attempt++) {
    const r = rng();
    const w = r < 0.62 ? 3 : r < 0.81 ? 5 : 3;
    const h = r < 0.62 ? 3 : r < 0.81 ? 3 : 5;
    const x0 = 1 + 2 * ri((GRID - w) / 2);
    const y0 = 1 + 2 * ri((GRID - h) / 2);
    const x1 = x0 + w - 1, y1 = y0 + h - 1;
    let ok = true, adj = null, adjCount = 0;
    for (const e of rooms) {
      const gx = Math.max(x0 - e.x1, e.x0 - x1) - 1;
      const gy = Math.max(y0 - e.y1, e.y0 - y1) - 1;
      if (gx >= 3 || gy >= 3) continue;
      if ((gx === 1 && gy < 0) || (gy === 1 && gx < 0)) { adj = e; adjCount++; continue; }
      ok = false; break;
    }
    if (!ok) continue;
    if (adjCount > 1 || (adj && (adj.partner || rng() > 0.6))) continue;
    const room = { x0, y0, x1, y1, w, h, partner: false };
    if (adj) { adj.partner = true; room.partner = true; }
    rooms.push(room);
  }
  for (const room of rooms) {
    for (let y = room.y0; y <= room.y1; y++) for (let x = room.x0; x <= room.x1; x++) inRoom[idx(x, y)] = 1;
  }

  // --- 2. Corridors: recursive-backtracker maze over the remaining odd cells -------------
  const region = new Int16Array(GRID * GRID).fill(-1);
  const regionSize = [];
  for (let sy = 1; sy < GRID; sy += 2) {
    for (let sx = 1; sx < GRID; sx += 2) {
      const s = idx(sx, sy);
      if (inRoom[s] || region[s] !== -1) continue;
      const rid = regionSize.length;
      let size = 0;
      const stack = [s];
      region[s] = rid; grid[s] = T.HALL; size++;
      while (stack.length) {
        const c = stack[stack.length - 1];
        const cx = c % GRID, cy = (c / GRID) | 0;
        const opts = [];
        for (let d = 0; d < 4; d++) {
          const nx = cx + DIRS[d][0] * 2, ny = cy + DIRS[d][1] * 2;
          if (nx < 1 || ny < 1 || nx > GRID - 2 || ny > GRID - 2) continue;
          const n = idx(nx, ny);
          if (inRoom[n] || region[n] !== -1) continue;
          opts.push(d);
        }
        if (!opts.length) { stack.pop(); continue; }
        const d = opts[ri(opts.length)];
        const bx = cx + DIRS[d][0], by = cy + DIRS[d][1];
        const nx = cx + DIRS[d][0] * 2, ny = cy + DIRS[d][1] * 2;
        grid[idx(bx, by)] = T.HALL; region[idx(bx, by)] = rid;
        grid[idx(nx, ny)] = T.HALL; region[idx(nx, ny)] = rid;
        size += 2;
        stack.push(idx(nx, ny));
      }
      regionSize.push(size);
    }
  }
  // Keep only the largest corridor network; seal any pockets cut off by rooms.
  let main = 0;
  for (let i = 1; i < regionSize.length; i++) if (regionSize[i] > regionSize[main]) main = i;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === T.HALL && region[i] !== main) grid[i] = T.WALL;
  }

  // --- 3. One door per room, opening onto the corridor network ---------------------------
  const doored = [];
  for (const room of rooms) {
    const cands = [];
    for (let x = room.x0; x <= room.x1; x += 2) {
      if (room.y0 - 2 >= 1 && grid[idx(x, room.y0 - 2)] === T.HALL) cands.push({ x, y: room.y0 - 1, dx: 0, dy: 1 });
      if (room.y1 + 2 <= GRID - 2 && grid[idx(x, room.y1 + 2)] === T.HALL) cands.push({ x, y: room.y1 + 1, dx: 0, dy: -1 });
    }
    for (let y = room.y0; y <= room.y1; y += 2) {
      if (room.x0 - 2 >= 1 && grid[idx(room.x0 - 2, y)] === T.HALL) cands.push({ x: room.x0 - 1, y, dx: 1, dy: 0 });
      if (room.x1 + 2 <= GRID - 2 && grid[idx(room.x1 + 2, y)] === T.HALL) cands.push({ x: room.x1 + 1, y, dx: -1, dy: 0 });
    }
    if (!cands.length) continue; // walled in: it never existed
    room.door = cands[ri(cands.length)];
    doored.push(room);
  }
  rooms = doored;
  while (rooms.length > 30) rooms.splice(ri(rooms.length), 1);
  rooms.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  rooms.forEach((room, i) => {
    room.id = i;
    room.number = 101 + i;
    room.wx = (room.x0 + room.w / 2) * CELL;
    room.wz = (room.y0 + room.h / 2) * CELL;
    for (let y = room.y0; y <= room.y1; y++) for (let x = room.x0; x <= room.x1; x++) grid[idx(x, y)] = T.ROOM;
    grid[idx(room.door.x, room.door.y)] = T.DOOR;
  });

  // --- 4. Knock out ~10% of the walls between corridors to create loops ------------------
  const loopCands = [];
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      if (grid[idx(x, y)] !== T.WALL) continue;
      if (x % 2 === 0 && y % 2 === 1 && grid[idx(x - 1, y)] === T.HALL && grid[idx(x + 1, y)] === T.HALL) loopCands.push(idx(x, y));
      else if (x % 2 === 1 && y % 2 === 0 && grid[idx(x, y - 1)] === T.HALL && grid[idx(x, y + 1)] === T.HALL) loopCands.push(idx(x, y));
    }
  }
  shuffle(loopCands, rng);
  const loopsOpened = Math.round(loopCands.length * 0.1);
  for (let i = 0; i < loopsOpened; i++) grid[loopCands[i]] = T.HALL;

  // --- 5. Start, dead ends, elevator ------------------------------------------------------
  const openNeighbours = (x, y) => {
    const out = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (inBounds(nx, ny) && walkable(grid[idx(nx, ny)])) out.push(d);
    }
    return out;
  };
  const hallCells = [];
  let deadEnds = [];
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      if (grid[idx(x, y)] !== T.HALL) continue;
      hallCells.push(idx(x, y));
      const open = openNeighbours(x, y);
      if (open.length === 1 && grid[idx(x + DIRS[open[0]][0], y + DIRS[open[0]][1])] === T.HALL) {
        deadEnds.push({ x, y, open: open[0] });
      }
    }
  }
  let startDE = deadEnds.length ? deadEnds[ri(deadEnds.length)] : null;
  const startCell = startDE ? { x: startDE.x, y: startDE.y } : (() => {
    const c = hallCells[ri(hallCells.length)];
    return { x: c % GRID, y: (c / GRID) | 0 };
  })();
  const distFromStart = bfs(grid, startCell.x, startCell.y);
  let maxDist = 1;
  for (let i = 0; i < distFromStart.length; i++) if (distFromStart[i] > maxDist) maxDist = distFromStart[i];

  // Elevator: the dead end with the longest walk from the start, set into its end wall.
  let elev = null, elevScore = -1;
  for (const de of deadEnds) {
    if (de === startDE) continue;
    const ex = -DIRS[de.open][0], ey = -DIRS[de.open][1];
    const ax = de.x + ex, ay = de.y + ey;           // alcove cell
    const bx = de.x + ex * 2, by = de.y + ey * 2;   // what lies behind it
    if (!inBounds(ax, ay) || grid[idx(ax, ay)] !== T.WALL) continue;
    const behindSolid = !inBounds(bx, by) || grid[idx(bx, by)] === T.WALL;
    const score = distFromStart[idx(de.x, de.y)] + (behindSolid ? 1000 : 0);
    if (score > elevScore) { elevScore = score; elev = { x: ax, y: ay, dx: ex, dy: ey, hallX: de.x, hallY: de.y, de }; }
  }
  if (!elev) {
    // Degenerate hotel with no usable dead end: take the farthest corridor cell with a wall beside it.
    for (const c of hallCells) {
      const x = c % GRID, y = (c / GRID) | 0;
      for (let d = 0; d < 4; d++) {
        const ax = x + DIRS[d][0], ay = y + DIRS[d][1];
        if (!inBounds(ax, ay) || grid[idx(ax, ay)] !== T.WALL) continue;
        if (distFromStart[c] > elevScore) { elevScore = distFromStart[c]; elev = { x: ax, y: ay, dx: DIRS[d][0], dy: DIRS[d][1], hallX: x, hallY: y, de: null }; }
      }
    }
  }
  grid[idx(elev.x, elev.y)] = T.ELEV;
  const elevDE = elev.de;
  delete elev.de;
  deadEnds = deadEnds.filter((d) => d !== startDE && d !== elevDE);

  // --- 6. Furniture -----------------------------------------------------------------------
  const colliders = [];
  for (const room of rooms) layoutRoom(room, rng, colliders);

  // Door frames: solid jambs either side of the opening.
  const jamb = (CELL - DOOR_W) / 2;
  for (const room of rooms) {
    const d = room.door;
    const cx0 = d.x * CELL, cz0 = d.y * CELL;
    const mx = cx0 + CELL / 2, mz = cz0 + CELL / 2;
    if (d.dx !== 0) {
      colliders.push({ x0: mx - 0.14, x1: mx + 0.14, z0: cz0, z1: cz0 + jamb });
      colliders.push({ x0: mx - 0.14, x1: mx + 0.14, z0: cz0 + CELL - jamb, z1: cz0 + CELL });
    } else {
      colliders.push({ x0: cx0, x1: cx0 + jamb, z0: mz - 0.14, z1: mz + 0.14 });
      colliders.push({ x0: cx0 + CELL - jamb, x1: cx0 + CELL, z0: mz - 0.14, z1: mz + 0.14 });
    }
  }
  // Elevator: jambs either side of the sliding doors, and the car's back wall.
  {
    const bx = (elev.hallX + 0.5) * CELL + elev.dx * CELL / 2, bz = (elev.hallY + 0.5) * CELL + elev.dy * CELL / 2;
    const ej = (CELL - ELEV_W) / 2;
    for (const s of [-1, 1]) {
      const off = s * (ELEV_W / 2 + ej / 2);
      const jx = bx + (elev.dy !== 0 ? off : 0), jz = bz + (elev.dx !== 0 ? off : 0);
      const hx = elev.dy !== 0 ? ej / 2 : 0.12, hz = elev.dx !== 0 ? ej / 2 : 0.12;
      colliders.push({ x0: jx - hx, x1: jx + hx, z0: jz - hz, z1: jz + hz });
    }
  }
  {
    const mx = (elev.x + 0.5) * CELL + elev.dx * (CELL / 2 - 0.1);
    const mz = (elev.y + 0.5) * CELL + elev.dy * (CELL / 2 - 0.1);
    const hx = elev.dx !== 0 ? 0.1 : CELL / 2, hz = elev.dy !== 0 ? 0.1 : CELL / 2;
    colliders.push({ x0: mx - hx, x1: mx + hx, z0: mz - hz, z1: mz + hz });
  }
  const colliderGrid = new Map();
  for (const c of colliders) {
    const xa = Math.floor((c.x0 - 0.6) / CELL), xb = Math.floor((c.x1 + 0.6) / CELL);
    const za = Math.floor((c.z0 - 0.6) / CELL), zb = Math.floor((c.z1 + 0.6) / CELL);
    for (let y = za; y <= zb; y++) for (let x = xa; x <= xb; x++) {
      if (!inBounds(x, y)) continue;
      const k = idx(x, y);
      if (!colliderGrid.has(k)) colliderGrid.set(k, []);
      colliderGrid.get(k).push(c);
    }
  }

  // --- 7. Keycards: 5 rooms, at least 8 cells from the start and from each other ----------
  const pickups = [];
  const roomCell = (room) => ({ x: room.x0 + (room.w - 1) / 2, y: room.y0 + (room.h - 1) / 2 });
  let keyRooms = [];
  for (let minD = 8; minD >= 0 && keyRooms.length < 5; minD--) {
    keyRooms = [];
    const order = shuffle(rooms.slice(), rng);
    for (const room of order) {
      const c = roomCell(room);
      if (Math.hypot(c.x - startCell.x, c.y - startCell.y) < minD) continue;
      if (keyRooms.some((k) => { const kc = roomCell(k); return Math.hypot(c.x - kc.x, c.y - kc.y) < minD; })) continue;
      keyRooms.push(room);
      if (keyRooms.length === 5) break;
    }
  }
  for (const room of keyRooms) {
    room.hasKey = true;
    const spot = room.keySpots[ri(room.keySpots.length)];
    pickups.push({ id: pickups.length, type: 'key', x: spot.x, y: spot.y, z: spot.z, room: room.id });
  }

  // --- 8. Batteries (~8) and rockets (~4) in rooms and dead ends --------------------------
  const spots = [];
  for (const de of deadEnds) {
    const c = cellCenter(de.x, de.y);
    spots.push({ x: c.x + (rng() - 0.5) * 0.8, y: 0.16, z: c.z + (rng() - 0.5) * 0.8, kind: 'dead' });
  }
  for (const room of rooms) {
    if (room.hasKey) continue;
    spots.push({ x: room.wx + (rng() - 0.5) * 1.2, y: 0.16, z: room.wz + (rng() - 0.5) * 1.2, kind: 'room' });
  }
  shuffle(spots, rng);
  // Keep loot from clumping on the start.
  const startW = cellCenter(startCell.x, startCell.y);
  spots.sort((a, b) => (Math.hypot(a.x - startW.x, a.z - startW.z) < 10 ? 1 : 0) - (Math.hypot(b.x - startW.x, b.z - startW.z) < 10 ? 1 : 0));
  const wanted = ['battery', 'rocket', 'battery', 'battery', 'rocket', 'battery', 'battery', 'rocket', 'battery', 'battery', 'rocket', 'battery'];
  for (let i = 0; i < wanted.length && i < spots.length; i++) {
    const s = spots[i];
    pickups.push({ id: pickups.length, type: wanted[i], x: s.x, y: s.y, z: s.z });
  }

  // --- 9. Lights ---------------------------------------------------------------------------
  const lights = [];
  const lightCells = [];
  const tryLight = (x, y, force) => {
    if (!force) for (const l of lightCells) if (Math.max(Math.abs(l.x - x), Math.abs(l.y - y)) < 3) return;
    lightCells.push({ x, y });
    const c = cellCenter(x, y);
    const r = rng();
    lights.push({ x: c.x, y: WALL_H - 0.04, z: c.z, kind: 'ceiling', room: false, dead: !force && r < 0.08, broken: !force && r >= 0.08 && r < 0.22 });
  };
  tryLight(startCell.x, startCell.y, true);
  tryLight(elev.hallX, elev.hallY, true);
  for (const c of shuffle(hallCells.slice(), rng)) tryLight(c % GRID, (c / GRID) | 0, false);
  for (const room of rooms) {
    if (rng() < 0.4) lights.push({ x: room.wx, y: WALL_H - 0.04, z: room.wz, kind: 'ceiling', room: true, dead: false, broken: rng() < 0.3 });
    room.lampOn = rng() < 0.72 || room.hasKey;
    lights.push({ x: room.nightstand.x, y: 0.98, z: room.nightstand.z, kind: 'lamp', room: true, dead: !room.lampOn, broken: rng() < 0.12 });
  }

  // --- 10. Monster spawns ------------------------------------------------------------------
  const far = (frac) => hallCells.filter((c) => distFromStart[c] >= maxDist * frac && distFromStart[c] >= 14);
  const pickCell = (list, fallback) => {
    const l = list.length ? list : fallback;
    const c = l[ri(l.length)];
    return { x: c % GRID, y: (c / GRID) | 0 };
  };
  const farthestHall = hallCells.slice().sort((a, b) => distFromStart[b] - distFromStart[a]).slice(0, 12);
  const conciergeSpawn = pickCell(far(0.45), farthestHall);
  const maidRooms = rooms.filter((r) => distFromStart[idx(r.door.x, r.door.y)] >= Math.max(12, maxDist * 0.3));
  const maidRoom = (maidRooms.length ? maidRooms : rooms)[ri((maidRooms.length ? maidRooms : rooms).length)];
  const maidSpawn = maidRoom ? { x: maidRoom.x0 + ((maidRoom.w - 1) >> 1), y: maidRoom.y0 + ((maidRoom.h - 1) >> 1) } : pickCell(far(0.4), farthestHall);
  const farDead = deadEnds.filter((d) => distFromStart[idx(d.x, d.y)] >= Math.max(14, maxDist * 0.4)).map((d) => idx(d.x, d.y));
  const bellhopSpawn = pickCell(farDead, farthestHall);
  const monsterSpawns = { concierge: conciergeSpawn, maid: maidSpawn, bellhop: bellhopSpawn };

  // --- 11. Portraits, blood, and the bricked-up front doors --------------------------------
  const portraits = [];
  const noExit = startDE ? (() => {
    const nx = -DIRS[startDE.open][0], nz = -DIRS[startDE.open][1];
    const c = cellCenter(startDE.x, startDE.y);
    return { x: c.x + nx * (CELL / 2 - 0.03), z: c.z + nz * (CELL / 2 - 0.03), ry: Math.atan2(-nx, -nz), nx, nz };
  })() : null;
  for (const c of shuffle(hallCells.slice(), rng)) {
    if (portraits.length >= 46) break;
    const x = c % GRID, y = (c / GRID) | 0;
    if (x === startCell.x && y === startCell.y) continue;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (inBounds(nx, ny) && grid[idx(nx, ny)] !== T.WALL) continue;
      if (rng() > 0.085) continue;
      const w = cellCenter(x, y);
      portraits.push({
        x: w.x + DIRS[d][0] * (CELL / 2 - 0.035), y: 1.72, z: w.z + DIRS[d][1] * (CELL / 2 - 0.035),
        ry: Math.atan2(-DIRS[d][0], -DIRS[d][1]), variant: ri(8), cell: c,
      });
      break;
    }
  }

  const blood = [];
  const spawnList = Object.values(monsterSpawns);
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const t = grid[idx(x, y)];
      if (t !== T.HALL && t !== T.ROOM) continue;
      let p = 0.035;
      for (const s of spawnList) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < 5) p += 0.34 * (1 - d / 5);
      }
      if (rng() > p) continue;
      const w = cellCenter(x, y);
      const walls = [];
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (!inBounds(nx, ny) || grid[idx(nx, ny)] === T.WALL) walls.push(d);
      }
      if (walls.length && rng() < 0.38) {
        const d = walls[ri(walls.length)];
        blood.push({
          wall: true, x: w.x + DIRS[d][0] * (CELL / 2 - 0.02), y: 0.7 + rng() * 1.3, z: w.z + DIRS[d][1] * (CELL / 2 - 0.02),
          ry: Math.atan2(-DIRS[d][0], -DIRS[d][1]), size: 0.7 + rng() * 0.9, variant: ri(4), spin: (rng() - 0.5) * 0.8,
        });
      } else {
        blood.push({
          wall: false, x: w.x + (rng() - 0.5) * 1.2, y: 0.012, z: w.z + (rng() - 0.5) * 1.2,
          ry: rng() * Math.PI * 2, size: 0.8 + rng() * 1.3, variant: ri(4), spin: 0,
        });
      }
    }
  }

  // --- 12. Dead birds, thrown into the corners of every room that holds a keycard ---------
  // (generated last so everything above stays identical for a given seed)
  const birds = [];
  for (const room of keyRooms) {
    const X0 = room.x0 * CELL, X1 = (room.x1 + 1) * CELL, Z0 = room.y0 * CELL, Z1 = (room.y1 + 1) * CELL;
    const solids = [room.bed, room.nightstand, room.wardrobe, room.dresser].filter(Boolean);
    for (const [cx, cz, sx, sz] of [[X0, Z0, 1, 1], [X1, Z0, -1, 1], [X0, Z1, 1, -1], [X1, Z1, -1, -1]]) {
      const n = 1 + ri(3);
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const x = cx + sx * (0.28 + rng() * 0.95), z = cz + sz * (0.28 + rng() * 0.95);
        const ry = rng() * Math.PI * 2, s = 0.85 + rng() * 0.5, pose = ri(3);
        if (solids.some((f) => Math.abs(x - f.x) < f.sx / 2 + 0.18 && Math.abs(z - f.z) < f.sz / 2 + 0.18)) continue;
        birds.push({ x, z, ry, s, pose, room: room.id });
        placed++;
      }
      if (placed) {
        blood.push({ wall: false, x: cx + sx * 0.62, y: 0.014, z: cz + sz * 0.62, ry: rng() * Math.PI * 2, size: 0.9 + rng() * 0.8, variant: ri(2), spin: 0 });
      }
    }
  }

  // --- 13. Things written on the corridor walls ------------------------------------------
  const scrawls = [];
  const takenWalls = new Set(portraits.map((p) => p.cell));
  for (const c of shuffle(hallCells.slice(), rng)) {
    if (scrawls.length >= 10) break;
    if (takenWalls.has(c) || distFromStart[c] < 4) continue;
    const x = c % GRID, y = (c / GRID) | 0;
    const walls = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (!inBounds(nx, ny) || grid[idx(nx, ny)] === T.WALL) walls.push(d);
    }
    if (!walls.length) continue;
    const d = walls[ri(walls.length)];
    const w = cellCenter(x, y);
    scrawls.push({
      x: w.x + DIRS[d][0] * (CELL / 2 - 0.025), y: 1.78 + rng() * 0.25, z: w.z + DIRS[d][1] * (CELL / 2 - 0.025),
      ry: Math.atan2(-DIRS[d][0], -DIRS[d][1]), variant: scrawls.length % 7,
    });
    takenWalls.add(c);
  }

  return {
    birds, scrawls,
    seed, grid, rooms, startCell, start: cellCenter(startCell.x, startCell.y),
    startFacing: startDE ? { x: DIRS[startDE.open][0], z: DIRS[startDE.open][1] } : { x: 0, z: -1 },
    elevator: elev, pickups, lights, portraits, blood, noExit, monsterSpawns,
    hallCells, deadEnds, colliders, colliderGrid, distFromStart, maxDist,
  };
}

// Furniture is laid out in a room-local frame: f points from the door wall into the room,
// r is perpendicular. Everything is axis-aligned so colliders are plain AABBs.
function layoutRoom(room, rng, colliders) {
  const f = { x: room.door.dx, z: room.door.dy };
  const r = { x: -f.z, z: f.x };
  const alongX = f.x !== 0;
  const D = (alongX ? room.w : room.h) * CELL;
  const W = (alongX ? room.h : room.w) * CELL;
  const doorWX = (room.door.x + 0.5) * CELL, doorWZ = (room.door.y + 0.5) * CELL;
  const doorR = (doorWX - room.wx) * r.x + (doorWZ - room.wz) * r.z;
  const side = Math.abs(doorR) < 0.1 ? (rng() < 0.5 ? -1 : 1) : Math.sign(doorR);
  const place = (lr, lf, hr, hf) => ({
    x: room.wx + r.x * lr + f.x * lf,
    z: room.wz + r.z * lr + f.z * lf,
    sx: 2 * (Math.abs(r.x) * hr + Math.abs(f.x) * hf),
    sz: 2 * (Math.abs(r.z) * hr + Math.abs(f.z) * hf),
  });
  const scaled = (v, s) => ({ x: v.x * s, z: v.z * s });

  room.bed = { ...place(side * (W / 2 - 1.55), D / 2 - 1.1, 0.8, 1.05), h: 0.55, head: f };
  room.nightstand = { ...place(side * (W / 2 - 0.36), D / 2 - 0.34, 0.26, 0.26), h: 0.6 };
  room.wardrobe = { ...place(-side * (W / 2 - 0.4), 0.2, 0.36, 0.72), h: 2.2, front: scaled(r, side), room: room.id };
  room.dresser = rng() < 0.65 ? { ...place(-side * (W / 2 - 1.3), -D / 2 + 0.3, 0.62, 0.26), h: 0.85, front: f } : null;
  room.suitcase = rng() < 0.5 ? { ...place(side * (rng() * 0.8 - 0.2), -0.6 - rng() * 0.8, 0.34, 0.22), h: 0.3 } : null;

  const solids = [room.bed, room.nightstand, room.wardrobe];
  if (room.dresser) solids.push(room.dresser);
  for (const s of solids) colliders.push({ x0: s.x - s.sx / 2, x1: s.x + s.sx / 2, z0: s.z - s.sz / 2, z1: s.z + s.sz / 2 });

  room.keySpots = [{ x: room.bed.x - f.x * 0.45, y: 0.66, z: room.bed.z - f.z * 0.45 }];
  if (room.dresser) room.keySpots.push({ x: room.dresser.x, y: 0.92, z: room.dresser.z });
}

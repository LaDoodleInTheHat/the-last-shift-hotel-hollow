// Smoke test for the hotel generator: determinism, reachability and spec constraints.
import { generateHotel, bfs, astar, idx, GRID, T, walkable } from '../public/js/maze.js';

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL: ' + msg); } };
const stats = { rooms: [], halls: [], deadEnds: [], keys: [], lights: [], portraits: [], blood: [] };

for (let seed = 1; seed <= 300; seed++) {
  const h = generateHotel(seed);
  const again = generateHotel(seed);
  check(h.grid.every((v, i) => v === again.grid[i]), `seed ${seed}: grid not deterministic`);
  check(JSON.stringify(h.pickups) === JSON.stringify(again.pickups), `seed ${seed}: pickups not deterministic`);

  const dist = bfs(h.grid, h.startCell.x, h.startCell.y);
  for (const room of h.rooms) {
    check(dist[idx(room.door.x, room.door.y)] > 0, `seed ${seed}: room ${room.number} unreachable`);
  }
  check(dist[idx(h.elevator.hallX, h.elevator.hallY)] > 0, `seed ${seed}: elevator unreachable`);
  check(h.grid[idx(h.elevator.x, h.elevator.y)] === T.ELEV, `seed ${seed}: elevator cell missing`);

  const keys = h.pickups.filter((p) => p.type === 'key');
  check(keys.length === 5, `seed ${seed}: ${keys.length} keycards`);
  check(h.pickups.filter((p) => p.type === 'battery').length === 8, `seed ${seed}: battery count`);
  check(h.pickups.filter((p) => p.type === 'rocket').length === 4, `seed ${seed}: rocket count`);
  check(h.rooms.length >= 24, `seed ${seed}: only ${h.rooms.length} rooms`);

  for (const m of Object.values(h.monsterSpawns)) {
    check(walkable(h.grid[idx(m.x, m.y)]), `seed ${seed}: monster spawn in a wall`);
    check(astar(h.grid, m.x, m.y, h.startCell.x, h.startCell.y) !== null, `seed ${seed}: monster cannot reach start`);
  }
  let walk = 0;
  for (let i = 0; i < GRID * GRID; i++) if (walkable(h.grid[i])) { walk++; check(dist[i] >= 0, `seed ${seed}: isolated cell ${i}`); }

  stats.rooms.push(h.rooms.length);
  stats.halls.push(h.hallCells.length);
  stats.deadEnds.push(h.deadEnds.length);
  stats.lights.push(h.lights.length);
  stats.portraits.push(h.portraits.length);
  stats.blood.push(h.blood.length);
  stats.keys.push(h.maxDist);
}

const summarize = (a) => `min ${Math.min(...a)} avg ${(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1)} max ${Math.max(...a)}`;
for (const [k, v] of Object.entries(stats)) console.log(k.padEnd(10), summarize(v));

// Print one hotel so a human can eyeball it.
const h = generateHotel(1337);
const glyph = { [T.WALL]: '#', [T.HALL]: ' ', [T.ROOM]: '.', [T.DOOR]: '+', [T.ELEV]: 'E' };
for (let y = 0; y < GRID; y++) {
  let row = '';
  for (let x = 0; x < GRID; x++) {
    row += (x === h.startCell.x && y === h.startCell.y) ? 'S' : glyph[h.grid[idx(x, y)]];
  }
  console.log(row);
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('generator smoke test passed');

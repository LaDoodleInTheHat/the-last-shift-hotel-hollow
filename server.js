'use strict';
/*
 * THE LAST SHIFT: Hotel Hollow - server
 * One process: serves the static client and relays co-op messages over WebSockets.
 * The server is deliberately thin. It owns rooms, the shared seed, the list of
 * collected pickups (so late joiners see the same hotel) and host migration.
 * Monster simulation runs on the room host's client and is relayed to the others.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const DIFFS = ['easy', 'normal', 'nightmare'];

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Optional: extra WebRTC ICE servers (e.g. a TURN service) as a JSON array in ICE_SERVERS.
let iceServers = null;
try { if (process.env.ICE_SERVERS) iceServers = JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS is not valid JSON; ignoring it.'); }
app.get('/config.json', (_req, res) => res.json({ iceServers: Array.isArray(iceServers) ? iceServers : null }));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

/** @type {Map<string, Room>} */
const rooms = new Map();
let nextId = 1;

function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/[^\w \-'.]/g, '').trim().slice(0, 14);
  return s || 'Porter';
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const [id, p] of room.players) {
    if (id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function roster(room) {
  return [...room.players].map(([id, p]) => ({ id, name: p.name }));
}

function joinRoom(ws, room, name) {
  ws.room = room;
  ws.pname = name;
  room.players.set(ws.id, { ws, name });
  send(ws, {
    t: 'joined',
    code: room.code,
    id: ws.id,
    host: room.hostId,
    diff: room.diff,
    players: roster(room),
    started: room.started,
    seed: room.seed,
    picked: room.picked,
    elapsed: room.started ? (Date.now() - room.startAt) / 1000 : 0,
  });
  broadcast(room, { t: 'peer-join', id: ws.id, name }, ws.id);
}

// Voice fallback: when two players cannot connect peer-to-peer, their audio frames are
// sent here as binary messages and forwarded to the peers they asked for.
function relayVoice(ws, raw) {
  const room = ws.room;
  if (!room || !ws.relayTo.length || raw.length > 8192) return;
  const head = Buffer.from(ws.id, 'ascii');
  const out = Buffer.concat([Buffer.from([head.length]), head, raw]);
  for (const id of ws.relayTo) {
    const p = room.players.get(id);
    if (p && p.ws.readyState === 1 && p.ws.bufferedAmount < 256 * 1024) p.ws.send(out, { binary: true });
  }
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  ws.relayTo = [];
  room.players.delete(ws.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  broadcast(room, { t: 'peer-leave', id: ws.id });
  if (room.hostId === ws.id) {
    room.hostId = room.players.keys().next().value;
    broadcast(room, { t: 'host', id: room.hostId });
  }
}

wss.on('connection', (ws) => {
  ws.id = 'p' + (nextId++).toString(36);
  ws.room = null;
  ws.relayTo = [];
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) { relayVoice(ws, raw); return; }
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;

    switch (m.t) {
      case 'create': {
        if (room) leaveRoom(ws);
        const code = makeCode();
        if (!code) return send(ws, { t: 'error', msg: 'The hotel is full. Try again shortly.' });
        const r = {
          code,
          hostId: ws.id,
          diff: DIFFS.includes(m.diff) ? m.diff : 'normal',
          seed: 0,
          started: false,
          startAt: 0,
          picked: [],
          players: new Map(),
        };
        rooms.set(code, r);
        joinRoom(ws, r, cleanName(m.name));
        break;
      }
      case 'join': {
        if (room) leaveRoom(ws);
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
        const r = rooms.get(code);
        if (!r) return send(ws, { t: 'error', msg: 'No shift found with that code.' });
        if (r.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'That shift is fully staffed (4 max).' });
        joinRoom(ws, r, cleanName(m.name));
        break;
      }
      case 'leave':
        leaveRoom(ws);
        break;
      case 'diff': {
        if (!room || room.hostId !== ws.id || room.started) return;
        if (!DIFFS.includes(m.diff)) return;
        room.diff = m.diff;
        broadcast(room, { t: 'diff', diff: room.diff });
        break;
      }
      case 'start': {
        if (!room || room.hostId !== ws.id) return;
        if (DIFFS.includes(m.diff)) room.diff = m.diff;
        room.seed = Number.isFinite(m.seed) ? (m.seed >>> 0) : randomSeed();
        room.started = true;
        room.startAt = Date.now();
        room.picked = [];
        broadcast(room, { t: 'start', seed: room.seed, diff: room.diff });
        break;
      }
      case 'state': {
        if (!room) return;
        m.id = ws.id;
        broadcast(room, m, ws.id);
        break;
      }
      case 'mon': {
        if (!room || room.hostId !== ws.id) return;
        broadcast(room, m, ws.id);
        break;
      }
      case 'ev': {
        if (!room) return;
        m.id = ws.id;
        if (m.k === 'pickup' && Number.isInteger(m.pid) && room.picked.length < 256 && !room.picked.includes(m.pid)) {
          room.picked.push(m.pid);
        }
        if (m.k === 'end') room.started = false;
        broadcast(room, m, ws.id);
        break;
      }
      case 'rtc': {
        if (!room || typeof m.to !== 'string') return;
        const peer = room.players.get(m.to);
        if (peer) send(peer.ws, { t: 'rtc', from: ws.id, d: m.d });
        break;
      }
      case 'vr': {
        ws.relayTo = Array.isArray(m.to) ? m.to.filter((v) => typeof v === 'string').slice(0, MAX_PLAYERS) : [];
        break;
      }
      case 'ping':
        send(ws, { t: 'pong' });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

// Drop dead sockets so rooms do not fill up with ghosts (the wrong kind).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`THE LAST SHIFT: Hotel Hollow listening on port ${PORT}`);
});

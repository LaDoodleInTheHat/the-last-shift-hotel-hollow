// net.js - WebSocket client for co-op. The server is a relay: it owns rooms, the shared
// seed and host migration; everything else is messages between clients.
export class Net {
  constructor() {
    this.ws = null;
    this.id = null;
    this.hostId = null;
    this.code = null;
    this.players = new Map(); // id -> { id, name }
    this.handlers = {};
    this.pingTimer = null;
  }

  get isHost() { return !!this.id && this.id === this.hostId; }
  get inRoom() { return !!this.code; }
  get open() { return !!this.ws && this.ws.readyState === 1; }

  on(type, fn) { (this.handlers[type] || (this.handlers[type] = [])).push(fn); }
  emit(type, msg) { for (const f of this.handlers[type] || []) f(msg); }

  connect() {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        settled = true;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ t: 'ping' }), 20000);
        resolve();
      };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('Could not reach the hotel switchboard.')); } };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        const was = this.inRoom;
        this.reset();
        if (!settled) { settled = true; reject(new Error('Could not reach the hotel switchboard.')); }
        this.emit('closed', { wasInRoom: was });
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        this.handle(m);
      };
    });
  }

  reset() {
    this.id = null; this.hostId = null; this.code = null;
    this.players.clear();
  }

  handle(m) {
    switch (m.t) {
      case 'joined':
        this.id = m.id; this.hostId = m.host; this.code = m.code;
        this.players.clear();
        for (const p of m.players) this.players.set(p.id, { id: p.id, name: p.name });
        break;
      case 'peer-join':
        this.players.set(m.id, { id: m.id, name: m.name });
        break;
      case 'peer-leave':
        m.name = this.players.get(m.id)?.name || 'A porter';
        this.players.delete(m.id);
        break;
      case 'host':
        this.hostId = m.id;
        break;
      default: break;
    }
    this.emit(m.t, m);
  }

  send(obj) { if (this.open) this.ws.send(JSON.stringify(obj)); }

  async createRoom(name, diff) { await this.connect(); this.send({ t: 'create', name, diff }); }
  async joinRoom(code, name) { await this.connect(); this.send({ t: 'join', code, name }); }
  start(diff, seed) { this.send({ t: 'start', diff, seed }); }
  event(k, data = {}) { this.send({ t: 'ev', k, ...data }); }

  leave() {
    this.send({ t: 'leave' });
    this.reset();
  }

  nameOf(id) { return this.players.get(id)?.name || 'Porter'; }
}

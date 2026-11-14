// voice.js - proximity voice chat.
// Preferred path: WebRTC audio, peer-to-peer in a full mesh (max 4 porters), signalled through
// the game's WebSocket. If a pair cannot connect directly (strict NATs, no TURN server), that
// pair falls back to relaying raw 16 kHz audio frames through the game server, so voice works
// wherever the game itself works.
// Either way each remote voice runs through the same Web Audio chain:
// lowpass (muffled through walls) -> gain -> HRTF panner placed at the speaker's position.
const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const HEAR_RANGE = 26;        // metres until a voice fades to nothing
const RELAY_RATE = 16000;     // sample rate of relayed audio
const CONNECT_TIMEOUT = 7000; // ms to wait for a direct connection before relaying
const GATE = 0.008;           // relay only sends while the mic is above this level

export class Voice {
  constructor(net, audio, opts = {}) {
    this.net = net;
    this.audio = audio;
    this.ice = { iceServers: opts.iceServers && opts.iceServers.length ? opts.iceServers : DEFAULT_ICE };
    this.forceRelay = !!opts.forceRelay;
    this.peers = new Map();
    this.stream = null;
    this.track = null;
    this.muted = false;
    this.level = 0;
    this.analyser = null;
    this.capture = null;
    this.hang = 0;
    this.buf = new Uint8Array(256);
    this.error = null;
    this.asking = false;
  }

  get micOn() { return !!this.track; }
  get talking() { return this.micOn && !this.muted && this.level > 0.04; }

  /** Ask for the microphone. Voice still works receive-only if this is declined. */
  async enableMic() {
    if (this.track) return true;
    if (this.asking) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.error = 'This browser cannot capture a microphone (it needs HTTPS or localhost).';
      return false;
    }
    this.asking = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
    } catch (e) {
      this.error = e && e.name === 'NotAllowedError'
        ? 'Microphone permission was declined. Allow it in the address bar, then press V.'
        : 'No microphone could be opened.';
      this.asking = false;
      return false;
    }
    this.asking = false;
    this.error = null;
    this.setStream(stream);
    return true;
  }

  /** Use this stream as the local voice. */
  setStream(stream) {
    this.stream = stream;
    this.track = stream.getAudioTracks()[0];
    this.track.enabled = !this.muted;
    const ctx = this.audio.ctx;
    if (ctx) {
      const src = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      src.connect(this.analyser); // analysis only; never routed to the speakers
      // capture tap for the relay path (kept silent, but it must reach the destination to run)
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const sink = ctx.createGain(); sink.gain.value = 0;
      proc.onaudioprocess = (e) => this.onCapture(e.inputBuffer.getChannelData(0));
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
      this.capture = { src, proc, sink };
    }
    for (const p of this.peers.values()) if (p.sender) p.sender.replaceTrack(this.track).catch(() => {});
  }

  setMuted(m) {
    this.muted = m;
    if (this.track) this.track.enabled = !m;
  }

  // --- relay path -------------------------------------------------------------
  onCapture(data) {
    if (this.muted) return;
    let any = false;
    for (const p of this.peers.values()) if (p.relay) { any = true; break; }
    if (!any) return;
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i] * data[i];
    if (Math.sqrt(s / data.length) > GATE) this.hang = 10;
    if (this.hang <= 0) return;
    this.hang--;
    const ratio = this.audio.ctx.sampleRate / RELAY_RATE;
    const n = Math.floor(data.length / ratio);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
      let acc = 0;
      for (let k = a; k < b; k++) acc += data[k];
      const v = Math.max(-1, Math.min(1, acc / (b - a)));
      out[i] = v * 32767;
    }
    this.net.sendBinary(out.buffer);
  }

  /** Binary frame from the server: [idLength][id ascii][int16 pcm...] */
  handleRelayAudio(buffer) {
    const ctx = this.audio.ctx;
    if (!ctx || !buffer || buffer.byteLength < 4) return;
    const u8 = new Uint8Array(buffer);
    const idLen = u8[0];
    const id = String.fromCharCode(...u8.subarray(1, 1 + idLen));
    const peer = this.peers.get(id);
    if (!peer) return;
    if (!peer.relay) this.startRelay(peer, false);
    this.ensureNodes(peer);
    if (!peer.nodes) return;
    const bytes = (buffer.byteLength - 1 - idLen) & ~1;
    const pcm = new Int16Array(buffer.slice(1 + idLen, 1 + idLen + bytes));
    if (!pcm.length) return;
    const ab = ctx.createBuffer(1, pcm.length, RELAY_RATE);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(peer.nodes.input);
    const now = ctx.currentTime;
    if (peer.playT < now + 0.02 || peer.playT > now + 0.7) peer.playT = now + 0.1; // small jitter buffer
    src.start(peer.playT);
    peer.playT += ab.duration;
  }

  syncRelayTargets() {
    const to = [];
    for (const p of this.peers.values()) if (p.relay) to.push(p.id);
    this.net.send({ t: 'vr', to });
  }

  startRelay(peer, notify) {
    if (peer.relay) return;
    peer.relay = true;
    clearTimeout(peer.timer);
    if (peer.pc) { try { peer.pc.close(); } catch { /* already closed */ } peer.pc = null; }
    peer.sender = null;
    if (peer.nodes && peer.nodes.src) { try { peer.nodes.src.disconnect(); } catch { /* gone */ } peer.nodes.src = null; }
    if (peer.el) { peer.el.srcObject = null; peer.el = null; }
    this.ensureNodes(peer);
    if (notify) this.net.send({ t: 'rtc', to: peer.id, d: { relay: 1 } });
    this.syncRelayTargets();
  }

  // --- peers ------------------------------------------------------------------
  addPeer(id) {
    if (this.peers.has(id) || id === this.net.id) return this.peers.get(id);
    const peer = {
      id, pc: null, sender: null, initiator: this.net.id < id, pending: [], nodes: null, el: null,
      level: 0, buf: new Uint8Array(256), remoteSet: false, relay: false, playT: 0, timer: null,
    };
    this.peers.set(id, peer);
    this.ensureNodes(peer);
    if (this.forceRelay || typeof RTCPeerConnection === 'undefined') {
      this.startRelay(peer, true);
    } else {
      this.createPc(peer);
      peer.timer = setTimeout(() => {
        if (this.peers.get(id) === peer && !peer.relay && (!peer.pc || peer.pc.connectionState !== 'connected')) this.startRelay(peer, true);
      }, CONNECT_TIMEOUT);
    }
    return peer;
  }

  createPc(peer) {
    const id = peer.id;
    const pc = new RTCPeerConnection(this.ice);
    peer.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) this.net.send({ t: 'rtc', to: id, d: { c: e.candidate } }); };
    pc.ontrack = (e) => this.attach(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (peer.pc !== pc || this.peers.get(id) !== peer) return;
      if (pc.connectionState === 'failed') this.startRelay(peer, true);
      else if (pc.connectionState === 'disconnected') {
        setTimeout(() => { if (peer.pc === pc && pc.connectionState !== 'connected' && this.peers.get(id) === peer) this.startRelay(peer, true); }, 4000);
      }
    };
    if (peer.initiator) {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.sender = tr.sender;
      if (this.track) tr.sender.replaceTrack(this.track).catch(() => {});
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.net.send({ t: 'rtc', to: id, d: { s: pc.localDescription } }))
        .catch(() => {});
    }
  }

  async handleSignal(from, d) {
    if (!d) return;
    let peer = this.peers.get(from);
    if (!peer) peer = this.addPeer(from);
    if (!peer) return;
    if (d.relay) { this.startRelay(peer, false); return; }
    if (peer.relay || !peer.pc) return;
    const pc = peer.pc;
    try {
      if (d.s) {
        if (d.s.type === 'offer' && peer.initiator) return; // we make the offers on this pair
        await pc.setRemoteDescription(d.s);
        peer.remoteSet = true;
        for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (d.s.type === 'offer') {
          const tr = pc.getTransceivers()[0];
          if (tr) {
            tr.direction = 'sendrecv';
            peer.sender = tr.sender;
            if (this.track) await tr.sender.replaceTrack(this.track).catch(() => {});
          }
          await pc.setLocalDescription(await pc.createAnswer());
          this.net.send({ t: 'rtc', to: from, d: { s: pc.localDescription } });
        }
      } else if (d.c) {
        if (peer.remoteSet) await pc.addIceCandidate(d.c).catch(() => {});
        else peer.pending.push(d.c);
      }
    } catch (e) {
      console.warn('voice signalling failed, relaying instead', e);
      this.startRelay(peer, true);
    }
  }

  ensureNodes(peer) {
    const ctx = this.audio.ctx;
    if (!ctx || peer.nodes) return;
    const input = ctx.createGain();
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 20000;
    const gain = ctx.createGain(); gain.gain.value = 1;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.refDistance = 2; panner.maxDistance = HEAR_RANGE; panner.rolloffFactor = 1;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    input.connect(analyser);
    input.connect(filter).connect(gain).connect(panner).connect(this.audio.voiceBus);
    peer.nodes = { input, filter, gain, panner, analyser, src: null };
  }

  attach(peer, stream) {
    const ctx = this.audio.ctx;
    if (!ctx || peer.relay) return;
    this.ensureNodes(peer);
    if (peer.nodes.src) return;
    // Chrome only pumps a remote WebRTC stream into Web Audio if it is also attached to a media element.
    const el = new Audio();
    el.srcObject = stream; el.muted = true;
    el.play().catch(() => {});
    peer.el = el;
    peer.nodes.src = ctx.createMediaStreamSource(stream);
    peer.nodes.src.connect(peer.nodes.input);
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    clearTimeout(p.timer);
    if (p.pc) { try { p.pc.close(); } catch { /* already closed */ } }
    if (p.nodes) for (const n of Object.values(p.nodes)) { if (n) { try { n.disconnect(); } catch { /* gone */ } } }
    if (p.el) p.el.srcObject = null;
    if (p.relay) this.syncRelayTargets();
  }

  /** 'direct' | 'relay' | 'connecting' */
  status(id) {
    const p = this.peers.get(id);
    if (!p) return 'connecting';
    if (p.relay) return 'relay';
    return p.pc && p.pc.connectionState === 'connected' ? 'direct' : 'connecting';
  }

  static rms(analyser, buf) {
    analyser.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / buf.length);
  }

  /**
   * Per-frame. listener: {x,y,z}. info(id) -> { audible, spatial, x, y, z, muffled }
   * Non-spatial voices are pinned to the listener so they play at full volume, centred.
   */
  update(listener, info) {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (this.analyser) {
      const l = this.muted ? 0 : Voice.rms(this.analyser, this.buf);
      this.level += (l - this.level) * 0.35;
    }
    for (const p of this.peers.values()) {
      if (!p.nodes) { this.ensureNodes(p); continue; }
      const i = info(p.id) || { audible: true, spatial: false };
      const n = p.nodes;
      n.gain.gain.setTargetAtTime(i.audible ? 1 : 0, t, 0.08);
      n.filter.frequency.setTargetAtTime(i.spatial && i.muffled ? 650 : 20000, t, 0.12);
      const x = i.spatial ? i.x : listener.x, y = i.spatial ? i.y : listener.y, z = i.spatial ? i.z : listener.z;
      if (n.panner.positionX) {
        n.panner.positionX.setTargetAtTime(x, t, 0.05); n.panner.positionY.setTargetAtTime(y, t, 0.05); n.panner.positionZ.setTargetAtTime(z, t, 0.05);
      } else n.panner.setPosition(x, y, z);
      const l = Voice.rms(n.analyser, p.buf);
      p.level += (l - p.level) * 0.35;
    }
  }

  isSpeaking(id) {
    const p = this.peers.get(id);
    return !!p && p.level > 0.025;
  }

  dispose() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    if (this.capture) {
      this.capture.proc.onaudioprocess = null;
      for (const n of Object.values(this.capture)) { try { n.disconnect(); } catch { /* gone */ } }
      this.capture = null;
    }
    if (this.stream) for (const tr of this.stream.getTracks()) tr.stop();
    this.stream = null; this.track = null; this.analyser = null; this.level = 0;
  }
}

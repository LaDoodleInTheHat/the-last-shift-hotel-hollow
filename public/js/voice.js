// voice.js - proximity voice chat.
// WebRTC audio in a full mesh (max 4 porters), signalled through the game's WebSocket.
// Each remote voice is routed through the Web Audio graph: lowpass (muffled through walls)
// -> gain -> HRTF panner placed at the speaker's position in the hotel.
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
const HEAR_RANGE = 26; // metres until a voice fades to nothing

export class Voice {
  constructor(net, audio) {
    this.net = net;
    this.audio = audio;
    this.peers = new Map();
    this.stream = null;
    this.track = null;
    this.muted = false;
    this.level = 0;
    this.analyser = null;
    this.buf = new Uint8Array(256);
    this.error = null;
  }

  get micOn() { return !!this.track; }
  get talking() { return this.micOn && !this.muted && this.level > 0.05; }

  /** Ask for the microphone. Voice still works receive-only if this is declined. */
  async enableMic() {
    if (this.track) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.error = 'This browser cannot capture a microphone (it needs HTTPS or localhost).';
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
    } catch (e) {
      this.error = e && e.name === 'NotAllowedError' ? 'Microphone permission was declined.' : 'No microphone could be opened.';
      return false;
    }
    this.error = null;
    this.track = this.stream.getAudioTracks()[0];
    this.track.enabled = !this.muted;
    const ctx = this.audio.ctx;
    if (ctx) {
      const src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      src.connect(this.analyser); // analysis only; never routed to the speakers
    }
    for (const p of this.peers.values()) if (p.sender) p.sender.replaceTrack(this.track).catch(() => {});
    return true;
  }

  setMuted(m) {
    this.muted = m;
    if (this.track) this.track.enabled = !m;
  }

  addPeer(id) {
    if (this.peers.has(id) || id === this.net.id) return this.peers.get(id);
    const pc = new RTCPeerConnection(ICE);
    const peer = { id, pc, sender: null, initiator: this.net.id < id, pending: [], nodes: null, el: null, level: 0, buf: new Uint8Array(256), remoteSet: false };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => { if (e.candidate) this.net.send({ t: 'rtc', to: id, d: { c: e.candidate } }); };
    pc.ontrack = (e) => this.attach(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.peers.get(id) === peer) {
        this.removePeer(id);
        if (this.net.players.has(id)) this.addPeer(id);
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
    return peer;
  }

  async handleSignal(from, d) {
    if (!d) return;
    let peer = this.peers.get(from);
    if (!peer) peer = this.addPeer(from);
    if (!peer) return;
    const pc = peer.pc;
    try {
      if (d.s) {
        if (d.s.type === 'offer') {
          if (peer.initiator) return; // we make the offers on this pair
          if (pc.signalingState !== 'stable' || peer.remoteSet) {
            // the other side rebuilt its connection: start ours again from scratch
            this.removePeer(from);
            this.addPeer(from);
            return this.handleSignal(from, d);
          }
        }
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
      console.warn('voice signalling failed', e);
    }
  }

  attach(peer, stream) {
    const ctx = this.audio.ctx;
    if (!ctx || peer.nodes) return;
    // Chrome only pumps a remote WebRTC stream into Web Audio if it is also attached to a media element.
    const el = new Audio();
    el.srcObject = stream; el.muted = true;
    el.play().catch(() => {});
    peer.el = el;
    const src = ctx.createMediaStreamSource(stream);
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 20000;
    const gain = ctx.createGain(); gain.gain.value = 1;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.refDistance = 2; panner.maxDistance = HEAR_RANGE; panner.rolloffFactor = 1;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    src.connect(analyser);
    src.connect(filter).connect(gain).connect(panner).connect(this.audio.voiceBus);
    peer.nodes = { src, filter, gain, panner, analyser };
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* already closed */ }
    if (p.nodes) for (const n of Object.values(p.nodes)) { try { n.disconnect(); } catch { /* gone */ } }
    if (p.el) { p.el.srcObject = null; }
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
      if (!p.nodes) continue;
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
    return !!p && p.level > 0.03;
  }

  dispose() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    if (this.stream) for (const tr of this.stream.getTracks()) tr.stop();
    this.stream = null; this.track = null; this.analyser = null; this.level = 0;
  }
}

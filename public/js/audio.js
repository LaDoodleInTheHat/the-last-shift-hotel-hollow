// audio.js - every sound is synthesised with the Web Audio API. No samples.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.lx = 0; this.ly = 0; this.lz = 0;
    this.voices = {};
    this.tension = 0;
    this.heartT = 0;
    this.thumpT = 8;
    this.creakT = 12;
    this.volume = 0.9;
  }

  get ready() { return !!this.ctx; }
  get now() { return this.ctx.currentTime; }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
    this.sfx = c.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.master);
    this.amb = c.createGain(); this.amb.gain.value = 0; this.amb.connect(this.master);
    this.voiceBus = c.createGain(); this.voiceBus.gain.value = 1.4; this.voiceBus.connect(this.master);

    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(x * 6); }
    this.distCurve = curve;

    this.startAmbience();
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // --- primitives -----------------------------------------------------------
  env(g, t0, attack, dur, peak) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  tone(dest, type, f0, f1, t0, dur, peak, attack = 0.008) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    this.env(g, t0, attack, dur, peak);
    o.connect(g).connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return o;
  }

  noise(dest, ftype, f0, f1, q, t0, dur, peak, attack = 0.004) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf; s.loop = true;
    f.type = ftype; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t0 + dur);
    this.env(g, t0, attack, dur, peak);
    s.connect(f).connect(g).connect(dest);
    s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.05);
  }

  makePanner(ref = 3, roll = 1.2, hrtf = false) {
    const p = this.ctx.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = roll; p.maxDistance = 200;
    return p;
  }

  setPannerPos(p, x, y, z) {
    if (p.positionX) {
      const t = this.now;
      p.positionX.setTargetAtTime(x, t, 0.03); p.positionY.setTargetAtTime(y, t, 0.03); p.positionZ.setTargetAtTime(z, t, 0.03);
    } else p.setPosition(x, y, z);
  }

  /** A short-lived positional output for one-shot sounds. */
  at(x, y, z, ref = 3, roll = 1.2, life = 4) {
    const p = this.makePanner(ref, roll);
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
    p.connect(this.sfx);
    setTimeout(() => { try { p.disconnect(); } catch { /* gone */ } }, life * 1000);
    return p;
  }

  setListener(x, y, z, fx, fy, fz) {
    if (!this.ctx) return;
    this.lx = x; this.ly = y; this.lz = z;
    const l = this.ctx.listener, t = this.now;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02); l.positionY.setTargetAtTime(y, t, 0.02); l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02); l.forwardY.setTargetAtTime(fy, t, 0.02); l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(x, y, z);
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // --- ambience -------------------------------------------------------------
  startAmbience() {
    const c = this.ctx, t = this.now;
    // low drone
    const droneF = c.createBiquadFilter(); droneF.type = 'lowpass'; droneF.frequency.value = 190;
    const droneG = c.createGain(); droneG.gain.value = 0.2;
    droneF.connect(droneG).connect(this.amb);
    for (const [type, f, g] of [['sine', 55, 0.5], ['sine', 55.6, 0.45], ['triangle', 82.6, 0.2], ['sawtooth', 36.8, 0.1]]) {
      const o = c.createOscillator(), og = c.createGain();
      o.type = type; o.frequency.value = f; og.gain.value = g;
      o.connect(og).connect(droneF); o.start(t);
    }
    const lfo = c.createOscillator(), lfoG = c.createGain();
    lfo.frequency.value = 0.06; lfoG.gain.value = 70; lfo.connect(lfoG).connect(droneF.frequency); lfo.start(t);
    // air / rumble
    const air = c.createBufferSource(); air.buffer = this.noiseBuf; air.loop = true;
    const airF = c.createBiquadFilter(); airF.type = 'lowpass'; airF.frequency.value = 110;
    const airG = c.createGain(); airG.gain.value = 0.3;
    air.connect(airF).connect(airG).connect(this.amb); air.start(t);
    // fluorescent buzz
    this.buzzG = c.createGain(); this.buzzG.gain.value = 0;
    const buzzF = c.createBiquadFilter(); buzzF.type = 'bandpass'; buzzF.frequency.value = 2100; buzzF.Q.value = 1.4;
    for (const f of [120, 240.4, 359.6]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(buzzF); o.start(t); }
    buzzF.connect(this.buzzG).connect(this.amb);
    // tension: a dissonant cluster that swells when something is close
    this.tensionG = c.createGain(); this.tensionG.gain.value = 0;
    const tenF = c.createBiquadFilter(); tenF.type = 'bandpass'; tenF.frequency.value = 1300; tenF.Q.value = 0.8;
    for (const f of [466.2, 493.9, 698.5, 740]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const v = c.createOscillator(), vg = c.createGain(); v.frequency.value = rand(4, 6.5); vg.gain.value = f * 0.008;
      v.connect(vg).connect(o.frequency); v.start(t);
      o.connect(tenF); o.start(t);
    }
    tenF.connect(this.tensionG).connect(this.amb);
  }

  /** Fade the hotel's ambience in or out (menus are silent, the hotel is not). */
  setAmbience(on) {
    if (!this.ctx) return;
    this.amb.gain.setTargetAtTime(on ? 1 : 0, this.now, 0.6);
    if (!on) { this.buzzG.gain.setTargetAtTime(0, this.now, 0.2); this.tensionG.gain.setTargetAtTime(0, this.now, 0.2); }
  }

  /** Per-frame: buzz 0..1 (how close a lit fixture is), tension 0..1 (how close a monster is). */
  update(dt, buzz, tension, moving) {
    if (!this.ctx) return;
    const t = this.now;
    this.tension = tension;
    this.buzzG.gain.setTargetAtTime(buzz * 0.028, t, 0.08);
    this.tensionG.gain.setTargetAtTime(Math.pow(tension, 1.8) * 0.05, t, 0.3);
    if (tension > 0.3) {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 1.05 - tension * 0.62;
        const v = 0.25 + tension * 0.55;
        this.tone(this.sfx, 'sine', 62, 38, t, 0.16, v, 0.01);
        this.tone(this.sfx, 'sine', 54, 34, t + 0.14, 0.2, v * 0.75, 0.01);
      }
    }
    this.thumpT -= dt;
    if (this.thumpT <= 0) { this.thumpT = rand(7, 20); if (Math.random() < 0.1) this.sfx_farScream(); else this.distantThump(); }
    this.creakT -= dt;
    if (this.creakT <= 0) { this.creakT = rand(9, 24) * (moving ? 0.5 : 1); this.creak(rand(0.03, 0.07), rand(-1, 1)); }
  }

  distantThump() {
    const c = this.ctx, t = this.now;
    const pan = c.createStereoPanner(); pan.pan.value = rand(-0.9, 0.9);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = rand(180, 420);
    lp.connect(pan).connect(this.amb);
    const kind = Math.random();
    const v = rand(0.25, 0.6);
    if (kind < 0.55) {
      const n = Math.random() < 0.3 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        this.tone(lp, 'sine', 70, 34, t + i * 0.34, 0.5, v, 0.01);
        this.noise(lp, 'lowpass', 300, 80, 1, t + i * 0.34, 0.3, v * 0.6);
      }
    } else if (kind < 0.8) {
      // something heavy dragged across a floor above
      this.noise(lp, 'bandpass', 140, 90, 3, t, 2.4, v * 0.8, 0.5);
    } else {
      // pipes groaning
      this.tone(lp, 'sawtooth', 74, 61, t, 2.6, v * 0.25, 0.8);
      this.tone(lp, 'sawtooth', 111, 92, t, 2.6, v * 0.14, 0.8);
    }
    setTimeout(() => { try { pan.disconnect(); } catch { /* gone */ } }, 4000);
  }

  creak(vol = 0.06, panV = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = this.now;
    const pan = c.createStereoPanner(); pan.pan.value = panV;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9;
    const f0 = rand(600, 1100);
    bp.frequency.setValueAtTime(f0, t); bp.frequency.linearRampToValueAtTime(f0 * rand(1.2, 1.6), t + 0.25); bp.frequency.linearRampToValueAtTime(f0 * 0.9, t + 0.6);
    bp.connect(pan).connect(this.sfx);
    const base = rand(130, 210);
    this.tone(bp, 'sawtooth', base, base * 1.35, t, 0.55, vol * 6, 0.08);
    this.tone(bp, 'sawtooth', base * 1.51, base * 1.9, t + 0.05, 0.45, vol * 4, 0.08);
    setTimeout(() => { try { pan.disconnect(); } catch { /* gone */ } }, 1500);
  }

  step(kind = 'walk') {
    if (!this.ctx) return;
    const t = this.now;
    const v = kind === 'crouch' ? 0.035 : kind === 'sprint' ? 0.2 : 0.1;
    this.noise(this.sfx, 'lowpass', rand(420, 620), 160, 0.7, t, 0.13, v);
    this.tone(this.sfx, 'sine', rand(72, 90), 50, t, 0.09, v * 0.9, 0.004);
    if (kind !== 'crouch' && Math.random() < (kind === 'sprint' ? 0.16 : 0.08)) this.creak(rand(0.03, 0.06), rand(-0.4, 0.4));
  }

  // --- one-shots ------------------------------------------------------------
  play(name, a, b, c2) {
    if (!this.ctx) return;
    const fn = this['sfx_' + name];
    if (fn) fn.call(this, a, b, c2);
  }

  sfx_click() { this.tone(this.sfx, 'square', 900, 500, this.now, 0.05, 0.05, 0.002); }
  sfx_type() {
    const t = this.now;
    this.noise(this.sfx, 'highpass', 2600, 2600, 0.7, t, 0.035, 0.09, 0.001);
    this.tone(this.sfx, 'square', rand(170, 210), 120, t, 0.04, 0.05, 0.001);
  }
  sfx_key() {
    const t = this.now;
    [1318.5, 1760, 2637, 3520].forEach((f, i) => this.tone(this.sfx, 'sine', f, f, t + i * 0.09, 1.1, 0.16, 0.005));
    this.tone(this.sfx, 'triangle', 659, 659, t, 1.2, 0.07, 0.01);
  }
  sfx_battery() {
    const t = this.now;
    this.noise(this.sfx, 'highpass', 3000, 3000, 1, t, 0.03, 0.1, 0.001);
    this.tone(this.sfx, 'square', 420, 880, t + 0.03, 0.16, 0.07, 0.004);
  }
  sfx_rocketPickup() {
    const t = this.now;
    this.tone(this.sfx, 'triangle', 300, 300, t, 0.1, 0.14, 0.004);
    this.tone(this.sfx, 'triangle', 450, 450, t + 0.09, 0.16, 0.14, 0.004);
    this.noise(this.sfx, 'lowpass', 500, 200, 1, t, 0.1, 0.12);
  }
  sfx_toggle() { this.noise(this.sfx, 'highpass', 4000, 4000, 1, this.now, 0.025, 0.07, 0.001); this.tone(this.sfx, 'square', 240, 200, this.now, 0.03, 0.04, 0.001); }
  sfx_empty() { this.tone(this.sfx, 'square', 140, 90, this.now, 0.09, 0.07, 0.002); }
  sfx_launch() {
    const t = this.now;
    this.noise(this.sfx, 'bandpass', 2600, 380, 1.2, t, 0.7, 0.5, 0.01);
    this.tone(this.sfx, 'sawtooth', 240, 70, t, 0.5, 0.16, 0.01);
    this.tone(this.sfx, 'sine', 1900, 700, t, 0.6, 0.05, 0.02);
  }
  sfx_boom(x, y, z) {
    const t = this.now, out = this.at(x, y, z, 7, 0.8, 5);
    this.noise(out, 'lowpass', 4200, 90, 0.6, t, 1.5, 1.6, 0.003);
    this.tone(out, 'sine', 100, 28, t, 1.0, 1.4, 0.004);
    this.noise(out, 'highpass', 5000, 3000, 1, t, 0.12, 0.6, 0.001);
    for (let i = 0; i < 16; i++) this.noise(out, 'bandpass', rand(2500, 7000), 0, 3, t + rand(0.1, 1.5), 0.04, rand(0.1, 0.35), 0.001);
  }
  sfx_powerDown() {
    const t = this.now;
    this.tone(this.sfx, 'sawtooth', 190, 24, t, 1.8, 0.3, 0.02);
    this.tone(this.sfx, 'sine', 120, 30, t, 1.6, 0.4, 0.02);
    this.noise(this.sfx, 'lowpass', 500, 60, 1, t, 0.4, 0.6, 0.002);
  }
  sfx_powerUp() {
    const t = this.now;
    this.noise(this.sfx, 'lowpass', 700, 100, 1, t, 0.25, 0.5, 0.002);
    this.tone(this.sfx, 'sawtooth', 40, 118, t, 0.8, 0.14, 0.2);
    for (let i = 0; i < 7; i++) this.noise(this.sfx, 'highpass', 5000, 5000, 1, t + 0.15 + i * rand(0.06, 0.16), 0.02, 0.07, 0.001);
  }
  sfx_door(x, z, opening) {
    const t = this.now, out = this.at(x, 1.2, z, 2.5, 1.4, 2);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 11;
    const f = rand(700, 1200);
    bp.frequency.setValueAtTime(f, t); bp.frequency.linearRampToValueAtTime(f * (opening ? 1.5 : 0.7), t + 0.5);
    bp.connect(out);
    const b0 = rand(170, 260);
    this.tone(bp, 'sawtooth', b0, b0 * (opening ? 1.4 : 0.75), t, 0.55, 0.5, 0.06);
    this.noise(out, 'lowpass', 900, 300, 1, t + (opening ? 0 : 0.5), 0.06, 0.25, 0.002);
  }
  sfx_hide() {
    const t = this.now;
    this.noise(this.sfx, 'lowpass', 380, 150, 1, t, 0.1, 0.4, 0.002);
    this.noise(this.sfx, 'lowpass', 300, 120, 1, t + 0.22, 0.12, 0.5, 0.002);
    this.creak(0.05, 0);
  }
  sfx_elevDing() {
    const t = this.now;
    for (const [f, d] of [[1568, 0], [1318.5, 0.38]]) {
      this.tone(this.sfx, 'sine', f, f, t + d, 1.8, 0.22, 0.004);
      this.tone(this.sfx, 'sine', f * 2.76, f * 2.76, t + d, 0.9, 0.05, 0.004);
    }
  }
  sfx_stun() {
    const t = this.now;
    this.tone(this.sfx, 'sawtooth', 900, 140, t, 0.35, 0.12, 0.004);
    this.noise(this.sfx, 'highpass', 3500, 6000, 1, t, 0.3, 0.14, 0.004);
  }
  sfx_managerPA() {
    const c = this.ctx, t = this.now;
    const ws = c.createWaveShaper(); ws.curve = this.distCurve;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.6;
    const g = c.createGain(); g.gain.value = 0.35;
    ws.connect(bp).connect(g).connect(this.sfx);
    this.noise(bp, 'highpass', 3000, 3000, 1, t, 4.2, 0.12, 0.05);
    this.tone(ws, 'sine', 659, 659, t + 0.2, 1.1, 0.5, 0.01);
    this.tone(ws, 'sine', 523, 523, t + 1.0, 1.6, 0.5, 0.01);
    // feedback squeal, then the floor shakes
    this.tone(ws, 'sine', 2400, 3100, t + 2.4, 0.7, 0.2, 0.2);
    this.tone(this.sfx, 'sawtooth', 38, 30, t + 2.6, 3.2, 0.55, 1.2);
    this.tone(this.sfx, 'sine', 46, 33, t + 2.6, 3.2, 0.6, 1.2);
    setTimeout(() => { try { g.disconnect(); } catch { /* gone */ } }, 7000);
  }
  sfx_death() {
    const t = this.now;
    for (const f of [55, 58.3, 82.4, 110.2]) this.tone(this.sfx, 'sine', f, f * 0.97, t, 4.5, 0.3, 0.02);
    this.noise(this.sfx, 'lowpass', 200, 60, 1, t, 3, 0.4, 0.02);
  }
  sfx_win() {
    const t = this.now;
    this.sfx_elevDing();
    [261.6, 329.6, 392, 523.3, 659.3].forEach((f, i) => {
      this.tone(this.sfx, 'sine', f, f, t + 0.9 + i * 0.22, 3.4, 0.16, 0.3);
      this.tone(this.sfx, 'triangle', f * 2, f * 2, t + 0.9 + i * 0.22, 2.4, 0.04, 0.3);
    });
  }

  // --- scares ---------------------------------------------------------------
  /** The orchestra hit when something steps into your light. */
  sfx_sting(vol = 1) {
    const c = this.ctx, t = this.now;
    const ws = c.createWaveShaper(); ws.curve = this.distCurve;
    const g = c.createGain(); g.gain.value = 0.5 * vol;
    ws.connect(g).connect(this.master);
    for (const f of [110, 116.5, 233.1, 247, 466.2, 493.9]) this.tone(ws, 'sawtooth', f, f * 0.985, t, 1.9, 0.28, 0.004);
    this.noise(ws, 'lowpass', 5000, 300, 0.7, t, 0.5, 0.6, 0.002);
    this.tone(this.master, 'sine', 60, 30, t, 1.4, 0.8 * vol, 0.004);
    setTimeout(() => { try { g.disconnect(); } catch { /* gone */ } }, 3000);
  }

  /** Someone murmuring just behind one ear. No words you can make out. */
  sfx_whisper(pan = 0) {
    const c = this.ctx, t = this.now;
    const p = c.createStereoPanner(); p.pan.value = pan; p.connect(this.sfx);
    let tt = t;
    const n = 5 + ((Math.random() * 6) | 0);
    for (let i = 0; i < n; i++) {
      const d = rand(0.09, 0.26);
      this.noise(p, 'bandpass', rand(1400, 3200), rand(1400, 3200), 3.5, tt, d, rand(0.3, 0.55), d * 0.35);
      this.noise(p, 'highpass', 5200, 5200, 0.7, tt, d * 0.6, 0.07, 0.01);
      tt += d + rand(0.01, 0.12);
    }
    setTimeout(() => { try { p.disconnect(); } catch { /* gone */ } }, 5000);
  }

  /** Slow breathing that is not yours. */
  sfx_breath(pan = 0) {
    const c = this.ctx, t = this.now;
    const p = c.createStereoPanner(); p.pan.value = pan; p.connect(this.sfx);
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 2.3;
      this.noise(p, 'bandpass', 800, 1500, 1.2, tt, 1.0, 0.3, 0.55);
      this.noise(p, 'bandpass', 700, 380, 1.0, tt + 1.05, 1.2, 0.36, 0.25);
    }
    setTimeout(() => { try { p.disconnect(); } catch { /* gone */ } }, 6500);
  }

  sfx_slam(x, z) {
    const t = this.now, out = this.at(x, 1.2, z, 6, 0.9, 3);
    this.noise(out, 'lowpass', 1500, 90, 0.8, t, 0.55, 2.6, 0.002);
    this.tone(out, 'sine', 95, 36, t, 0.5, 2.4, 0.003);
    this.noise(out, 'highpass', 2500, 2500, 1, t, 0.05, 0.8, 0.001);
  }

  /** A scream from another floor, and its echoes. */
  sfx_farScream() {
    const c = this.ctx, t = this.now;
    const pan = c.createStereoPanner(); pan.pan.value = rand(-0.9, 0.9);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
    lp.connect(pan).connect(this.sfx);
    for (let e = 0; e < 4; e++) {
      const tt = t + e * 0.31, v = 0.16 / (1 + e * 1.7);
      for (const f of [760, 1013]) {
        const o = this.tone(lp, 'sawtooth', f, f * 0.6, tt, 1.7, v, 0.12);
        o.frequency.linearRampToValueAtTime(f * 1.3, tt + 0.35);
      }
    }
    setTimeout(() => { try { pan.disconnect(); } catch { /* gone */ } }, 4500);
  }

  /** Flies. They gather where the birds are. */
  setFlies(x, y, z, on) {
    if (!this.ctx) return;
    if (!this.flies) {
      if (!on) return;
      const c = this.ctx, t = this.now;
      const p = this.makePanner(1.1, 2.6);
      const g = c.createGain(); g.gain.value = 0;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 950; bp.Q.value = 1.6;
      for (const [f, rate] of [[188, 21], [207, 27], [231, 17]]) {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
        const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = rate; lg.gain.value = 26;
        l.connect(lg).connect(o.frequency); l.start(t);
        const am = c.createGain(); am.gain.value = 0.5;
        const l2 = c.createOscillator(), l2g = c.createGain(); l2.frequency.value = rand(0.3, 1.1); l2g.gain.value = 0.5;
        l2.connect(l2g).connect(am.gain); l2.start(t);
        o.connect(am).connect(bp); o.start(t);
      }
      bp.connect(g).connect(p).connect(this.sfx);
      this.flies = { p, g };
    }
    this.setPannerPos(this.flies.p, x, y, z);
    this.flies.g.gain.setTargetAtTime(on ? 0.55 : 0, this.now, 0.3);
  }

  /** The jumpscare. Each member of staff sounds different up close. */
  scream(type) {
    if (!this.ctx) return;
    const c = this.ctx, t = this.now;
    const ws = c.createWaveShaper(); ws.curve = this.distCurve;
    const g = c.createGain(); g.gain.value = 0.85;
    ws.connect(g).connect(this.master);
    const dur = 1.5;
    if (type === 'manager') {
      for (const f of [58, 87, 91, 131]) this.tone(ws, 'sawtooth', f, f * 2.4, t, dur, 0.5, 0.01);
      this.noise(ws, 'lowpass', 900, 2600, 1, t, dur, 0.8, 0.01);
    } else if (type === 'maid') {
      for (const f of [1180, 1420, 1765, 2210]) {
        const o = this.tone(ws, 'sawtooth', f * 0.6, f * 1.25, t, dur, 0.4, 0.01);
        const v = c.createOscillator(), vg = c.createGain(); v.frequency.value = 11; vg.gain.value = 60;
        v.connect(vg).connect(o.frequency); v.start(t); v.stop(t + dur);
      }
      this.noise(ws, 'bandpass', 3000, 4500, 2, t, dur, 0.5, 0.01);
    } else if (type === 'bellhop') {
      for (const f of [420, 640, 911]) this.tone(ws, 'square', f, f * 2.6, t, dur, 0.35, 0.005);
      for (let i = 0; i < 40; i++) this.noise(ws, 'highpass', 2500, 2500, 2, t + i * 0.036, 0.02, 0.9, 0.001);
      this.noise(ws, 'bandpass', 1800, 3600, 3, t, dur, 0.5, 0.01);
    } else {
      for (const f of [311, 466, 622, 933]) this.tone(ws, 'sawtooth', f, f * 2.1, t, dur, 0.4, 0.01);
      for (let i = 0; i < 14; i++) this.bell(ws, t + i * 0.1, 1.2, 1760 * rand(0.97, 1.03));
      this.noise(ws, 'bandpass', 2200, 4000, 1.5, t, dur, 0.5, 0.01);
    }
    this.tone(this.master, 'sine', 70, 28, t, 1.2, 0.9, 0.004);
    setTimeout(() => { try { g.disconnect(); } catch { /* gone */ } }, 3000);
  }

  bell(dest, t, vol, f0 = 1760) {
    const partials = [[1, 1], [2.76, 0.45], [5.4, 0.22], [8.93, 0.1]];
    for (const [m, g] of partials) this.tone(dest, 'sine', f0 * m, f0 * m, t, 1.3 / Math.sqrt(m), vol * g * 0.5, 0.002);
    this.noise(dest, 'highpass', 5000, 5000, 1, t, 0.02, vol * 0.25, 0.001);
  }

  // --- monster signatures -----------------------------------------------------
  voice(type) {
    let v = this.voices[type];
    if (v) return v;
    const cfg = { concierge: [5, 0.9], maid: [3, 1.2], bellhop: [3, 1.2], manager: [5, 0.9] }[type];
    const p = this.makePanner(cfg[0], cfg[1], true);
    p.connect(this.sfx);
    v = this.voices[type] = { panner: p, t: 0, t2: 0, lastState: -1, growl: null };
    if (type === 'manager') {
      const c = this.ctx, t = this.now;
      const g = c.createGain(); g.gain.value = 0;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 210;
      const trem = c.createGain(); trem.gain.value = 0.7;
      const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 5.2; lg.gain.value = 0.3;
      lfo.connect(lg).connect(trem.gain); lfo.start(t);
      for (const f of [41, 43.6, 82.5, 123]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(t); }
      const br = c.createBufferSource(); br.buffer = this.noiseBuf; br.loop = true;
      const bf = c.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 520; bf.Q.value = 2;
      const bg = c.createGain(); bg.gain.value = 0.25;
      br.connect(bf).connect(bg).connect(trem); br.start(t);
      lp.connect(trem).connect(g).connect(p);
      v.growl = g;
    }
    return v;
  }

  /**
   * Called every frame per monster. m: { type, x, z, active, state, speed, eye }
   * States: 0 idle, 1 wander, 2 hunt, 3 frozen, 4 alert, 5 charge, 6 rest, 7 stunned
   */
  updateMonster(m, dt) {
    if (!this.ctx) return;
    const v = this.voice(m.type);
    const t = this.now;
    if (!m.active) { if (v.growl) v.growl.gain.setTargetAtTime(0, t, 0.2); return; }
    this.setPannerPos(v.panner, m.x, m.eye, m.z);
    const dist = Math.hypot(m.x - this.lx, m.z - this.lz);
    const stunned = m.state === 7;
    v.t -= dt; v.t2 -= dt;
    const entered = m.state !== v.lastState;
    v.lastState = m.state;
    if (dist > 75) return;

    if (m.type === 'concierge') {
      // service bell: faster and louder the closer he is
      if (v.t <= 0 && !stunned) {
        const near = clamp(1 - dist / 42, 0, 1);
        v.t = 0.26 + (1 - near) * (1 - near) * 3.0;
        this.bell(v.panner, t, 0.5 + near * 1.6);
      }
    } else if (m.type === 'maid') {
      if (m.state === 2) {
        // hunting: the weeping stops. Only fast bare footsteps.
        if (v.t2 <= 0) { v.t2 = 0.15; this.noise(v.panner, 'lowpass', 700, 250, 1, t, 0.06, 0.5, 0.002); }
      } else if (v.t <= 0 && !stunned) {
        v.t = rand(0.42, 1.25);
        const f = rand(480, 700), n = Math.random() < 0.4 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const tt = t + i * 0.17;
          const o = this.tone(v.panner, 'triangle', f * (1 + i * 0.04), f * 0.8, tt, 0.24, 0.5, 0.03);
          const vib = this.ctx.createOscillator(), vg = this.ctx.createGain(); vib.frequency.value = 7; vg.gain.value = 14;
          vib.connect(vg).connect(o.frequency); vib.start(tt); vib.stop(tt + 0.3);
          this.noise(v.panner, 'bandpass', 1500, 900, 2, tt, 0.2, 0.14, 0.03);
        }
        if (Math.random() < 0.25) this.noise(v.panner, 'bandpass', 2400, 1200, 1.5, t + 0.6, 0.5, 0.12, 0.2); // shaky breath in
      }
    } else if (m.type === 'bellhop') {
      const fast = m.state === 4 || m.state === 5;
      if (entered && m.state === 5) {
        const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2000; bp.Q.value = 2; bp.connect(v.panner);
        this.tone(bp, 'sawtooth', 500, 1700, t, 0.7, 2.2, 0.02);
        this.tone(bp, 'square', 760, 2300, t, 0.7, 1.2, 0.02);
      }
      if (fast) {
        if (v.t2 <= 0) { v.t2 = 0.085; this.noise(v.panner, 'highpass', rand(1800, 2600), 0, 2, t, 0.03, 0.8, 0.001); }
      } else if (v.t <= 0 && !stunned) {
        // teeth chattering
        v.t = m.state === 6 ? 0.5 : rand(1.4, 3.0);
        const n = m.state === 6 ? 3 : 8 + ((Math.random() * 8) | 0);
        for (let i = 0; i < n; i++) this.noise(v.panner, 'bandpass', rand(2600, 3800), 0, 4, t + i * 0.052, 0.022, 0.9, 0.001);
      }
    } else if (m.type === 'manager') {
      v.growl.gain.setTargetAtTime(stunned ? 0.15 : 0.9, t, 0.3);
      if (m.speed > 0.5 && v.t <= 0) {
        v.t = 0.56;
        this.tone(v.panner, 'sine', 64, 30, t, 0.3, 2.6, 0.004);
        this.noise(v.panner, 'lowpass', 260, 70, 1, t, 0.22, 1.6, 0.003);
      }
    }
  }

  silenceMonsters() {
    if (!this.ctx) return;
    for (const v of Object.values(this.voices)) if (v.growl) v.growl.gain.setTargetAtTime(0, this.now, 0.1);
  }
}

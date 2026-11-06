/** Tiny procedural sound effects with WebAudio; no audio assets needed. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private sfxVolume = 0.8;
  private musicVolume = 0.35;
  muted = false;
  private lastEat = 0;

  private ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35 * this.sfxVolume;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.muted ? 0 : this.musicVolume * 0.5;
      this.musicBus.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  unlock() {
    this.ensure();
  }

  toggle() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.musicBus) this.musicBus.gain.value = m ? 0 : this.musicVolume * 0.5;
  }

  setVolumes(sfx: number, music: number) {
    this.sfxVolume = sfx;
    this.musicVolume = music;
    if (this.master) this.master.gain.value = 0.35 * sfx;
    if (this.musicBus) this.musicBus.gain.value = this.muted ? 0 : music * 0.5;
  }

  /**
   * Generative ambient music: a slow pad that drifts through a minor
   * progression, plus sparse pentatonic plucks through a feedback delay.
   * Nothing is pre-recorded; it never repeats exactly.
   */
  startMusic() {
    const ctx = this.ensure();
    if (!ctx || !this.musicBus || this.musicTimer) return;
    const bus = this.musicBus;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(bus);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(bus);
    // A minor: Am, F, C, G (roots in Hz, low register)
    const chords = [
      [110, 130.81, 164.81],
      [87.31, 110, 130.81],
      [130.81, 164.81, 196],
      [98, 123.47, 146.83],
    ];
    const penta = [440, 523.25, 587.33, 659.25, 783.99, 880];
    let step = 0;
    const pad = () => {
      const t0 = ctx.currentTime;
      for (const f of chords[step % chords.length]) {
        for (const det of [-4, 4]) {
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = f;
          o.detune.value = det;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.05, t0 + 3);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 9.5);
          o.connect(g).connect(lp);
          o.start(t0);
          o.stop(t0 + 10);
        }
      }
      step++;
    };
    const pluck = () => {
      if (Math.random() < 0.45) return;
      const t0 = ctx.currentTime + Math.random() * 0.8;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = penta[Math.floor(Math.random() * penta.length)] * (Math.random() < 0.3 ? 0.5 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
      o.connect(g);
      g.connect(bus);
      g.connect(delay);
      o.start(t0);
      o.stop(t0 + 1.3);
    };
    pad();
    let ticks = 0;
    this.musicTimer = setInterval(() => {
      ticks++;
      if (ticks % 8 === 0) pad();
      pluck();
    }, 1000);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  eat(crystal = false) {
    const now = performance.now();
    if (!crystal && now - this.lastEat < 45) return;
    this.lastEat = now;
    if (crystal) {
      this.tone(880, 0.12, 'sine', 0.25, 1320);
      this.tone(1320, 0.18, 'sine', 0.18, 1760, 0.06);
    } else this.tone(520 + Math.random() * 180, 0.07, 'sine', 0.12, 900);
  }
  levelUp() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.22, undefined, i * 0.08));
  }
  hit(strong: boolean) {
    this.noise(strong ? 0.18 : 0.1, strong ? 0.5 : 0.25, strong ? 900 : 1600);
    this.tone(strong ? 140 : 220, 0.12, 'square', 0.08, 60);
  }
  hurt() {
    this.tone(180, 0.2, 'sawtooth', 0.15, 70);
    this.noise(0.15, 0.35, 700);
  }
  dash() {
    this.noise(0.25, 0.25, 2600);
    this.tone(300, 0.2, 'sine', 0.1, 700);
  }
  toxin() {
    this.noise(0.6, 0.3, 500);
    this.tone(110, 0.5, 'sawtooth', 0.06, 80);
  }
  death() {
    this.noise(0.5, 0.6, 1200);
    this.tone(300, 0.6, 'triangle', 0.2, 50);
  }
  /** Dash flavoured by layout: a flagellum whooshes, cilia flutter. */
  dashFor(kind: 'flagellum' | 'cilia' | 'plain') {
    if (kind === 'flagellum') this.sweep(0.4, 350, 2600, 0.35);
    else if (kind === 'cilia') {
      for (let i = 0; i < 5; i++) this.tone(900 + i * 140, 0.05, 'triangle', 0.05, 1400, i * 0.035);
      this.noise(0.18, 0.12, 4000);
    } else this.dash();
  }

  /** Your spikes connecting: a meaty crunch. */
  spikeHit(strong: boolean) {
    this.noise(strong ? 0.2 : 0.12, strong ? 0.55 : 0.35, 2200);
    this.tone(strong ? 110 : 150, 0.14, 'square', 0.1, 45);
  }

  /** Band-passed noise sweep (whoosh). */
  private sweep(dur: number, f0: number, f1: number, vol: number) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((i / len) * Math.PI);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(f0, ctx.currentTime);
    bp.frequency.exponentialRampToValueAtTime(f1, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
  }

  /** Organelle breaking: a dry crunch. */
  crunch() {
    this.noise(0.12, 0.6, 3200);
    this.tone(160, 0.1, 'square', 0.12, 50);
  }
  attach() {
    this.tone(420, 0.08, 'square', 0.12, 640);
    this.tone(840, 0.2, 'sine', 0.15, 1100, 0.05);
  }
}

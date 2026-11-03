/** Tiny procedural sound effects with WebAudio; no audio assets needed. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;
  private lastEat = 0;

  private ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  unlock() {
    this.ensure();
  }

  toggle() {
    this.muted = !this.muted;
    return this.muted;
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
  attach() {
    this.tone(420, 0.08, 'square', 0.12, 640);
    this.tone(840, 0.2, 'sine', 0.15, 1100, 0.05);
  }
}

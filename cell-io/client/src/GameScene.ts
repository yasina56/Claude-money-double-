import Phaser from 'phaser';
import { cameraZoom } from '../../shared/constants';
import { clamp, lerp, TAU } from '../../shared/math';
import { CellFlag, type GameEvent } from '../../shared/protocol';
import { drawCell, hsl, type Painter, type Pt } from './art';
import type { Sfx } from './audio';
import type { CellSnap, Net } from './net';

class PhaserPainter implements Painter {
  constructor(public g: Phaser.GameObjects.Graphics) {}
  fill(color: number, alpha: number) {
    this.g.fillStyle(color, alpha);
  }
  stroke(width: number, color: number, alpha: number) {
    this.g.lineStyle(width, color, alpha);
  }
  circle(x: number, y: number, r: number, fill: boolean) {
    if (fill) this.g.fillCircle(x, y, Math.max(0, r));
    else this.g.strokeCircle(x, y, Math.max(0, r));
  }
  poly(pts: Pt[], fill: boolean, closed = true) {
    if (pts.length < 2) return;
    if (fill) this.g.fillPoints(pts as Phaser.Types.Math.Vector2Like[], true);
    else this.g.strokePoints(pts as Phaser.Types.Math.Vector2Like[], closed, closed);
  }
}

interface CellView {
  g: Phaser.GameObjects.Graphics;
  painter: PhaserPainter;
  label: Phaser.GameObjects.Text;
  seed: number;
  jiggle: number;
  x: number;
  y: number;
  r: number;
  heading: number;
  missing: number;
  labelKey: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
  drag: number;
}

const NUTRIENT_COLORS = [0x7dffb2, 0xffe36b, 0xff8ad8, 0x8ad8ff, 0xffa86b];
const HIT_COLORS: Record<string, number> = { spike: 0xffffff, sting: 0xd08bff, bump: 0xb8d4dc, dot: 0x9dff3d, toxin: 0xc6ff3d, acid: 0xc6ff3d };

export class BackgroundScene extends Phaser.Scene {
  private layers: Phaser.GameObjects.TileSprite[] = [];
  private grad!: Phaser.GameObjects.Graphics;
  constructor() {
    super({ key: 'bg', active: true });
  }
  create() {
    const make = (key: string, count: number, maxR: number, alpha: number, seed: number) => {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < count; i++) {
        const x = rnd() * 512;
        const y = rnd() * 512;
        const r = 2 + rnd() * maxR;
        const c = [0x2a8c9a, 0x3fb39f, 0x2f6f9a, 0x5b8f6a][Math.floor(rnd() * 4)];
        g.fillStyle(c, alpha * 0.5);
        g.fillCircle(x, y, r * 1.8);
        g.fillStyle(c, alpha);
        g.fillCircle(x, y, r);
      }
      g.generateTexture(key, 512, 512);
      g.destroy();
    };
    make('bg-far', 40, 10, 0.12, 7);
    make('bg-near', 18, 4, 0.3, 99);
    this.grad = this.add.graphics();
    this.layers = [this.add.tileSprite(0, 0, 10, 10, 'bg-far').setOrigin(0), this.add.tileSprite(0, 0, 10, 10, 'bg-near').setOrigin(0)];
    this.resize();
    this.scale.on('resize', () => this.resize());
  }
  private resize() {
    const { width, height } = this.scale;
    this.grad.clear();
    this.grad.fillGradientStyle(0x0b2a33, 0x0b2a33, 0x041217, 0x041217, 1);
    this.grad.fillRect(0, 0, width, height);
    for (const l of this.layers) l.setSize(width, height);
  }
  update() {
    const game = this.scene.get('game') as GameScene;
    const cam = game?.cameras?.main;
    if (!cam) return;
    const cx = cam.midPoint.x;
    const cy = cam.midPoint.y;
    this.layers[0].tilePositionX = cx * 0.15;
    this.layers[0].tilePositionY = cy * 0.15;
    this.layers[1].tilePositionX = cx * 0.4;
    this.layers[1].tilePositionY = cy * 0.4;
  }
}

export class GameScene extends Phaser.Scene {
  private views = new Map<number, CellView>();
  private nutrientImgs = new Map<number, Phaser.GameObjects.Image>();
  private eaten = new Set<number>();
  private particles: Particle[] = [];
  private gridG!: Phaser.GameObjects.Graphics;
  private hazardG!: Phaser.GameObjects.Graphics;
  private hazardAnimG!: Phaser.GameObjects.Graphics;
  private cloudG!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private hazardsDrawn: unknown = null;
  private lastInputSent = 0;
  private camPos = { x: 2400, y: 2400 };
  private camZoom = 1;
  private ownSmooth: { x: number; y: number } | null = null;
  inputEnabled = true;
  /** Last world position of our cell (for spectating after death). */
  focus = { x: 2400, y: 2400, r: 22 };
  /** Facing of our own cell, used by the HUD front indicator. */
  ownHeading = 0;

  constructor(
    private net: Net,
    private sfx: Sfx,
  ) {
    super({ key: 'game', active: true });
  }

  create() {
    // Nutrient textures
    NUTRIENT_COLORS.forEach((c, i) => {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(c, 0.18);
      g.fillCircle(16, 16, 15);
      g.fillStyle(c, 0.4);
      g.fillCircle(16, 16, 10);
      g.fillStyle(c, 1);
      g.fillCircle(16, 16, 6);
      g.fillStyle(0xffffff, 0.7);
      g.fillCircle(14, 14, 2.2);
      g.generateTexture(`n${i}`, 32, 32);
      g.destroy();
    });
    {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0x9ffcff, 0.15);
      g.fillCircle(24, 24, 23);
      g.fillStyle(0x9ffcff, 0.3);
      g.fillCircle(24, 24, 15);
      const hex: Pt[] = [];
      for (let k = 0; k < 6; k++) hex.push({ x: 24 + Math.cos((k / 6) * TAU) * 10, y: 24 + Math.sin((k / 6) * TAU) * 10 });
      g.fillStyle(0xe9ffff, 1);
      g.fillPoints(hex as Phaser.Types.Math.Vector2Like[], true);
      g.lineStyle(2, 0x3fd6ff, 1);
      g.strokePoints(hex as Phaser.Types.Math.Vector2Like[], true, true);
      g.generateTexture('crystal', 48, 48);
      g.destroy();
    }

    this.gridG = this.add.graphics().setDepth(0);
    this.hazardG = this.add.graphics().setDepth(1);
    this.hazardAnimG = this.add.graphics().setDepth(1.5);
    this.cloudG = this.add.graphics().setDepth(4);
    this.fxG = this.add.graphics().setDepth(20);
    this.drawGrid();

    this.net.onNutrientsRemoved = (ids) => {
      for (const id of ids) {
        const img = this.nutrientImgs.get(id);
        if (!img) continue;
        this.nutrientImgs.delete(id);
        this.tweens.add({ targets: img, alpha: 0, scale: 0.2, duration: 200, onComplete: () => img.destroy() });
      }
      for (const id of this.eaten) if (!this.net.nutrients.has(id)) this.eaten.delete(id);
    };
    this.scale.on('resize', () => this.net.sendView(this.scale.width, this.scale.height));
    this.net.sendView(this.scale.width, this.scale.height);
  }

  private drawGrid() {
    const g = this.gridG;
    const size = this.net.worldSize;
    g.clear();
    g.lineStyle(1, 0x4fb3c4, 0.07);
    for (let v = 0; v <= size; v += 120) {
      g.lineBetween(v, 0, v, size);
      g.lineBetween(0, v, size, v);
    }
    g.lineStyle(8, 0x5ef2d6, 0.35);
    g.strokeRect(0, 0, size, size);
    g.lineStyle(30, 0x5ef2d6, 0.06);
    g.strokeRect(-15, -15, size + 30, size + 30);
  }

  private drawHazards() {
    const g = this.hazardG;
    g.clear();
    for (const h of this.net.hazards) {
      if (h.kind === 'acid') {
        g.fillStyle(0x9dff3d, 0.06);
        g.fillCircle(h.x, h.y, h.r * 1.15);
        g.fillStyle(0x7ad62a, 0.16);
        g.fillCircle(h.x, h.y, h.r);
        g.fillStyle(0xb8ff5a, 0.12);
        g.fillCircle(h.x, h.y, h.r * 0.7);
        g.lineStyle(3, 0xc6ff3d, 0.35);
        g.strokeCircle(h.x, h.y, h.r);
      } else {
        g.fillStyle(0x6fd6ff, 0.035);
        g.fillCircle(h.x, h.y, h.r);
      }
    }
    this.hazardsDrawn = this.net.hazards;
  }

  // ------------------------------------------------------------ events

  handleEvents(events: GameEvent[]) {
    for (const ev of events) {
      switch (ev.e) {
        case 'hit': {
          const color = HIT_COLORS[ev.kind] ?? 0xffffff;
          const n = ev.kind === 'dot' ? 3 : Math.min(18, 4 + ev.amount);
          this.burst(ev.x, ev.y, n, color, ev.kind === 'dot' ? 40 : 160, 3);
          const v = this.views.get(ev.target);
          if (v && ev.kind !== 'dot') v.jiggle = Math.min(1, v.jiggle + 0.4 + ev.amount / 30);
          const mine = ev.target === this.net.myId;
          const byMe = ev.source === this.net.myId && ev.source !== 0;
          if (ev.amount >= 1) this.damageNumber(ev.x, ev.y, ev.amount, mine ? 0xff6b81 : byMe ? 0xfff1a8 : ev.kind === 'dot' ? 0xb6ff5a : 0xd8e8ec, ev.blocked, mine || byMe);
          if (mine && ev.kind !== 'dot') {
            this.sfx.hurt();
            this.cameras.main.shake(120, Math.min(0.012, 0.003 + ev.amount / 3000));
          } else if (byMe) this.sfx.hit(ev.amount > 12);
          break;
        }
        case 'death': {
          const c = hsl(ev.hue, 75, 65);
          this.burst(ev.x, ev.y, 46, c, 260 + ev.r * 2, 6);
          this.burst(ev.x, ev.y, 20, 0xffffff, 120, 3);
          const v = this.views.get(ev.id);
          if (v) this.destroyView(ev.id);
          if (Math.hypot(ev.x - this.focus.x, ev.y - this.focus.y) < 900) this.sfx.death();
          break;
        }
        case 'eat': {
          const img = this.nutrientImgs.get(ev.nutrient);
          const eater = this.views.get(ev.id);
          if (img) {
            this.nutrientImgs.delete(ev.nutrient);
            this.eaten.add(ev.nutrient);
            if (eater) {
              this.tweens.add({ targets: img, x: eater.x, y: eater.y, scale: 0.1, alpha: 0.3, duration: 140, onComplete: () => img.destroy() });
            } else img.destroy();
            if (ev.crystal) this.burst(img.x, img.y, 14, 0x9ffcff, 140, 3);
          }
          if (ev.id === this.net.myId) this.sfx.eat(ev.crystal);
          break;
        }
        case 'level': {
          const v = this.views.get(ev.id);
          if (v) this.ring(v.x, v.y, v.r * 1.5, 0xffe27a);
          if (ev.id === this.net.myId) this.sfx.levelUp();
          break;
        }
        case 'dash': {
          const v = this.views.get(ev.id);
          if (v) {
            this.burst(v.x - Math.cos(v.heading) * v.r, v.y - Math.sin(v.heading) * v.r, 14, 0xc9fbff, 120, 3);
            v.jiggle = Math.min(1, v.jiggle + 0.3);
          }
          if (ev.id === this.net.myId) this.sfx.dash();
          break;
        }
        case 'toxin':
          this.burst(ev.x, ev.y, 30, 0xc6ff3d, 180, 5);
          if (Math.hypot(ev.x - this.focus.x, ev.y - this.focus.y) < 900) this.sfx.toxin();
          break;
      }
    }
  }

  private burst(x: number, y: number, n: number, color: number, speed: number, size: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.3 + Math.random() * 0.7);
      const life = 0.4 + Math.random() * 0.5;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: size * (0.5 + Math.random()), drag: 3 });
    }
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500);
  }

  private ring(x: number, y: number, r: number, color: number) {
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * TAU;
      this.particles.push({ x: x + Math.cos(a) * r * 0.6, y: y + Math.sin(a) * r * 0.6, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160, life: 0.7, max: 0.7, color, size: 4, drag: 2 });
    }
  }

  private damageNumber(x: number, y: number, amount: number, color: number, blocked: boolean, important: boolean) {
    const z = this.cameras.main.zoom;
    const txt = this.add
      .text(x + (Math.random() - 0.5) * 20, y, blocked ? `${amount} ⛨` : String(amount), {
        fontFamily: 'system-ui, sans-serif',
        fontSize: important ? '22px' : '15px',
        fontStyle: '900',
        color: `#${color.toString(16).padStart(6, '0')}`,
        stroke: '#001014',
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(30)
      .setScale(1 / z);
    this.tweens.add({ targets: txt, y: y - 50 / z, alpha: 0, duration: 850, ease: 'Cubic.easeOut', onComplete: () => txt.destroy() });
  }

  // ------------------------------------------------------------ frame

  update(time: number, deltaMs: number) {
    const dt = Math.min(0.05, deltaMs / 1000);
    const t = time / 1000;
    const now = performance.now();
    if (this.hazardsDrawn !== this.net.hazards) {
      this.drawHazards();
      this.drawGrid();
    }

    const cells = this.net.sample(now);
    // Our own cell: extrapolate from the newest snapshot for responsiveness.
    const ownLatest = this.net.latestCells.get(this.net.myId);
    if (ownLatest && this.net.you) {
      const ahead = Math.min(0.12, (now - this.net.latestArrival) / 1000);
      const tx = ownLatest.x + ownLatest.vx * ahead;
      const ty = ownLatest.y + ownLatest.vy * ahead;
      if (!this.ownSmooth || Math.hypot(tx - this.ownSmooth.x, ty - this.ownSmooth.y) > 200) this.ownSmooth = { x: tx, y: ty };
      this.ownSmooth.x = lerp(this.ownSmooth.x, tx, 0.4);
      this.ownSmooth.y = lerp(this.ownSmooth.y, ty, 0.4);
      cells.set(this.net.myId, { ...ownLatest, x: this.ownSmooth.x, y: this.ownSmooth.y });
    } else this.ownSmooth = null;

    this.syncCells(cells, dt, t);
    this.syncNutrients(t);
    this.drawClouds(t);
    this.drawHazardAnim(t);
    this.drawParticles(dt);
    this.updateCamera(Math.min(0.5, deltaMs / 1000));
    this.sendInput(now);
  }

  private syncCells(cells: Map<number, CellSnap>, dt: number, t: number) {
    const zoom = this.cameras.main.zoom;
    for (const [id, s] of cells) {
      let v = this.views.get(id);
      if (!v) {
        const g = this.add.graphics();
        const label = this.add
          .text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: '800', color: '#ffffff', stroke: '#00222a', strokeThickness: 4 })
          .setOrigin(0.5, 0);
        v = { g, painter: new PhaserPainter(g), label, seed: (id * 2.39996) % TAU, jiggle: 0, x: s.x, y: s.y, r: s.radius, heading: s.heading, missing: 0, labelKey: '' };
        this.views.set(id, v);
      }
      v.missing = 0;
      v.x = s.x;
      v.y = s.y;
      v.r = s.radius;
      v.heading = s.heading;
      v.jiggle = Math.max(0, v.jiggle - dt * 1.8);
      const info = this.net.infos.get(id);
      const mine = id === this.net.myId;
      if (mine) {
        this.focus = { x: s.x, y: s.y, r: s.radius };
        this.ownHeading = s.heading;
      }
      const g = v.g;
      g.clear();
      g.setDepth(5 + s.radius / 1000 + (mine ? 0.0001 : 0));
      const screenR = s.radius * zoom;
      const detail = screenR > 60 ? 44 : screenR > 25 ? 32 : 20;
      drawCell(
        v.painter,
        { x: s.x, y: s.y, radius: s.radius, heading: s.heading, hue: info?.hue ?? 180, organelles: info?.organelles ?? [], flags: s.flags, vx: s.vx, vy: s.vy, seed: v.seed, jiggle: v.jiggle },
        t,
        detail,
      );
      // Front indicator for our own cell, so placement is always readable.
      if (mine) {
        const fx = s.x + Math.cos(s.heading) * s.radius * 1.55;
        const fy = s.y + Math.sin(s.heading) * s.radius * 1.55;
        const a = s.heading;
        const k = Math.max(5, s.radius * 0.18);
        g.fillStyle(0xffffff, 0.35);
        g.fillTriangle(fx + Math.cos(a) * k, fy + Math.sin(a) * k, fx + Math.cos(a + 2.4) * k, fy + Math.sin(a + 2.4) * k, fx + Math.cos(a - 2.4) * k, fy + Math.sin(a - 2.4) * k);
      }
      // Health bar
      if (s.hp < 0.995 || mine) {
        const w = Math.max(30, s.radius * 1.6);
        const h = Math.max(4, 6 / zoom);
        const bx = s.x - w / 2;
        const by = s.y - s.radius * 1.3 - h - 4 / zoom;
        g.fillStyle(0x000000, 0.5);
        g.fillRoundedRect(bx - 1, by - 1, w + 2, h + 2, h / 2);
        g.fillStyle(s.flags & CellFlag.Poisoned ? 0x9dff3d : s.hp > 0.35 ? 0xff5d7a : 0xff2244, 0.95);
        g.fillRoundedRect(bx, by, Math.max(0.001, w * clamp(s.hp, 0, 1)), h, h / 2);
      }
      const key = `${info?.name ?? ''}|${info?.level ?? ''}`;
      if (key !== v.labelKey) {
        v.labelKey = key;
        v.label.setText(info ? `${info.name}  ·  ${info.level}` : '');
        v.label.setColor(mine ? '#ffe27a' : info?.ai ? '#bfe9f0' : '#ffffff');
      }
      v.label.setPosition(s.x, s.y + s.radius * 1.25 + 4 / zoom).setScale(Math.max(0.6, Math.min(2.2, 1 / zoom))).setDepth(25);
    }
    for (const [id, v] of this.views) {
      if (cells.has(id)) continue;
      v.missing += dt;
      if (v.missing > 0.4) this.destroyView(id);
    }
  }

  private destroyView(id: number) {
    const v = this.views.get(id);
    if (!v) return;
    v.g.destroy();
    v.label.destroy();
    this.views.delete(id);
  }

  private syncNutrients(t: number) {
    for (const n of this.net.nutrients.values()) {
      if (this.eaten.has(n.id)) continue;
      let img = this.nutrientImgs.get(n.id);
      if (!img) {
        img = this.add.image(n.x, n.y, n.kind === 5 ? 'crystal' : `n${n.kind}`).setDepth(2).setScale(0);
        this.tweens.add({ targets: img, scale: n.kind === 5 ? 0.85 : 0.75, duration: 250 });
        this.nutrientImgs.set(n.id, img);
      }
      const ph = n.id * 0.7;
      img.x = n.x + Math.sin(t * 1.3 + ph) * 2.5;
      img.y = n.y + Math.cos(t * 1.1 + ph) * 2.5;
      if (n.kind === 5) img.rotation = t * 0.8 + ph;
    }
  }

  private drawClouds(t: number) {
    const g = this.cloudG;
    g.clear();
    for (const c of this.net.clouds) {
      const a = Math.min(1, c.life * 2.5);
      g.fillStyle(0x9ed61e, 0.12 * a);
      g.fillCircle(c.x, c.y, c.r);
      for (let k = 0; k < 7; k++) {
        const ang = k * 0.9 + t * (k % 2 ? 0.6 : -0.5) + c.id;
        const d = c.r * (0.35 + 0.25 * Math.sin(t + k));
        g.fillStyle(0xc6ff3d, 0.13 * a);
        g.fillCircle(c.x + Math.cos(ang) * d, c.y + Math.sin(ang) * d, c.r * 0.45);
      }
      g.lineStyle(2, 0xd9ff70, 0.35 * a);
      g.strokeCircle(c.x, c.y, c.r);
    }
  }

  private drawHazardAnim(t: number) {
    const g = this.hazardAnimG;
    g.clear();
    const view = this.cameras.main.worldView;
    for (const [i, h] of this.net.hazards.entries()) {
      if (h.x + h.r < view.x || h.x - h.r > view.right || h.y + h.r < view.y || h.y - h.r > view.bottom) continue;
      if (h.kind === 'acid') {
        for (let k = 0; k < 10; k++) {
          const ph = (t * 0.35 + k / 10 + i * 0.13) % 1;
          const a = k * 2.4 + i;
          const d = h.r * (0.15 + ((k * 37) % 70) / 100);
          g.fillStyle(0xd6ff7a, 0.35 * (1 - ph));
          g.fillCircle(h.x + Math.cos(a) * d, h.y + Math.sin(a) * d - ph * 12, 3 + ph * 7);
        }
      } else {
        const dir = h.dir ?? 0;
        const ux = Math.cos(dir);
        const uy = Math.sin(dir);
        g.lineStyle(2, 0x9fe8ff, 0.18);
        for (let k = 0; k < 22; k++) {
          const lane = (((k * 53) % 100) / 100 - 0.5) * 2 * h.r * 0.85;
          const ph = ((t * (h.strength ?? 80)) / (h.r * 2) + k * 0.137) % 1;
          const along = (ph - 0.5) * 2 * h.r;
          const px = h.x + ux * along - uy * lane;
          const py = h.y + uy * along + ux * lane;
          if (Math.hypot(px - h.x, py - h.y) > h.r) continue;
          g.lineBetween(px, py, px + ux * 26, py + uy * 26);
        }
      }
    }
  }

  private drawParticles(dt: number) {
    const g = this.fxG;
    g.clear();
    const keep: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      const f = p.life / p.max;
      g.fillStyle(p.color, 0.9 * f);
      g.fillCircle(p.x, p.y, p.size * (0.4 + 0.6 * f));
      keep.push(p);
    }
    this.particles = keep;
  }

  private updateCamera(dt: number) {
    const cam = this.cameras.main;
    const target = this.focus;
    const k = 1 - Math.exp(-dt * 10);
    if (Math.hypot(target.x - this.camPos.x, target.y - this.camPos.y) > 800) {
      // Respawn or teleport: cut instead of a long pan.
      this.camPos = { x: target.x, y: target.y };
    }
    this.camPos.x = lerp(this.camPos.x, target.x, k);
    this.camPos.y = lerp(this.camPos.y, target.y, k);
    const z = cameraZoom(target.r, this.scale.width, this.scale.height);
    this.camZoom = lerp(this.camZoom, z, 1 - Math.exp(-dt * 2.5));
    cam.setZoom(this.camZoom);
    cam.centerOn(this.camPos.x, this.camPos.y);
  }

  private sendInput(now: number) {
    if (now - this.lastInputSent < 50 || !this.net.you) return;
    this.lastInputSent = now;
    const p = this.input.activePointer;
    const cam = this.cameras.main;
    if (!this.inputEnabled || (p.wasTouch && !p.isDown)) {
      this.net.sendInput(this.ownHeading, 0);
      return;
    }
    const wp = cam.getWorldPoint(p.x, p.y);
    const dx = wp.x - this.focus.x;
    const dy = wp.y - this.focus.y;
    const distScreen = Math.hypot(dx, dy) * cam.zoom;
    const dead = this.focus.r * cam.zoom * 0.25;
    const throttle = distScreen < dead ? 0 : clamp((distScreen - dead) / (Math.min(this.scale.width, this.scale.height) * 0.22), 0, 1);
    this.net.sendInput(Math.atan2(dy, dx), throttle);
  }
}

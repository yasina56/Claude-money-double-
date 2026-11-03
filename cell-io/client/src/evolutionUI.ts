/**
 * Evolution screen: three (or four) offers, then a cell editor where the
 * player drags the new organelle around their enlarged cell, snaps it to a
 * valid attachment slot, tilts it and sees the stat consequences live.
 */
import { angleDiff, TAU } from '../../shared/math';
import { ORGANELLES, TUNING, type Organelle } from '../../shared/organelles';
import {
  checkPlacement,
  INTERNAL_SLOTS,
  MAX_TILT,
  nearestValidSlot,
  organelleAngle,
  surfaceSlotAngle,
  SURFACE_SLOTS,
  TILT_STEP,
  validSlots,
} from '../../shared/placement';
import { MUTATIONS, offerTitle, type Offer } from '../../shared/progression';
import { computeStats, statSummary, type StatSummary } from '../../shared/stats';
import { CanvasPainter, drawCell, drawOrganelleIcon, rgba } from './art';
import type { Sfx } from './audio';
import type { Net } from './net';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Default mounting angle per organelle type, before the player moves it. */
const DEFAULT_ANGLE: Record<string, number> = {
  spikes: 0,
  stinger: 0,
  membrane: 0,
  cilia: Math.PI,
  flagellum: Math.PI,
};

export class EvolutionUI {
  private root = $('#evolution');
  private cards = $('#evo-cards');
  private choose = $('#evo-choose');
  private place = $('#evo-place');
  private canvas = $<HTMLCanvasElement>('#evo-canvas');
  private ctx = this.canvas.getContext('2d')!;
  private offers: Offer[] = [];
  private selected = -1;
  private slot = 0;
  private tilt = 0;
  private hoverSlot: number | null = null;
  private dragging = false;
  private raf = 0;
  private iconRaf = 0;
  isOpen = false;
  /** Player pressed "Later" for the current pending evolutions. */
  dismissed = false;
  private awaiting = false;

  constructor(
    private net: Net,
    private sfx: Sfx,
  ) {
    $('#evo-close').onclick = () => this.close();
    $('#evo-back').onclick = () => this.showCards();
    $('#evo-confirm').onclick = () => this.confirm();
    $('#evo-rot-l').onclick = () => this.rotate(-1);
    $('#evo-rot-r').onclick = () => this.rotate(1);
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.pick(e, true);
    });
    this.canvas.addEventListener('pointermove', (e) => this.pick(e, this.dragging));
    this.canvas.addEventListener('pointerup', () => {
      if (this.dragging) this.sfx.attach();
      this.dragging = false;
    });
    this.canvas.addEventListener('pointerleave', () => (this.hoverSlot = null));
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.rotate(e.deltaY > 0 ? 1 : -1);
      },
      { passive: false },
    );
    net.onEvolveResult = (r) => {
      this.awaiting = false;
      if (!r.ok) {
        $('#evo-error').textContent = `Rejected by server: ${r.error}`;
        return;
      }
      this.sfx.attach();
      // The server sends a fresh offer if more evolutions are pending.
      this.hide();
    };
  }

  /** Ask the server for offers (it also starts the short protection window). */
  request() {
    if (this.awaiting) return;
    this.awaiting = true;
    this.net.socket.emit('evolveOpen');
    setTimeout(() => (this.awaiting = false), 1500);
  }

  show(offers: Offer[]) {
    this.awaiting = false;
    this.offers = offers;
    this.isOpen = true;
    this.dismissed = false;
    this.root.classList.remove('hidden');
    $('#evo-level').textContent = this.net.you ? `Level ${this.net.you.level} · ${this.net.you.pendingEvolutions} pending` : '';
    this.showCards();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.isOpen) return;
      const you = this.net.you;
      $('#evo-protect').textContent = you && you.protectedFor > 0 ? `\u{1F6E1} Protected ${you.protectedFor.toFixed(1)}s` : 'Not protected!';
      if (!this.place.classList.contains('hidden')) this.drawEditor();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  private hide() {
    this.isOpen = false;
    this.root.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.iconRaf);
  }

  close() {
    if (!this.isOpen) return;
    this.hide();
    this.dismissed = true;
    this.net.socket.emit('evolveClose');
  }

  private myOrganelles(): Organelle[] {
    return this.net.infos.get(this.net.myId)?.organelles.map((o) => ({ ...o })) ?? [];
  }

  private showCards() {
    this.selected = -1;
    this.choose.classList.remove('hidden');
    this.place.classList.add('hidden');
    this.cards.innerHTML = '';
    const icons: { c: HTMLCanvasElement; o: Offer }[] = [];
    this.offers.forEach((o, i) => {
      const card = document.createElement('button');
      card.className = 'card';
      const c = document.createElement('canvas');
      c.width = 192;
      c.height = 192;
      const parts: string[] = [];
      if (o.kind === 'mutation') {
        const m = MUTATIONS[o.mutation];
        parts.push(`<span class="tag">Mutation</span><h3>${m.name}</h3><p>${m.text}</p><p class="meta">Free: uses no organelle capacity.</p>`);
      } else {
        const def = ORGANELLES[o.type];
        const lvl = o.kind === 'upgrade' ? o.toLevel : 1;
        parts.push(
          `<span class="tag">${o.kind === 'upgrade' ? 'Upgrade' : 'New'} · ${def.role}</span>`,
          `<h3>${offerTitle(o)}</h3>`,
          `<p class="meta">${def.mount === 'surface' ? 'Surface' : 'Internal'} · cost ${def.slotCost} · weight ${Math.round(def.weight * 100)}%${def.upkeep ? ` · ${def.upkeep} energy/s` : ''}</p>`,
          `<p>${def.levelText[lvl - 1]}</p>`,
          `<p class="pro">+ ${def.strengths}</p>`,
          `<p class="con">− ${def.weaknesses}</p>`,
        );
        icons.push({ c, o });
      }
      card.innerHTML = parts.join('');
      if (o.kind !== 'mutation') card.prepend(c);
      card.onclick = () => this.select(i);
      this.cards.appendChild(card);
    });
    const hue = this.net.infos.get(this.net.myId)?.hue ?? 190;
    cancelAnimationFrame(this.iconRaf);
    const anim = () => {
      if (!this.isOpen || this.choose.classList.contains('hidden')) return;
      const t = performance.now() / 1000;
      for (const { c, o } of icons) {
        if (o.kind === 'mutation') continue;
        drawOrganelleIcon(c.getContext('2d')!, o.type, o.kind === 'upgrade' ? o.toLevel : 1, 192, t, hue);
      }
      this.iconRaf = requestAnimationFrame(anim);
    };
    anim();
  }

  private select(i: number) {
    const o = this.offers[i];
    this.selected = i;
    this.tilt = 0;
    $('#evo-error').textContent = '';
    this.choose.classList.add('hidden');
    this.place.classList.remove('hidden');
    const tools = $('#evo-tools');
    const hint = $('#evo-hint');
    if (o.kind === 'mutation') {
      $('#evo-name').textContent = MUTATIONS[o.mutation].name;
      $('#evo-desc').textContent = MUTATIONS[o.mutation].text;
      $('#evo-placement').textContent = '';
      tools.classList.add('hidden');
      hint.textContent = '';
    } else {
      const def = ORGANELLES[o.type];
      const lvl = o.kind === 'upgrade' ? o.toLevel : 1;
      $('#evo-name').textContent = offerTitle(o);
      $('#evo-desc').textContent = def.levelText[lvl - 1];
      $('#evo-placement').textContent = def.placement;
      if (o.kind === 'new') {
        const orgs = this.myOrganelles();
        this.slot = nearestValidSlot(orgs, o.type, DEFAULT_ANGLE[o.type] ?? 0, def.mount === 'internal') ?? validSlots(orgs, o.type)[0] ?? 0;
        tools.classList.toggle('hidden', def.mount !== 'surface');
        hint.textContent = 'Drag or click to attach. The arrow marks your cell’s front. Wheel / Q / E tilts surface organelles.';
      } else {
        tools.classList.add('hidden');
        hint.textContent = 'The highlighted organelle will be upgraded in place.';
      }
    }
    this.updateTiltLabel();
    this.renderPreview();
  }

  private rotate(dir: number) {
    const o = this.offers[this.selected];
    if (!o || o.kind !== 'new' || ORGANELLES[o.type].mount !== 'surface') return;
    this.tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, this.tilt + dir * TILT_STEP));
    this.updateTiltLabel();
    this.renderPreview();
  }

  private updateTiltLabel() {
    $('#evo-tilt').textContent = `Tilt ${Math.round((this.tilt * 180) / Math.PI)}°`;
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (e.key === 'Escape') {
      if (!this.place.classList.contains('hidden')) this.showCards();
      else this.close();
    } else if (e.key === 'q' || e.key === 'Q') this.rotate(-1);
    else if (e.key === 'e' || e.key === 'E') this.rotate(1);
    else if (e.key === 'Enter' && this.selected >= 0) this.confirm();
    else if (['1', '2', '3', '4'].includes(e.key) && this.place.classList.contains('hidden')) {
      const i = Number(e.key) - 1;
      if (this.offers[i]) this.select(i);
    } else return false;
    return true;
  }

  // ----------------------------------------------------------- editor

  private geometry() {
    const dpr = window.devicePixelRatio || 1;
    const css = this.canvas.getBoundingClientRect();
    const size = Math.round((css.width || 460) * dpr);
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    return { size, cx: size / 2, cy: size / 2, R: size * 0.3, dpr };
  }

  private pick(e: PointerEvent, commit: boolean) {
    const o = this.offers[this.selected];
    if (!o || o.kind !== 'new') return;
    const { cx, cy, R, dpr } = this.geometry();
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * dpr - cx;
    const y = (e.clientY - rect.top) * dpr - cy;
    const orgs = this.myOrganelles();
    const slots = validSlots(orgs, o.type);
    if (!slots.length) return;
    let best = slots[0];
    let bestD = Infinity;
    const def = ORGANELLES[o.type];
    for (const s of slots) {
      let d: number;
      if (def.mount === 'surface') {
        d = Math.abs(angleDiff(Math.atan2(y, x), surfaceSlotAngle(s)));
      } else {
        const p = INTERNAL_SLOTS[s];
        d = Math.hypot(x - Math.cos(p.a) * p.r * R, y - Math.sin(p.a) * p.r * R);
      }
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    this.hoverSlot = best;
    if (commit && best !== this.slot) {
      this.slot = best;
      this.renderPreview();
    }
  }

  /** The organelle list as it would be after confirming, plus the highlighted index. */
  private candidate(): { orgs: Organelle[]; ghost: number; biomass: number; mut: { vitality: number; metabolism: number } } {
    const orgs = this.myOrganelles();
    const o = this.offers[this.selected];
    const you = this.net.you;
    let biomass = you?.biomass ?? 10;
    const mut = { vitality: 0, metabolism: 0 };
    let ghost = -1;
    if (o?.kind === 'new') {
      orgs.push({ type: o.type, level: 1, slot: this.slot, tilt: ORGANELLES[o.type].mount === 'surface' ? this.tilt : 0 });
      ghost = orgs.length - 1;
    } else if (o?.kind === 'upgrade' && orgs[o.index]) {
      orgs[o.index].level = o.toLevel;
      ghost = o.index;
    } else if (o?.kind === 'mutation') {
      if (o.mutation === 'growth') biomass += 20;
      else mut[o.mutation] = 1;
    }
    return { orgs, ghost, biomass, mut };
  }

  private renderPreview() {
    const you = this.net.you;
    if (!you) return;
    const before = statSummary(computeStats(you.biomass, you.level, this.myOrganelles()));
    const c = this.candidate();
    const after = statSummary(computeStats(c.biomass, you.level, c.orgs, c.mut));
    const rows: [string, keyof StatSummary, (v: number) => string, boolean?][] = [
      ['Speed forward', 'speedFront', (v) => v.toFixed(0)],
      ['Speed sideways', 'speedSide', (v) => v.toFixed(0)],
      ['Turning', 'turnRate', (v) => `${((v * 180) / Math.PI).toFixed(0)}°/s`],
      ['Acceleration', 'accel', (v) => v.toFixed(0)],
      ['Max HP', 'maxHp', (v) => v.toFixed(0)],
      ['Energy regen', 'energyRegen', (v) => `${v.toFixed(1)}/s`],
      ['Max energy', 'energyMax', (v) => v.toFixed(0)],
      ['Armor front', 'armorFront', pct],
      ['Armor sides', 'armorSide', pct],
      ['Armor rear', 'armorRear', pct],
      ['Spike dmg front', 'spikeFront', (v) => v.toFixed(1)],
      ['Spike dmg rear', 'spikeRear', (v) => v.toFixed(1)],
      ['Regeneration', 'regen', (v) => `${v.toFixed(1)} HP/s`],
    ];
    const tbl = $('#evo-preview');
    const html = ['<tr><td></td><td class="muted">now</td><td class="muted">after</td></tr>'];
    for (const [label, key, fmt] of rows) {
      const a = before[key] as number;
      const b = after[key] as number;
      const changed = Math.abs(a - b) > 1e-3;
      if (!changed && !['speedFront', 'turnRate', 'maxHp', 'armorFront'].includes(key)) continue;
      const cls = !changed ? '' : b > a ? 'up' : 'down';
      html.push(`<tr><td>${label}</td><td>${fmt(a)}</td><td class="${cls}">${fmt(b)}</td></tr>`);
    }
    if (before.venomLinked !== after.venomLinked || after.venomLinked) {
      html.push(`<tr><td>Venom delivery</td><td>${before.venomLinked ? 'yes' : 'no'}</td><td class="${after.venomLinked ? 'up' : 'down'}">${after.venomLinked ? 'linked' : 'no link'}</td></tr>`);
    }
    const o = this.offers[this.selected];
    if (o?.kind === 'new' && o.type === 'venom' && !after.venomLinked) {
      html.push('<tr><td colspan="3" class="down">No stinger or spike on this side yet: the sac cannot poison anything until one is linked.</td></tr>');
    }
    tbl.innerHTML = html.join('');
    const err = o?.kind === 'new' ? checkPlacement(this.myOrganelles(), o.type, this.slot, ORGANELLES[o.type].mount === 'surface' ? this.tilt : 0, you.capacity) : null;
    ($('#evo-confirm') as HTMLButtonElement).disabled = !!err;
    $('#evo-error').textContent = err ? `Cannot attach here (${err}).` : '';
  }

  private drawEditor() {
    const { size, cx, cy, R, dpr } = this.geometry();
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    ctx.clearRect(0, 0, size, size);
    const info = this.net.infos.get(this.net.myId);
    const o = this.offers[this.selected];
    const cand = this.candidate();
    const p = new CanvasPainter(ctx);

    // Front arrow
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${Math.round(13 * dpr)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('FRONT', cx + R * 1.48, cy - R * 0.2);
    ctx.beginPath();
    ctx.moveTo(cx + R * 1.62, cy);
    ctx.lineTo(cx + R * 1.42, cy - R * 0.09);
    ctx.lineTo(cx + R * 1.42, cy + R * 0.09);
    ctx.closePath();
    ctx.fill();
    ctx.fillText('REAR', cx - R * 1.5, cy + 4 * dpr);
    ctx.restore();

    // Effect overlays for the candidate organelle (placement consequences made visible)
    if (o && o.kind !== 'mutation' && cand.ghost >= 0) {
      const g = cand.orgs[cand.ghost];
      const dir = organelleAngle(g) + (ORGANELLES[g.type].mount === 'surface' ? g.tilt : 0);
      const wedge = (center: number, half: number, r0: number, r1: number, color: number, alpha: number) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r1, center - half, center + half);
        ctx.arc(cx, cy, r0, center + half, center - half, true);
        ctx.closePath();
        ctx.fillStyle = rgba(color, alpha);
        ctx.fill();
      };
      switch (g.type) {
        case 'spikes':
          wedge(dir, TUNING.spikeArc, R * 1.0, R * 1.75, 0xff6b6b, 0.18);
          break;
        case 'stinger':
          wedge(dir, TUNING.stingerArc[g.level - 1], R, R * 1.75, 0xc04dff, 0.2);
          break;
        case 'membrane':
          wedge(organelleAngle(g), TUNING.membraneHalfArc, R * 1.0, R * 1.6, 0x7fa6d9, 0.2);
          break;
        case 'venom':
          if (g.slot !== 0) wedge(organelleAngle(g), TUNING.venomLinkArc, R * 0.2, R * 1.6, 0xb04dff, 0.12);
          else {
            ctx.fillStyle = rgba(0xb04dff, 0.08);
            ctx.beginPath();
            ctx.arc(cx, cy, R * 1.6, 0, TAU);
            ctx.fill();
          }
          break;
        case 'toxin': {
          const off = g.slot === 0 ? 0 : 1.15;
          const a = organelleAngle(g);
          ctx.fillStyle = rgba(0xc6ff3d, 0.12);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * R * off, cy + Math.sin(a) * R * off, R * (off === 0 ? 1.7 : 1.2), 0, TAU);
          ctx.fill();
          break;
        }
        case 'cilia':
        case 'flagellum': {
          // Arrow showing the push direction (away from the mount).
          const push = dir + Math.PI;
          const len = g.type === 'flagellum' ? R * 0.9 : R * 0.55;
          ctx.strokeStyle = rgba(0xffe066, 0.8);
          ctx.fillStyle = rgba(0xffe066, 0.8);
          ctx.lineWidth = 4 * dpr;
          const x0 = cx + Math.cos(push) * R * 0.2;
          const y0 = cy + Math.sin(push) * R * 0.2;
          const x1 = x0 + Math.cos(push) * len;
          const y1 = y0 + Math.sin(push) * len;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x1 + Math.cos(push) * 14 * dpr, y1 + Math.sin(push) * 14 * dpr);
          ctx.lineTo(x1 + Math.cos(push + 2.5) * 12 * dpr, y1 + Math.sin(push + 2.5) * 12 * dpr);
          ctx.lineTo(x1 + Math.cos(push - 2.5) * 12 * dpr, y1 + Math.sin(push - 2.5) * 12 * dpr);
          ctx.closePath();
          ctx.fill();
          break;
        }
      }
    }

    drawCell(
      p,
      { x: cx, y: cy, radius: R, heading: 0, hue: info?.hue ?? 190, organelles: cand.orgs, flags: 0, vx: 0, vy: 0, seed: 1.3, jiggle: 0, ghostIndex: cand.ghost, ghostValid: true },
      t,
      64,
    );

    // Snap points
    if (o?.kind === 'new') {
      const def = ORGANELLES[o.type];
      const orgs = this.myOrganelles();
      const valid = new Set(validSlots(orgs, o.type));
      const n = def.mount === 'surface' ? SURFACE_SLOTS : INTERNAL_SLOTS.length;
      for (let s = 0; s < n; s++) {
        let x: number, y: number;
        if (def.mount === 'surface') {
          const a = surfaceSlotAngle(s);
          x = cx + Math.cos(a) * R * 1.0;
          y = cy + Math.sin(a) * R * 1.0;
        } else {
          const q = INTERNAL_SLOTS[s];
          x = cx + Math.cos(q.a) * q.r * R * 0.95;
          y = cy + Math.sin(q.a) * q.r * R * 0.95;
        }
        const ok = valid.has(s);
        ctx.beginPath();
        ctx.arc(x, y, (s === this.slot ? 7 : s === this.hoverSlot ? 6 : 4) * dpr, 0, TAU);
        ctx.fillStyle = s === this.slot ? 'rgba(255,226,122,0.95)' : ok ? 'rgba(94,242,214,0.7)' : 'rgba(255,77,109,0.35)';
        ctx.fill();
      }
    }
  }

  private confirm() {
    const o = this.offers[this.selected];
    if (!o || this.awaiting) return;
    this.awaiting = true;
    const tilt = o.kind === 'new' && ORGANELLES[o.type].mount === 'surface' ? this.tilt : 0;
    this.net.socket.emit('evolveChoose', { index: this.selected, slot: o.kind === 'new' ? this.slot : undefined, tilt });
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

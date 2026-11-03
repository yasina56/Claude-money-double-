/** DOM heads-up display: bars, organelles, abilities, leaderboard, kill feed, minimap. */
import { ORGANELLES } from '../../shared/organelles';
import type { Net } from './net';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export class Hud {
  private root = $('#hud');
  private hp = $('#hud .bar.hp');
  private en = $('#hud .bar.en');
  private xp = $('#hud .bar.xp');
  private level = $('#hud-level');
  private biomass = $('#hud-biomass');
  private kills = $('#hud-kills');
  private capacity = $('#hud-capacity');
  private organelles = $('#hud-organelles');
  private protect = $('#hud-protect');
  private lb = $('#leaderboard ol');
  private feed = $('#killfeed');
  private toastEl = $('#toast');
  private dashBtn = $('#ab-dash');
  private toxinBtn = $('#ab-toxin');
  private evoBtn = $('#ab-evolve');
  private minimap = $<HTMLCanvasElement>('#minimap');
  private lastLb = 0;
  private lastOrgKey = '';
  private toastTimer = 0;

  constructor(private net: Net) {}

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  update(now: number) {
    const you = this.net.you;
    if (!you) return;
    setBar(this.hp, you.hp / you.maxHp, `${Math.min(you.maxHp, Math.ceil(you.hp))} / ${you.maxHp}`);
    setBar(this.en, you.energy / you.energyMax, `${Math.floor(you.energy)} / ${you.energyMax} energy`);
    setBar(this.xp, you.xp / you.xpNext, `${you.xp} / ${you.xpNext} XP`);
    this.level.textContent = `Lv ${you.level}${you.apex ? ' ★' : ''}`;
    this.biomass.textContent = `Biomass ${Math.round(you.biomass)}`;
    this.kills.textContent = `${you.kills} kill${you.kills === 1 ? '' : 's'}`;
    this.capacity.textContent = `Organelle capacity ${you.capacityUsed} / ${you.capacity}`;
    this.protect.classList.toggle('hidden', you.protectedFor <= 0);
    this.protect.textContent = `\u{1F6E1} Protected ${you.protectedFor.toFixed(1)}s`;

    const info = this.net.infos.get(this.net.myId);
    const key = info ? info.organelles.map((o) => o.type + o.level).join(',') : '';
    if (key !== this.lastOrgKey) {
      this.lastOrgKey = key;
      this.organelles.innerHTML = '';
      for (const o of info?.organelles ?? []) {
        const def = ORGANELLES[o.type];
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.borderColor = `#${def.color.toString(16).padStart(6, '0')}88`;
        chip.textContent = `${def.name} ${'I'.repeat(o.level)}`;
        this.organelles.appendChild(chip);
      }
    }

    setCooldown(this.dashBtn, you.dashCd / you.dashMaxCd, you.energy >= 28);
    this.toxinBtn.classList.toggle('disabled', !you.hasToxin);
    if (you.hasToxin) setCooldown(this.toxinBtn, you.toxinCd / 9, you.energy >= 35);
    const badge = this.evoBtn.querySelector('.badge') as HTMLElement;
    badge.classList.toggle('hidden', you.pendingEvolutions <= 0);
    badge.textContent = String(you.pendingEvolutions);
    this.evoBtn.classList.toggle('pending', you.pendingEvolutions > 0);
    this.evoBtn.classList.toggle('disabled', you.pendingEvolutions <= 0);

    if (now - this.lastLb > 500) {
      this.lastLb = now;
      this.renderLeaderboard();
      this.renderMinimap();
    }
    if (this.toastTimer && now > this.toastTimer) {
      this.toastEl.classList.remove('show');
      this.toastTimer = 0;
    }
  }

  private renderLeaderboard() {
    this.lb.innerHTML = '';
    for (const e of this.net.leaderboard) {
      const li = document.createElement('li');
      if (e.id === this.net.myId) li.className = 'me';
      li.textContent = `${e.name} (${e.level})`;
      const b = document.createElement('span');
      b.className = 'b';
      b.textContent = String(e.biomass);
      li.appendChild(b);
      this.lb.appendChild(li);
    }
  }

  private renderMinimap() {
    const c = this.minimap;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const s = c.width / this.net.worldSize;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const h of this.net.hazards) {
      ctx.fillStyle = h.kind === 'acid' ? 'rgba(157,255,61,0.35)' : 'rgba(111,214,255,0.12)';
      ctx.beginPath();
      ctx.arc(h.x * s, h.y * s, Math.max(2, h.r * s), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const cell of this.net.latestCells.values()) {
      const me = cell.id === this.net.myId;
      ctx.fillStyle = me ? '#ffe27a' : 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(cell.x * s, cell.y * s, me ? 3.5 : Math.max(1.2, cell.radius * s * 1.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  killfeed(killer: string, victim: string) {
    const d = document.createElement('div');
    d.textContent = `${killer} ☠ ${victim}`;
    this.feed.prepend(d);
    while (this.feed.children.length > 5) this.feed.lastChild?.remove();
    setTimeout(() => d.remove(), 5000);
  }

  toast(msg: string, ms = 1800) {
    this.toastEl.innerHTML = msg;
    this.toastEl.classList.add('show');
    this.toastTimer = performance.now() + ms;
  }
}

function setBar(el: HTMLElement, frac: number, label: string) {
  (el.querySelector('.fill') as HTMLElement).style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  (el.querySelector('.label') as HTMLElement).textContent = label;
}

function setCooldown(btn: HTMLElement, frac: number, affordable: boolean) {
  (btn.querySelector('.cd') as HTMLElement).style.height = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  btn.classList.toggle('ready', frac <= 0 && affordable);
  btn.classList.toggle('disabled', !affordable && frac <= 0);
}

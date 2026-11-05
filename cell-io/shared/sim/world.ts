/**
 * Authoritative simulation for one arena: movement, nutrients, growth, XP,
 * evolution, collisions, directional combat, damage over time, hazards and
 * deaths. Contains no networking; Room drives it and serializes its state.
 */
import {
  BIOMASS_DECAY_RATE,
  BIOMASS_DECAY_START,
  COMBAT_TIMEOUT,
  CRYSTAL_RADIUS,
  CRYSTAL_TARGET,
  CRYSTAL_XP,
  DASH_COOLDOWN,
  DASH_COST,
  EVOLVE_COMBAT_LOCK,
  EVOLVE_PROTECTION,
  KILL_CREDIT_WINDOW,
  MAX_BIOMASS,
  MAX_HIT_FRACTION,
  NUTRIENT_RADIUS,
  NUTRIENT_TARGET,
  PAIR_HIT_COOLDOWN,
  SPAWN_PROTECTION,
  TUTORIAL_XP_MULT,
  WORLD_SIZE,
} from '../constants';
import { angleDiff, clamp, mulberry32, TAU } from '../math';
import { ORGANELLES, TUNING } from '../organelles';
import { capacityForLevel, checkPlacement, MAX_TILT, TILT_STEP } from '../placement';
import { APEX_LEVEL, generateOffers, maxOrganelleLevel, MAX_LEVEL, xpToNext } from '../progression';
import type { DeathStats, EvolveChoice, GameEvent, Hazard } from '../protocol';
import { armorMultiplier, deliveryAt } from '../stats';
import { crackStages, createCell, refreshStats, type Cell } from './cell';
import { coversAngle, INTEGRITY_HEAL, REGROW_TIME, SOAK } from '../integrity';
import { dashImpulse, integrateMovement } from './movement';
import { SpatialGrid } from './spatial';

export interface Nutrient {
  id: number;
  x: number;
  y: number;
  kind: number; // 0-4 normal colors, 5 = crystal
  value: number; // biomass
  xp: number;
}

export interface Cloud {
  id: number;
  owner: number;
  x: number;
  y: number;
  r: number;
  dps: number;
  life: number;
  maxLife: number;
}

export interface WorldOptions {
  seed?: number;
  nutrientTarget?: number;
  crystalTarget?: number;
  hazards?: boolean;
}

export class World {
  readonly size = WORLD_SIZE;
  time = 0; // seconds
  cells = new Map<number, Cell>();
  nutrients = new Map<number, Nutrient>();
  nutrientGrid = new SpatialGrid<Nutrient>(WORLD_SIZE, 120);
  /** Rebuilt every tick: cells by position, for collisions, clouds and AI perception. */
  cellGrid = new SpatialGrid<Cell>(WORLD_SIZE, 240);
  private maxRadius = 0;
  clouds: Cloud[] = [];
  hazards: Hazard[] = [];
  events: GameEvent[] = [];
  /** 0..1, set by the Room from the strongest human present; scales bot behaviour. */
  aiDifficulty = 0.2;
  /** Called when a cell dies (Room uses it to notify players / respawn AI). */
  onDeath: (cell: Cell, stats: DeathStats) => void = () => {};

  private nextId = 1;
  private crystalCount = 0;
  private blooms: { x: number; y: number }[] = [];
  readonly rand: () => number;
  private nutrientTarget: number;
  private crystalTarget: number;

  constructor(opts: WorldOptions = {}) {
    this.rand = mulberry32(opts.seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.nutrientTarget = opts.nutrientTarget ?? NUTRIENT_TARGET;
    this.crystalTarget = opts.crystalTarget ?? CRYSTAL_TARGET;
    if (opts.hazards !== false) this.createHazards();
    for (let i = 0; i < 36; i++) this.blooms.push({ x: this.rand() * this.size, y: this.rand() * this.size });
    for (let i = 0; i < this.nutrientTarget; i++) this.spawnNutrient(false);
    for (let i = 0; i < this.crystalTarget; i++) this.spawnNutrient(true);
  }

  id() {
    return this.nextId++;
  }

  // ---------------------------------------------------------------- setup

  private createHazards() {
    const r = this.rand;
    for (let i = 0; i < 7; i++) {
      this.hazards.push({ kind: 'acid', x: 400 + r() * (this.size - 800), y: 400 + r() * (this.size - 800), r: 110 + r() * 110 });
    }
    for (let i = 0; i < 5; i++) {
      this.hazards.push({
        kind: 'current',
        x: 400 + r() * (this.size - 800),
        y: 400 + r() * (this.size - 800),
        r: 260 + r() * 200,
        dir: r() * TAU,
        strength: 70 + r() * 50,
      });
    }
  }

  spawnNutrient(crystal: boolean, at?: { x: number; y: number }, spread = 0) {
    const r = this.rand;
    let x: number, y: number;
    if (at) {
      const a = r() * TAU;
      const d = Math.sqrt(r()) * spread;
      x = at.x + Math.cos(a) * d;
      y = at.y + Math.sin(a) * d;
    } else if (crystal) {
      // Rare resources favour dangerous places: the rims of acid pools.
      const acids = this.hazards.filter((h) => h.kind === 'acid');
      if (acids.length && r() < 0.65) {
        const h = acids[Math.floor(r() * acids.length)];
        const a = r() * TAU;
        const d = h.r * (0.5 + r() * 0.8);
        x = h.x + Math.cos(a) * d;
        y = h.y + Math.sin(a) * d;
      } else {
        x = r() * this.size;
        y = r() * this.size;
      }
    } else if (r() < 0.45) {
      const b = this.blooms[Math.floor(r() * this.blooms.length)];
      const a = r() * TAU;
      const d = Math.sqrt(r()) * 220;
      x = b.x + Math.cos(a) * d;
      y = b.y + Math.sin(a) * d;
    } else {
      x = r() * this.size;
      y = r() * this.size;
    }
    x = clamp(x, 20, this.size - 20);
    y = clamp(y, 20, this.size - 20);
    const n: Nutrient = crystal
      ? { id: this.id(), x, y, kind: 5, value: 2, xp: CRYSTAL_XP }
      : { id: this.id(), x, y, kind: Math.floor(r() * 5), value: 1, xp: 1 };
    if (crystal) this.crystalCount++;
    this.nutrients.set(n.id, n);
    this.nutrientGrid.insert(n);
    return n;
  }

  private removeNutrient(n: Nutrient) {
    this.nutrients.delete(n.id);
    this.nutrientGrid.remove(n);
    if (n.kind === 5) this.crystalCount--;
  }

  /** Spawn point far from larger cells, so nobody respawns in a predator's mouth. */
  findSpawnPoint(radius: number): { x: number; y: number } {
    let best = { x: this.size / 2, y: this.size / 2 };
    let bestScore = -Infinity;
    for (let i = 0; i < 24; i++) {
      const p = { x: 150 + this.rand() * (this.size - 300), y: 150 + this.rand() * (this.size - 300) };
      let score = 1e6;
      for (const c of this.cells.values()) {
        if (c.stats.radius < radius * 1.05 && c.stats.deliveries.length === 0) continue;
        const d = Math.hypot(c.x - p.x, c.y - p.y) - c.stats.radius;
        score = Math.min(score, d);
      }
      for (const h of this.hazards) if (h.kind === 'acid' && Math.hypot(h.x - p.x, h.y - p.y) < h.r + 80) score -= 2000;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  addCell(kind: Cell['kind'], name: string, biomass?: number): Cell {
    const p = this.findSpawnPoint(30);
    const c = createCell(this.id(), kind, name, p.x, p.y, this.time, biomass);
    c.spawnProtect = kind === 'player' ? SPAWN_PROTECTION : 0;
    this.cells.set(c.id, c);
    return c;
  }

  removeCell(id: number) {
    this.cells.delete(id);
    for (const c of this.cells.values()) c.pairCooldown.delete(id);
  }

  // ------------------------------------------------------------- abilities

  dash(c: Cell) {
    if (!c.alive || c.dashCd > 0 || c.energy < DASH_COST) return false;
    const apex = c.level >= APEX_LEVEL;
    const imp = dashImpulse(c, c.stats, c.input, c.level);
    c.vx += imp.x;
    c.vy += imp.y;
    c.energy -= DASH_COST;
    c.dashCd = DASH_COOLDOWN * (apex ? 0.7 : 1);
    c.dashTime = 0.45;
    this.events.push({ e: 'dash', id: c.id });
    return true;
  }

  toxin(c: Cell) {
    if (!c.alive || !c.stats.toxins.length || c.toxinCd > 0 || c.energy < TUNING.toxinCost) return false;
    if (c.evolveProtect > 0 || c.spawnProtect > 0) return false;
    c.energy -= TUNING.toxinCost;
    c.toxinCd = TUNING.toxinCooldown;
    for (const t of c.stats.toxins) {
      const a = c.heading + t.dir;
      const x = c.x + Math.cos(a) * c.stats.radius * t.offset;
      const y = c.y + Math.sin(a) * c.stats.radius * t.offset;
      const r = t.radius + c.stats.radius * (t.offset === 0 ? TUNING.toxinCenterReach : 0.5);
      this.clouds.push({ id: this.id(), owner: c.id, x, y, r, dps: t.dps, life: TUNING.toxinDuration, maxLife: TUNING.toxinDuration });
      this.events.push({ e: 'toxin', id: c.id, x, y });
    }
    return true;
  }

  /** Venom surge: for a few seconds every linked hit injects double poison. */
  venom(c: Cell) {
    if (!c.alive || c.venomCd > 0 || c.energy < TUNING.venomSurgeCost) return false;
    if (!c.stats.deliveries.some((d) => d.venom)) return false;
    c.energy -= TUNING.venomSurgeCost;
    c.venomCd = TUNING.venomSurgeCooldown;
    c.venomSurge = TUNING.venomSurgeDuration;
    this.events.push({ e: 'venom', id: c.id });
    return true;
  }

  // ------------------------------------------------------- organelle damage

  /** Damage one organelle's integrity; breaking it disables it until it regrows. */
  damageOrganelle(c: Cell, index: number, amount: number) {
    const h = c.orgHealth[index];
    if (!h || h.max <= 0 || h.regrow > 0 || amount <= 0) return;
    if (c.spawnProtect > 0) return;
    if (c.evolveProtect > 0) amount *= 0.3;
    h.hp -= amount;
    if (h.hp <= 0) {
      h.hp = 0;
      h.regrow = REGROW_TIME;
      const o = c.organelles[index];
      refreshStats(c);
      this.events.push({ e: 'break', id: c.id, x: c.x, y: c.y, type: o.type });
    }
    this.publishCracks(c);
  }

  /** Bump infoVersion when visible crack stages change, so clients redraw cracks. */
  publishCracks(c: Cell) {
    const key = crackStages(c).join('');
    if (key !== c.crackKey) {
      c.crackKey = key;
      c.infoVersion++;
    }
  }

  // ------------------------------------------------------------- evolution

  /** Seconds until the cell has been out of combat long enough to evolve. */
  combatLock(c: Cell) {
    return Math.max(0, EVOLVE_COMBAT_LOCK - (this.time - c.lastCombatAt));
  }

  openEvolution(c: Cell) {
    if (!c.alive || c.pendingEvolutions <= 0) return null;
    // No level-up stalling mid-fight: the menu is queued until you disengage.
    if (this.combatLock(c) > 0) return null;
    if (!c.offers) c.offers = generateOffers({ level: c.level, organelles: c.organelles }, this.rand);
    c.evolving = true;
    if (!c.evolveProtectGranted) {
      c.evolveProtectGranted = true;
      c.evolveProtect = EVOLVE_PROTECTION;
    }
    return c.offers;
  }

  closeEvolution(c: Cell) {
    c.evolving = false;
    c.evolveProtect = 0;
  }

  /** Validates and applies an evolution choice. Returns an error string on rejection. */
  chooseEvolution(c: Cell, choice: EvolveChoice): string | null {
    if (!c.alive || c.pendingEvolutions <= 0 || !c.offers) return 'no evolution pending';
    const offer = c.offers[choice.index];
    if (!offer) return 'invalid offer';
    if (offer.kind === 'new') {
      const slot = Number(choice.slot);
      let tilt = Number(choice.tilt ?? 0);
      if (ORGANELLES[offer.type].mount === 'surface') {
        tilt = clamp(Math.round(tilt / TILT_STEP) * TILT_STEP, -MAX_TILT, MAX_TILT);
      } else tilt = 0;
      const err = checkPlacement(c.organelles, offer.type, slot, tilt, capacityForLevel(c.level));
      if (err) return `invalid placement: ${err}`;
      c.organelles.push({ type: offer.type, level: 1, slot, tilt });
    } else if (offer.kind === 'upgrade') {
      const o = c.organelles[offer.index];
      if (!o || o.type !== offer.type || o.level >= maxOrganelleLevel(c.level)) return 'invalid upgrade';
      o.level = Math.min(3, o.level + 1);
    } else if (offer.mutation === 'growth') {
      this.addBiomass(c, 20);
    } else {
      c.mutations[offer.mutation]++;
    }
    c.pendingEvolutions--;
    c.offers = null;
    c.evolveProtectGranted = false;
    c.infoVersion++;
    refreshStats(c);
    if (c.pendingEvolutions > 0) {
      this.openEvolution(c);
    } else {
      c.evolving = false;
      c.evolveProtect = 0;
    }
    return null;
  }

  // ------------------------------------------------------------ progression

  addXp(c: Cell, xp: number) {
    c.xp += xp;
    while (c.level < MAX_LEVEL && c.xp >= xpToNext(c.level)) {
      c.xp -= xpToNext(c.level);
      c.level++;
      c.pendingEvolutions++;
      c.infoVersion++;
      this.events.push({ e: 'level', id: c.id, level: c.level });
      if (c.level === APEX_LEVEL) refreshStats(c);
    }
  }

  addBiomass(c: Cell, amount: number) {
    const before = c.biomass;
    c.biomass = Math.min(MAX_BIOMASS, c.biomass + amount);
    c.biomassCollected += c.biomass - before;
    c.peakBiomass = Math.max(c.peakBiomass, c.biomass);
    refreshStats(c);
  }

  // ------------------------------------------------------------------ step

  step(dt: number) {
    this.time += dt;
    for (const c of this.cells.values()) if (c.alive) this.updateCell(c, dt);
    this.rebuildCellGrid();
    this.collectNutrients();
    this.resolveCollisions();
    this.updateClouds(dt);
    for (const c of [...this.cells.values()]) if (c.alive && c.hp <= 0) this.kill(c);
    this.replenish();
  }

  private updateCell(c: Cell, dt: number) {
    const s = c.stats;
    // --- timers
    c.dashCd = Math.max(0, c.dashCd - dt);
    c.dashTime = Math.max(0, c.dashTime - dt);
    c.toxinCd = Math.max(0, c.toxinCd - dt);
    c.venomCd = Math.max(0, c.venomCd - dt);
    c.venomSurge = Math.max(0, c.venomSurge - dt);
    // Steering while protected in the editor ends the protection (no roaming invulnerable).
    if (c.evolving && c.evolveProtect > 0 && c.input.t > 0.15) c.evolveProtect = 0;
    c.spawnProtect = Math.max(0, c.spawnProtect - dt);
    c.evolveProtect = Math.max(0, c.evolveProtect - dt);
    c.energy = Math.min(s.energyMax, c.energy + s.energyRegen * dt);

    // --- movement (shared with the client predictor) + acid pools
    integrateMovement(c, s, c.input, { slow: movementSlow(c), evolving: c.evolving }, this.hazards, dt);
    for (const h of this.hazards) {
      if (h.kind === 'acid' && Math.hypot(c.x - h.x, c.y - h.y) < h.r) {
        this.damage(c, (5 + c.stats.maxHp * 0.012) * dt, null, 'acid', c.x, c.y, false);
      }
    }

    // --- damage over time (capped stacks; refreshes rather than stacking forever)
    if (c.poison.time > 0) {
      c.poison.time -= dt;
      this.damage(c, c.poison.dps * c.poison.stacks * dt, c.poison.source, 'dot', c.x, c.y, false);
      if (c.poison.time <= 0) c.poison.stacks = 0;
    }
    if (c.bleed.time > 0) {
      c.bleed.time -= dt;
      this.damage(c, c.bleed.dps * dt, c.bleed.source, 'dot', c.x, c.y, false);
    }
    c.dotTimer += dt;
    if (c.dotTimer >= 0.6) {
      if (c.dotAccum >= 0.5) {
        this.events.push({ e: 'hit', x: c.x, y: c.y, target: c.id, source: 0, amount: Math.round(c.dotAccum), kind: 'dot', blocked: false });
      }
      c.dotAccum = 0;
      c.dotTimer = 0;
    }

    // --- healing
    const outOfCombat = this.time - c.lastCombatAt > COMBAT_TIMEOUT;
    this.updateIntegrity(c, dt, outOfCombat);
    c.regenActive = false;
    if (c.hp < s.maxHp) {
      if (outOfCombat) c.hp += s.maxHp * 0.002 * dt; // everyone recovers a little
      if (s.regenFrac > 0) {
        const cost = TUNING.regenEnergyPerSec * dt;
        if (c.energy >= cost) {
          c.energy -= cost;
          c.hp += s.regenFrac * s.maxHp * (outOfCombat ? 3 : 1) * dt;
          c.regenActive = true;
        }
      }
      c.hp = Math.min(c.hp, s.maxHp);
    }

    // --- large cells slowly lose biomass so the leaderboard keeps moving
    if (c.biomass > BIOMASS_DECAY_START) {
      c.biomass -= (c.biomass - BIOMASS_DECAY_START) * BIOMASS_DECAY_RATE * dt;
      if (Math.floor(this.time * 2) !== Math.floor((this.time - dt) * 2)) refreshStats(c);
    }
  }

  private updateIntegrity(c: Cell, dt: number, outOfCombat: boolean) {
    let changed = false;
    for (let i = 0; i < c.orgHealth.length; i++) {
      const h = c.orgHealth[i];
      if (h.max <= 0) continue;
      if (h.regrow > 0) {
        h.regrow -= dt;
        if (h.regrow <= 0) {
          h.regrow = 0;
          h.hp = h.max;
          refreshStats(c);
          this.events.push({ e: 'regrow', id: c.id, type: c.organelles[i].type });
          changed = true;
        }
      } else if (outOfCombat && h.hp < h.max) {
        h.hp = Math.min(h.max, h.hp + h.max * INTEGRITY_HEAL * dt);
        changed = true;
      }
    }
    if (changed) this.publishCracks(c);
  }

  private collectNutrients() {
    for (const c of this.cells.values()) {
      if (!c.alive) continue;
      const r = c.stats.radius;
      let gained = 0;
      let xp = 0;
      const eaten: Nutrient[] = [];
      this.nutrientGrid.query(c.x - r - 10, c.y - r - 10, c.x + r + 10, c.y + r + 10, (n) => {
        const nr = n.kind === 5 ? CRYSTAL_RADIUS : NUTRIENT_RADIUS;
        const dx = n.x - c.x;
        const dy = n.y - c.y;
        if (dx * dx + dy * dy < (r + nr * 0.4) * (r + nr * 0.4)) eaten.push(n);
      });
      for (const n of eaten) {
        this.removeNutrient(n);
        gained += n.value;
        xp += n.xp;
        this.events.push({ e: 'eat', id: c.id, nutrient: n.id, crystal: n.kind === 5 });
      }
      if (gained > 0) {
        this.addBiomass(c, gained);
        this.addXp(c, c.tutorial && c.level < 2 ? xp * TUTORIAL_XP_MULT : xp);
      }
    }
  }

  rebuildCellGrid() {
    this.cellGrid.clear();
    this.maxRadius = 0;
    for (const c of this.cells.values()) {
      if (!c.alive) continue;
      this.cellGrid.insert(c);
      if (c.stats.radius > this.maxRadius) this.maxRadius = c.stats.radius;
    }
  }

  /**
   * Visit every live cell whose body may lie within `range` of (x, y).
   * Uses the per-tick grid; callers still do their own exact distance test.
   */
  cellsNear(x: number, y: number, range: number, fn: (c: Cell) => void) {
    const r = range + this.maxRadius;
    this.cellGrid.query(x - r, y - r, x + r, y + r, (c) => {
      if (c.alive) fn(c);
    });
  }

  private resolveCollisions() {
    const near: Cell[] = [];
    for (const A of this.cells.values()) {
      if (!A.alive) continue;
      near.length = 0;
      this.cellsNear(A.x, A.y, A.stats.radius, (B) => {
        // Each pair once, lower id first (ids increase with creation order).
        if (B.id > A.id) near.push(B);
      });
      near.sort((p, q) => p.id - q.id);
      for (const B of near) {
        const rs = A.stats.radius + B.stats.radius;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rs * rs) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d;
        const ny = dy / d;
        const overlap = rs - d;
        const mA = A.stats.mass;
        const mB = B.stats.mass;
        const mt = mA + mB;
        A.x -= nx * overlap * (mB / mt) * 0.85;
        A.y -= ny * overlap * (mB / mt) * 0.85;
        B.x += nx * overlap * (mA / mt) * 0.85;
        B.y += ny * overlap * (mA / mt) * 0.85;

        const closing = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny;
        if (closing > 0) {
          const imp = (1.4 * closing) / (1 / mA + 1 / mB);
          A.vx -= (imp / mA) * nx;
          A.vy -= (imp / mA) * ny;
          B.vx += (imp / mB) * nx;
          B.vy += (imp / mB) * ny;
        }
        if (closing > 15) {
          const ready = (A.pairCooldown.get(B.id) ?? -1) <= this.time;
          if (ready) {
            const hitA = this.resolveHit(A, B, nx, ny, closing);
            const hitB = this.resolveHit(B, A, -nx, -ny, closing);
            if (hitA || hitB) {
              A.pairCooldown.set(B.id, this.time + PAIR_HIT_COOLDOWN);
            }
          }
        }
      }
    }
  }

  /**
   * Attacker `att` strikes `def` along contact normal (nx, ny) pointing from att to def.
   * Damage depends on which of att's organelles faces the contact point, which of
   * def's armor covers it, relative impact speed and size.
   */
  resolveHit(att: Cell, def: Cell, nx: number, ny: number, closing: number): boolean {
    if (att.spawnProtect > 0 || att.evolveProtect > 0 || def.spawnProtect > 0) return false;
    const contactAtt = angleDiff(att.heading, Math.atan2(ny, nx));
    const contactDef = angleDiff(def.heading, Math.atan2(-ny, -nx));
    const armor = armorMultiplier(def.stats, contactDef);
    const blocked = armor < 0.7;
    const cx = att.x + nx * att.stats.radius;
    const cy = att.y + ny * att.stats.radius;
    let hit = false;

    const del = deliveryAt(att.stats, contactAtt);
    let raw = 0;
    if (del && (del.kind === 'stinger' || closing > 40)) {
      const impact = clamp(0.35 + closing / 220, 0.35, 2);
      raw = del.damage * att.stats.sizeFactor * impact;
      const dmg = raw * armor;
      this.damage(def, dmg, att, del.kind === 'spikes' ? 'spike' : 'sting', cx, cy, blocked);
      if (del.bleed) def.bleed = { time: 3, dps: 3 * att.stats.sizeFactor * armor, source: att.id };
      const surge = att.venomSurge > 0;
      if (del.venom && (surge || att.energy >= TUNING.venomCost)) {
        if (!surge) att.energy -= TUNING.venomCost;
        const active = def.poison.time > 0;
        const add = surge ? 2 : 1; // surge injects double poison (two stacks per hit)
        def.poison.stacks = Math.min(TUNING.venomMaxStacks, (active ? def.poison.stacks : 0) + add);
        def.poison.dps = Math.max(active ? def.poison.dps : 0, del.venom.dps);
        def.poison.slow = Math.max(active ? def.poison.slow : 0, del.venom.slow);
        def.poison.time = TUNING.venomDuration;
        def.poison.source = att.id;
      }
      // Weapons chip when they strike armor.
      if (armor < 1) this.damageOrganelle(att, del.index, raw * (1 - armor) * SOAK.chipOnArmor);
      hit = true;
    }

    // Blunt "bump" damage: heavier cells crush lighter ones, but only at speed.
    if (closing > 90) {
      const ratio = clamp(Math.sqrt(att.stats.mass / def.stats.mass), 0.25, 3);
      const bump = (closing - 90) * TUNING.bumpFactor * ratio * armor;
      if (bump >= 0.5) {
        this.damage(def, bump, att, 'bump', cx, cy, blocked);
        raw += bump / Math.max(0.05, armor);
        hit = true;
      }
    }
    // The defender's organelles at the contact point take part of the blow:
    // armor soaks it, exposed weapons on that side clash and crack.
    if (raw > 0 && def.spawnProtect <= 0) {
      for (let i = 0; i < def.organelles.length; i++) {
        const o = def.organelles[i];
        if (!coversAngle(o, contactDef)) continue;
        this.damageOrganelle(def, i, raw * (o.type === 'membrane' ? SOAK.membrane : SOAK.weapon));
      }
    }
    return hit;
  }

  damage(target: Cell, amount: number, source: Cell | number | null, kind: Extract<GameEvent, { e: 'hit' }>['kind'], x: number, y: number, blocked: boolean) {
    if (!target.alive || amount <= 0 || target.spawnProtect > 0) return;
    if (target.evolveProtect > 0) amount *= 0.3;
    if (kind !== 'dot' && kind !== 'acid' && kind !== 'toxin') amount = Math.min(amount, target.stats.maxHp * MAX_HIT_FRACTION);
    target.hp -= amount;
    target.lastCombatAt = this.time;
    const sourceId = typeof source === 'number' ? source : source?.id ?? null;
    target.lastHitKind = kind;
    if (sourceId) {
      target.lastHitBy = sourceId;
      target.lastHitAt = this.time;
      const src = this.cells.get(sourceId);
      if (src) src.lastCombatAt = this.time;
    }
    if (kind === 'dot' || kind === 'acid' || kind === 'toxin') target.dotAccum += amount;
    else this.events.push({ e: 'hit', x, y, target: target.id, source: sourceId ?? 0, amount: Math.round(amount), kind, blocked });
  }

  private updateClouds(dt: number) {
    for (const c of this.cells.values()) c.cloudSlow = 0;
    // Overlapping clouds from the same owner do not stack: each victim takes
    // the strongest one per owner (like the poison stack cap).
    const worst = new Map<string, { c: Cell; owner: number; dps: number }>();
    for (const cl of this.clouds) {
      cl.life -= dt;
      this.cellsNear(cl.x, cl.y, cl.r, (c) => {
        if (c.id === cl.owner) return;
        const d = Math.hypot(c.x - cl.x, c.y - cl.y);
        if (d >= cl.r + c.stats.radius * 0.6) return;
        const key = `${c.id}:${cl.owner}`;
        const cur = worst.get(key);
        if (!cur || cl.dps > cur.dps) worst.set(key, { c, owner: cl.owner, dps: cl.dps });
        c.cloudSlow = TUNING.toxinSlow;
      });
    }
    for (const { c, owner, dps } of worst.values()) this.damage(c, dps * dt, owner, 'toxin', c.x, c.y, false);
    this.clouds = this.clouds.filter((c) => c.life > 0);
  }

  kill(victim: Cell) {
    victim.alive = false;
    const killer =
      victim.lastHitBy && this.time - victim.lastHitAt < KILL_CREDIT_WINDOW ? this.cells.get(victim.lastHitBy) : undefined;
    if (killer && killer.alive && killer !== victim) {
      killer.kills++;
      this.addBiomass(killer, victim.biomass * 0.35);
      this.addXp(killer, Math.round(12 + victim.level * 10 + victim.biomass * 0.08));
      this.events.push({ e: 'kill', killer: killer.name, victim: victim.name, how: victim.lastHitKind });
    }
    // Burst into collectible nutrients.
    const count = clamp(Math.round((victim.biomass * 0.45) / 2), 4, 70);
    for (let i = 0; i < count; i++) {
      const n = this.spawnNutrient(false, victim, victim.stats.radius * 1.6);
      n.value = 2;
    }
    if (victim.level >= 4) this.spawnNutrient(true, victim, victim.stats.radius);
    this.events.push({ e: 'death', id: victim.id, x: victim.x, y: victim.y, hue: victim.hue, r: victim.stats.radius });
    const stats: DeathStats = {
      survivalTime: this.time - victim.bornAt,
      level: victim.level,
      kills: victim.kills,
      biomassCollected: Math.round(victim.biomassCollected),
      peakBiomass: Math.round(victim.peakBiomass),
      killedBy: killer && killer !== victim ? killer.name : null,
      killerId: killer && killer !== victim && killer.alive ? killer.id : null,
    };
    this.removeCell(victim.id);
    this.onDeath(victim, stats);
  }

  private replenish() {
    let budget = 30;
    while (budget-- > 0 && this.nutrients.size - this.crystalCount < this.nutrientTarget) this.spawnNutrient(false);
    if (this.crystalCount < this.crystalTarget && this.rand() < 0.05) this.spawnNutrient(true);
    // Blooms drift slowly so good feeding grounds move around.
    if (this.rand() < 0.01) {
      const b = this.blooms[Math.floor(this.rand() * this.blooms.length)];
      b.x = this.rand() * this.size;
      b.y = this.rand() * this.size;
    }
  }
}

/** Combined movement slow: the stronger of poison and toxin-cloud slows (they do not stack). */
export function movementSlow(c: Cell): number {
  return Math.max(c.poison.time > 0 ? c.poison.slow : 0, c.cloudSlow);
}

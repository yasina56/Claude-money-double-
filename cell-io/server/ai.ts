/**
 * AI organisms. They use exactly the same Cell, movement, combat and
 * evolution rules as players; the controller only writes `cell.input` and
 * calls the same ability / evolution entry points.
 */
import { angleDiff, clamp, TAU } from '../shared/math';
import { ORGANELLES, type OrganelleType } from '../shared/organelles';
import { nearestValidSlot } from '../shared/placement';
import { xpToNext, type Offer } from '../shared/progression';
import type { Cell } from './cell';
import type { World } from './world';

export type Archetype = 'grazer' | 'prey' | 'predator' | 'defender';

export interface AIState {
  archetype: Archetype;
  think: number;
  targetId: number | null;
  wander: number;
  mode: 'graze' | 'flee' | 'hunt' | 'guard';
  /** Seconds spent chasing the current target; predators tire and rest. */
  chase: number;
  rest: number;
}

/** Preferred organelles per archetype, with the local angles they like to mount at. */
const BUILDS: Record<Archetype, { type: OrganelleType; angles: number[]; center?: boolean }[]> = {
  predator: [
    { type: 'spikes', angles: [0, -Math.PI / 8, Math.PI / 8, -Math.PI / 4, Math.PI / 4] },
    { type: 'flagellum', angles: [Math.PI] },
    { type: 'venom', angles: [0] },
    { type: 'stinger', angles: [-Math.PI / 3, Math.PI / 3] },
    { type: 'cilia', angles: [Math.PI * 0.75, -Math.PI * 0.75] },
    { type: 'mitochondria', angles: [Math.PI], center: true },
  ],
  defender: [
    { type: 'membrane', angles: [0, Math.PI / 2, -Math.PI / 2, Math.PI] },
    { type: 'toxin', angles: [0], center: true },
    { type: 'regen', angles: [Math.PI], center: true },
    { type: 'mitochondria', angles: [Math.PI / 3, -Math.PI / 3] },
    { type: 'spikes', angles: [Math.PI, Math.PI * 0.8, -Math.PI * 0.8] },
  ],
  grazer: [
    { type: 'cilia', angles: [Math.PI, Math.PI * 0.75, -Math.PI * 0.75, Math.PI / 2, -Math.PI / 2] },
    { type: 'mitochondria', angles: [0], center: true },
    { type: 'membrane', angles: [Math.PI] },
    { type: 'regen', angles: [0], center: true },
  ],
  prey: [
    { type: 'cilia', angles: [Math.PI, Math.PI * 0.8, -Math.PI * 0.8, Math.PI * 0.6, -Math.PI * 0.6] },
    { type: 'flagellum', angles: [Math.PI] },
    { type: 'membrane', angles: [Math.PI] },
  ],
};

const NAMES: Record<Archetype, string[]> = {
  predator: ['Didinium', 'Lacrymaria', 'Coleps', 'Dileptus', 'Actinophrys', 'Amoeba Rex'],
  defender: ['Arcella', 'Difflugia', 'Volvox', 'Heliozoa', 'Testacea', 'Radiolaria'],
  grazer: ['Paramecium', 'Euglena', 'Stentor', 'Vorticella', 'Blepharisma', 'Spirostomum'],
  prey: ['Chlorella', 'Bodo', 'Monas', 'Chlamydo', 'Tetrahymena', 'Colpoda'],
};

export const AI_POPULATION: Record<Archetype, number> = { grazer: 7, prey: 10, predator: 5, defender: 4 };

const START: Record<Archetype, { biomass: [number, number]; level: [number, number] }> = {
  prey: { biomass: [5, 12], level: [1, 2] },
  grazer: { biomass: [12, 45], level: [1, 3] },
  predator: { biomass: [30, 110], level: [3, 7] },
  defender: { biomass: [40, 130], level: [4, 8] },
};

export function spawnAI(world: World, archetype: Archetype): Cell {
  const r = world.rand;
  const spec = START[archetype];
  const biomass = spec.biomass[0] + r() * (spec.biomass[1] - spec.biomass[0]);
  const names = NAMES[archetype];
  const c = world.addCell('ai', names[Math.floor(r() * names.length)], biomass);
  c.hue = { prey: 100, grazer: 180, predator: 0, defender: 220 }[archetype] + Math.floor(r() * 40 - 20);
  c.ai = { archetype, think: 0, targetId: null, wander: r() * TAU, mode: 'graze', chase: 0, rest: 0 };
  const level = Math.round(spec.level[0] + r() * (spec.level[1] - spec.level[0]));
  while (c.level < level) world.addXp(c, xpToNext(c.level) - c.xp);
  autoEvolve(world, c);
  c.hp = c.stats.maxHp;
  c.energy = c.stats.energyMax;
  return c;
}

/** Choose and place evolutions the way this archetype likes. Uses the server's validation. */
export function autoEvolve(world: World, c: Cell) {
  let guard = 20;
  while (c.pendingEvolutions > 0 && guard-- > 0) {
    const offers = world.openEvolution(c);
    if (!offers) break;
    const build = BUILDS[c.ai?.archetype ?? 'grazer'];
    let best = 0;
    let bestScore = -Infinity;
    offers.forEach((o, i) => {
      const s = scoreOffer(c, o, build);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    const o = offers[best];
    let slot: number | undefined;
    if (o.kind === 'new') {
      const pref = build.find((b) => b.type === o.type);
      const count = c.organelles.filter((x) => x.type === o.type).length;
      const angle = pref ? pref.angles[count % pref.angles.length] : world.rand() * TAU;
      slot = nearestValidSlot(c.organelles, o.type, angle, pref?.center && count === 0) ?? undefined;
    }
    const err = world.chooseEvolution(c, { index: best, slot, tilt: 0 });
    if (err) {
      // Fall back to any offer that does not need placement.
      const alt = offers.findIndex((x) => x.kind !== 'new');
      if (alt < 0 || world.chooseEvolution(c, { index: alt })) break;
    }
  }
  world.closeEvolution(c);
}

function scoreOffer(c: Cell, o: Offer, build: (typeof BUILDS)[Archetype]): number {
  if (o.kind === 'mutation') return 1 + (o.mutation === 'vitality' ? 0.5 : 0);
  const idx = build.findIndex((b) => b.type === o.type);
  const pref = idx < 0 ? 0 : 10 - idx;
  if (o.kind === 'upgrade') return pref * 0.8 + 1;
  const count = c.organelles.filter((x) => x.type === o.type).length;
  const maxCount = idx < 0 ? 1 : build[idx].angles.length;
  return count >= maxCount ? 0.5 : pref - count * 1.5 + (ORGANELLES[o.type].mount === 'internal' && count > 0 ? -3 : 0);
}

function threatLevel(self: Cell, other: Cell): number {
  const sizeRatio = other.stats.radius / self.stats.radius;
  const armed = other.stats.deliveries.length > 0 ? 1.3 : 1;
  return sizeRatio * armed * (other.level >= self.level ? 1.1 : 0.9);
}

export function updateAI(world: World, c: Cell, dt: number) {
  const ai = c.ai!;
  if (c.pendingEvolutions > 0) autoEvolve(world, c);
  ai.think -= dt;
  if (ai.mode === 'hunt') ai.chase += dt;
  ai.rest = Math.max(0, ai.rest - dt);
  if (ai.chase > 7) {
    ai.chase = 0;
    ai.rest = 6;
    ai.targetId = null;
  }
  if (ai.think > 0) return;
  ai.think = 0.2 + world.rand() * 0.15;

  const R = c.stats.radius;
  const sense = 420 + R * 3;
  let fx = 0;
  let fy = 0;
  let closestThreat: Cell | null = null;
  let closestThreatD = Infinity;
  let prey: Cell | null = null;
  let preyScore = -Infinity;

  for (const o of world.cells.values()) {
    if (o === c || !o.alive) continue;
    const dx = o.x - c.x;
    const dy = o.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d > sense) continue;
    const gap = d - R - o.stats.radius;
    const threat = threatLevel(c, o);
    const fearful = ai.archetype === 'prey' ? 0.9 : ai.archetype === 'grazer' ? 1.05 : ai.archetype === 'defender' ? 1.6 : 1.35;
    if (threat > fearful && gap < 260 + o.stats.radius) {
      const w = (threat / Math.max(30, gap)) * 100;
      fx -= (dx / d) * w;
      fy -= (dy / d) * w;
      if (gap < closestThreatD) {
        closestThreatD = gap;
        closestThreat = o;
      }
    }
    // Newly spawned players (level 1-2) get a grace period from AI predators.
    const grace = o.kind === 'player' && o.level <= 2;
    if (ai.archetype === 'predator' && ai.rest <= 0 && !grace && o.spawnProtect <= 0 && o.evolveProtect <= 0 && o.stats.radius < R * 1.3) {
      const score = -gap * 0.01 - o.hp / Math.max(1, o.stats.maxHp) - o.stats.armor.length * 0.3 + (o.id === ai.targetId ? 0.5 : 0);
      if (score > preyScore) {
        preyScore = score;
        prey = o;
      }
    }
  }

  // Avoid acid pools and walls.
  let ax = 0;
  let ay = 0;
  for (const h of world.hazards) {
    if (h.kind !== 'acid') continue;
    const dx = c.x - h.x;
    const dy = c.y - h.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < h.r + R + 90) {
      ax += (dx / d) * 2;
      ay += (dy / d) * 2;
    }
  }
  const m = 150 + R;
  if (c.x < m) ax += 1.5;
  if (c.y < m) ay += 1.5;
  if (c.x > world.size - m) ax -= 1.5;
  if (c.y > world.size - m) ay -= 1.5;

  const lowHp = c.hp < c.stats.maxHp * 0.35;
  let dirX = 0;
  let dirY = 0;
  let throttle = 0.85;

  if (closestThreat && (ai.archetype !== 'predator' || lowHp || closestThreatD < 60)) {
    ai.mode = 'flee';
    dirX = fx;
    dirY = fy;
    throttle = 1;
    if (closestThreatD < 80 && c.energy > 40) world.dash(c);
    if (ai.archetype === 'defender' && closestThreatD < 70) world.toxin(c);
  } else if (prey && !lowHp) {
    if (ai.targetId !== prey.id) ai.chase = 0;
    ai.mode = 'hunt';
    ai.targetId = prey.id;
    const d = Math.hypot(prey.x - c.x, prey.y - c.y);
    const lead = clamp(d / 400, 0, 0.8);
    const tx = prey.x + prey.vx * lead;
    const ty = prey.y + prey.vy * lead;
    dirX = tx - c.x;
    dirY = ty - c.y;
    throttle = 1;
    const facing = Math.abs(angleDiff(c.heading, Math.atan2(dirY, dirX)));
    if (d < R + prey.stats.radius + 110 && facing < 0.3 && c.energy > 45) world.dash(c);
  } else {
    ai.mode = 'graze';
    let best: { x: number; y: number } | null = null;
    let bestScore = Infinity;
    const range = 260 + R * 2;
    world.nutrientGrid.query(c.x - range, c.y - range, c.x + range, c.y + range, (n) => {
      const d = Math.hypot(n.x - c.x, n.y - c.y);
      const s = d / (n.kind === 5 ? 4 : 1);
      if (s < bestScore) {
        bestScore = s;
        best = n;
      }
    });
    if (best) {
      dirX = (best as { x: number }).x - c.x;
      dirY = (best as { y: number }).y - c.y;
    } else {
      ai.wander += (world.rand() - 0.5) * 0.8;
      dirX = Math.cos(ai.wander);
      dirY = Math.sin(ai.wander);
    }
    throttle = ai.archetype === 'defender' ? 0.55 : 0.8;
    // Defenders lash out at anything hugging them.
    if (ai.archetype === 'defender') {
      for (const o of world.cells.values()) {
        if (o !== c && o.alive && Math.hypot(o.x - c.x, o.y - c.y) < R + o.stats.radius + 50) {
          world.toxin(c);
          break;
        }
      }
    }
  }

  const len = Math.hypot(dirX, dirY) || 1;
  dirX = dirX / len + ax;
  dirY = dirY / len + ay;
  c.input.a = Math.atan2(dirY, dirX);
  c.input.t = throttle;
}

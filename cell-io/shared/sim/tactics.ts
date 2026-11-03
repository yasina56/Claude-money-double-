/**
 * Layout-aware fighting for AI cells. A bot reads its own layout (where its
 * best weapon, best armor and net propulsion point) and fights the way that
 * layout wants to be played:
 *
 *  - weapon side toward the target (front spikes ram; rear spikes turn away and
 *    lure a chaser into them, braking so it runs onto the spikes)
 *  - armor toward an attacker when not attacking
 *  - flagellum/cilia kiters hit and run, and only dash when the dash will
 *    actually fly toward (or away from) the target
 *  - venom surge before a hit, toxin cloud when the target is close
 */
import { angleDiff, clamp } from '../math';
import { TUNING } from '../organelles';
import type { Cell } from './cell';
import { dashImpulse, propulsionVector } from './movement';
import type { World } from './world';

export interface Layout {
  weapon: { dir: number; damage: number } | null;
  rearWeapon: boolean;
  armor: { dir: number; reduction: number } | null;
  /** Local direction and size of net propulsion. */
  propulsion: { dir: number; mag: number };
  kiter: boolean;
  hasToxin: boolean;
  venomLinked: boolean;
}

export interface TacticState {
  retreatUntil: number;
}

export function readLayout(c: Cell): Layout {
  const s = c.stats;
  let weapon: Layout['weapon'] = null;
  for (const d of s.deliveries) if (!weapon || d.damage > weapon.damage) weapon = { dir: d.dir, damage: d.damage };
  let armor: Layout['armor'] = null;
  for (const a of s.armor) if (!armor || a.reduction > armor.reduction) armor = { dir: a.dir, reduction: a.reduction };
  const p = propulsionVector(s);
  return {
    weapon,
    rearWeapon: !!weapon && Math.abs(angleDiff(weapon.dir, Math.PI)) < Math.PI / 3,
    armor,
    propulsion: { dir: Math.atan2(p.y, p.x), mag: p.mag },
    kiter: p.mag >= 0.3 && Math.abs(angleDiff(Math.atan2(p.y, p.x), 0)) < Math.PI / 3,
    hasToxin: s.toxins.length > 0,
    venomLinked: s.deliveries.some((d) => d.venom),
  };
}

export interface Steer {
  a: number;
  t: number;
}

/** World angle the dash would fly at right now, given a steering choice. */
function dashAngle(c: Cell, steer: Steer) {
  const imp = dashImpulse(c, c.stats, steer, c.level);
  return Math.atan2(imp.y, imp.x);
}

/**
 * Fight `target`. Returns steering and fires abilities on the world directly
 * (through the same validated entry points players use).
 */
export function engage(world: World, c: Cell, target: Cell, st: TacticState, difficulty: number): Steer {
  return avoidClouds(world, c, fight(world, c, target, st, difficulty), target, difficulty);
}

/**
 * Steer out of enemy toxin clouds unless we are about to land a hit. Higher
 * difficulty reads clouds earlier.
 */
function avoidClouds(world: World, c: Cell, steer: Steer, target: Cell, difficulty: number): Steer {
  let px = 0;
  let py = 0;
  for (const cl of world.clouds) {
    if (cl.owner === c.id) continue;
    const dx = c.x - cl.x;
    const dy = c.y - cl.y;
    const d = Math.hypot(dx, dy) || 1;
    const edge = cl.r + c.stats.radius * 0.6 + 20 + 40 * difficulty;
    if (d > edge) continue;
    const w = (edge - d) / edge;
    px += (dx / d) * w;
    py += (dy / d) * w;
  }
  if (!px && !py) return steer;
  const gap = Math.hypot(target.x - c.x, target.y - c.y) - c.stats.radius - target.stats.radius;
  const weapon = readLayout(c).weapon;
  const toTarget = Math.atan2(target.y - c.y, target.x - c.x);
  // Committed to a hit only if the weapon is actually pointed at the target.
  if (gap < 25 && weapon && Math.abs(angleDiff(c.heading + weapon.dir, toTarget)) < 0.4) return steer;
  const ax = Math.cos(steer.a) + px * 3;
  const ay = Math.sin(steer.a) + py * 3;
  return { a: Math.atan2(ay, ax), t: 1 };
}

function fight(world: World, c: Cell, target: Cell, st: TacticState, difficulty: number): Steer {
  const L = readLayout(c);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const d = Math.hypot(dx, dy);
  const gap = d - c.stats.radius - target.stats.radius;
  const lead = clamp(d / 450, 0, 0.7);
  const ang = Math.atan2(target.y + target.vy * lead - c.y, target.x + target.vx * lead - c.x);
  const hpFrac = c.hp / c.stats.maxHp;
  const theirFrac = target.hp / target.stats.maxHp;
  const away = ang + Math.PI;

  // Did we just land a hit? Kiters disengage and come back.
  if (L.kiter && target.lastHitBy === c.id && world.time - target.lastHitAt < 0.2) {
    st.retreatUntil = world.time + 1.1 - 0.4 * difficulty;
  }

  if (hpFrac < 0.3 && theirFrac > hpFrac + 0.15) return evade(world, c, target, L, difficulty);

  if (world.time < st.retreatUntil) {
    if (gap > 260) st.retreatUntil = 0;
    const steer = { a: away, t: 1 };
    if (gap < 80 && Math.abs(angleDiff(dashAngle(c, steer), away)) < 0.6) world.dash(c);
    return steer;
  }

  if (L.hasToxin && gap < 70 + 20 * difficulty) world.toxin(c);

  if (!L.weapon) {
    // Toxin builds: close in armor-first when the gland is ready, release, then back off.
    if (L.hasToxin) {
      const ready = c.toxinCd <= 0 && c.energy >= TUNING.toxinCost;
      if (ready) return { a: ang, t: 1 };
      if (L.armor && gap < 120) return { a: ang - L.armor.dir, t: 0.2 };
      return { a: away, t: gap < 160 ? 0.9 : 0.3 };
    }
    // Nothing to hit with: show armor and keep a respectful distance.
    if (L.armor && gap < 180) return { a: ang - L.armor.dir, t: 0.2 };
    return { a: away, t: gap < 250 ? 1 : 0.4 };
  }

  if (L.rearWeapon && gap < 280) {
    // Lure: turn the spikes toward the chaser and brake so it rams them.
    const closing = -((target.vx - c.vx) * dx + (target.vy - c.vy) * dy) / Math.max(1, d);
    return { a: ang - L.weapon.dir, t: closing > 40 && gap < 140 ? 0.25 : 0.7 };
  }

  // A toxin gland that is ready to fire: hover just outside its reach (circling) and
  // strike once the cloud is on cooldown. This is the gland's intended counterplay.
  const theirs = readLayout(target);
  if (theirs.hasToxin && target.toxinCd <= 0.5 && target.energy >= TUNING.toxinCost && gap < 150 + 60 * difficulty) {
    const circle = ang + (gap < 110 ? 2.2 : 1.6) * (c.id % 2 ? 1 : -1);
    return { a: circle, t: 1 };
  }
  // Read the target's layout too: if its armor faces us, swing around to an exposed side.
  let aim = ang;
  const theirArmor = theirs.armor;
  if (theirArmor && gap > 30) {
    const facingUs = Math.abs(angleDiff(target.heading + theirArmor.dir, ang + Math.PI)) < TUNING.membraneHalfArc + 0.2;
    if (facingUs) {
      const side = angleDiff(target.heading + theirArmor.dir, ang + Math.PI) > 0 ? -1 : 1;
      aim = ang + side * (0.5 + 0.4 * difficulty) * Math.min(1, gap / 120);
    }
  }
  // Point the weapon at the target and drive in.
  const steer = { a: aim - L.weapon.dir, t: 1 };
  const aligned = Math.abs(angleDiff(c.heading + L.weapon.dir, ang)) < 0.35;
  if (L.venomLinked && aligned && gap < 200 && c.energy > TUNING.venomSurgeCost + 20) world.venom(c);
  const reach = 110 + 70 * difficulty;
  if (aligned && gap < reach && c.energy > 40 && Math.abs(angleDiff(dashAngle(c, steer), ang)) < 0.4) {
    if (world.rand() < 0.5 + 0.5 * difficulty) world.dash(c);
  }
  return steer;
}

/** Escape from (or stall) a threat in the way the layout supports best. */
export function evade(world: World, c: Cell, threat: Cell, L: Layout = readLayout(c), difficulty = 0.5): Steer {
  return avoidClouds(world, c, evadeInner(world, c, threat, L, difficulty), threat, difficulty);
}

function evadeInner(world: World, c: Cell, threat: Cell, L: Layout, difficulty: number): Steer {
  const dx = threat.x - c.x;
  const dy = threat.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  const gap = d - c.stats.radius - threat.stats.radius;
  const ang = Math.atan2(dy, dx);
  const away = ang + Math.PI;
  if (L.hasToxin && gap < 60) world.toxin(c);
  // Rear weapon: keep it pointed at the chaser and let it run into it.
  if (L.rearWeapon && gap < 150) return { a: away, t: gap < 60 ? 0.3 : 0.8 };
  // Armor and no speed: turn the plates toward the threat and back off slowly.
  if (L.armor && !L.kiter && gap < 90) return { a: ang - L.armor.dir, t: 0.25 };
  const steer = { a: away, t: 1 };
  if (gap < 90 + 40 * difficulty && c.energy > 30 && Math.abs(angleDiff(dashAngle(c, steer), away)) < 0.8) world.dash(c);
  return steer;
}

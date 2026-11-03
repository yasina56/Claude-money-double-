import { describe, expect, it } from 'vitest';
import { EVOLVE_COMBAT_LOCK, EVOLVE_PROTECTION } from '../shared/constants';
import { REGROW_TIME } from '../shared/integrity';
import type { Organelle } from '../shared/organelles';
import { TUNING } from '../shared/organelles';
import { SURFACE_SLOTS } from '../shared/placement';
import { xpToNext } from '../shared/progression';
import { computeStats } from '../shared/stats';
import { classifyStrategy } from '../shared/strategy';
import { dashImpulse, propulsionVector } from '../shared/sim/movement';
import { World } from '../shared/sim/world';
import type { Cell } from '../shared/sim/cell';
import { refreshStats } from '../shared/sim/cell';

const FRONT = 0;
const REAR = SURFACE_SLOTS / 2;
const RIGHT = SURFACE_SLOTS / 4; // local +90 degrees
const o = (type: Organelle['type'], slot: number, level = 1, tilt = 0): Organelle => ({ type, slot, level, tilt });

function quiet() {
  return new World({ seed: 2, nutrientTarget: 0, crystalTarget: 0, hazards: false });
}
function place(c: Cell, x: number, y: number, heading: number, orgs: Organelle[] = []) {
  c.x = x;
  c.y = y;
  c.heading = heading;
  c.spawnProtect = 0;
  c.organelles = orgs;
  c.orgHealth = [];
  refreshStats(c);
  c.hp = c.stats.maxHp;
  c.energy = c.stats.energyMax;
}
/** Two cells facing each other along x; `a` rams `d` at `speed`. */
function pair(aOrgs: Organelle[], dOrgs: Organelle[], dHeading = Math.PI) {
  const w = quiet();
  const a = w.addCell('player', 'A', 60);
  const d = w.addCell('player', 'D', 60);
  place(a, 1000, 1000, 0, aOrgs);
  place(d, 1000 + a.stats.radius + 10, 1000, dHeading, dOrgs);
  return { w, a, d };
}

describe('organelle damage', () => {
  it('hits on the armored side wear down that membrane, not one on the other side', () => {
    const { w, a, d } = pair([o('spikes', FRONT)], [o('membrane', FRONT), o('membrane', REAR)]);
    w.resolveHit(a, d, 1, 0, 220);
    expect(d.orgHealth[0].hp).toBeLessThan(d.orgHealth[0].max);
    expect(d.orgHealth[1].hp).toBe(d.orgHealth[1].max);
  });

  it('a broken membrane stops protecting until it regrows', () => {
    const { w, a, d } = pair([o('spikes', FRONT, 3)], [o('membrane', FRONT)]);
    a.energy = 1e9;
    const armored = () => {
      const hp = d.hp;
      d.pairCooldown.clear();
      w.resolveHit(a, d, 1, 0, 220);
      const dealt = hp - d.hp;
      d.hp = d.stats.maxHp;
      return dealt;
    };
    const first = armored();
    let n = 0;
    while (d.orgHealth[0].regrow === 0 && n++ < 50) armored();
    expect(d.orgHealth[0].regrow).toBeGreaterThan(0);
    expect(d.stats.armor).toHaveLength(0);
    expect(armored()).toBeGreaterThan(first * 1.4);
    // Regrows after REGROW_TIME (keep them apart so nothing else happens).
    d.x = 3000;
    a.x = 500;
    for (let t = 0; t < (REGROW_TIME + 1) * 40; t++) w.step(1 / 40);
    expect(d.orgHealth[0].regrow).toBe(0);
    expect(d.orgHealth[0].hp).toBe(d.orgHealth[0].max);
    expect(d.stats.armor).toHaveLength(1);
  });

  it('spikes chip when they ram armor, but not when they hit bare membrane', () => {
    const vsArmor = pair([o('spikes', FRONT)], [o('membrane', FRONT)]);
    vsArmor.w.resolveHit(vsArmor.a, vsArmor.d, 1, 0, 220);
    expect(vsArmor.a.orgHealth[0].hp).toBeLessThan(vsArmor.a.orgHealth[0].max);
    const vsBare = pair([o('spikes', FRONT)], []);
    vsBare.w.resolveHit(vsBare.a, vsBare.d, 1, 0, 220);
    expect(vsBare.a.orgHealth[0].hp).toBe(vsBare.a.orgHealth[0].max);
  });

  it('exposed weapons on the struck side crack; weapons facing away are safe', () => {
    // D's front spikes face the attacker and clash; D's rear spikes are untouched.
    const { w, a, d } = pair([o('spikes', FRONT)], [o('spikes', FRONT), o('spikes', REAR)]);
    w.resolveHit(a, d, 1, 0, 220);
    expect(d.orgHealth[0].hp).toBeLessThan(d.orgHealth[0].max);
    expect(d.orgHealth[1].hp).toBe(d.orgHealth[1].max);
  });

  it('crack stages are published to clients through infoVersion', () => {
    const { w, a, d } = pair([o('spikes', FRONT, 3)], [o('membrane', FRONT)]);
    const v = d.infoVersion;
    for (let i = 0; i < 3; i++) {
      d.pairCooldown.clear();
      w.resolveHit(a, d, 1, 0, 220);
    }
    expect(d.infoVersion).toBeGreaterThan(v);
  });
});

describe('venom surge', () => {
  it('requires a linked venom sac and doubles the poison of the next hits', () => {
    const unlinked = pair([o('venom', 1), o('stinger', REAR)], []);
    expect(unlinked.w.venom(unlinked.a)).toBe(false);

    const normal = pair([o('venom', 1), o('stinger', FRONT)], []);
    normal.w.resolveHit(normal.a, normal.d, 1, 0, 30);
    const surge = pair([o('venom', 1), o('stinger', FRONT)], []);
    const energy = surge.a.energy;
    expect(surge.w.venom(surge.a)).toBe(true);
    expect(surge.a.energy).toBe(energy - TUNING.venomSurgeCost);
    surge.w.resolveHit(surge.a, surge.d, 1, 0, 30);
    expect(surge.d.poison.stacks).toBe(2 * normal.d.poison.stacks);
    expect(surge.d.poison.dps).toBeCloseTo(2 * normal.d.poison.dps);
    // Stacks still cap.
    for (let i = 0; i < 5; i++) surge.w.resolveHit(surge.a, surge.d, 1, 0, 30);
    expect(surge.d.poison.stacks).toBe(TUNING.venomMaxStacks);
    // Cooldown blocks an immediate second surge.
    expect(surge.w.venom(surge.a)).toBe(false);
  });

  it('expires after its duration', () => {
    const { w, a } = pair([o('venom', 1), o('stinger', FRONT)], []);
    w.venom(a);
    for (let t = 0; t < (TUNING.venomSurgeDuration + 0.1) * 40; t++) w.step(1 / 40);
    expect(a.venomSurge).toBe(0);
  });
});

describe('directional dash', () => {
  const angleOf = (v: { x: number; y: number }) => Math.atan2(v.y, v.x);
  const body = { x: 0, y: 0, vx: 0, vy: 0, heading: 0 };

  it('a rear flagellum dashes forward regardless of steering', () => {
    const s = computeStats(30, 7, [o('flagellum', REAR)]);
    const imp = dashImpulse(body, s, { a: Math.PI / 2, t: 1 }, 7);
    expect(Math.abs(angleOf(imp))).toBeLessThan(0.01);
  });

  it('a side flagellum gives a sideways dodge', () => {
    // Mounted on the right side, it pushes the cell to the left (local -90 degrees).
    const s = computeStats(30, 7, [o('flagellum', RIGHT)]);
    const imp = dashImpulse(body, s, { a: 0, t: 1 }, 7);
    expect(angleOf(imp)).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('an even ring of cilia cancels out, so the dash follows your steering', () => {
    const ring = [0, 4, 8, 12].map((sl) => o('cilia', sl));
    const s = computeStats(30, 5, ring);
    expect(propulsionVector(s).mag).toBeLessThan(0.01);
    const imp = dashImpulse(body, s, { a: 1.0, t: 1 }, 5);
    expect(angleOf(imp)).toBeCloseTo(1.0, 5);
  });

  it('more propulsion dashes harder', () => {
    const weak = computeStats(30, 7, [o('cilia', REAR)]);
    const strong = computeStats(30, 7, [o('flagellum', REAR, 3)]);
    const len = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);
    expect(len(dashImpulse(body, strong, { a: 0, t: 1 }, 7))).toBeGreaterThan(len(dashImpulse(body, weak, { a: 0, t: 1 }, 7)));
  });
});

describe('evolution protection', () => {
  function leveled() {
    const w = quiet();
    const c = w.addCell('player', 'evo');
    place(c, 1000, 1000, 0);
    w.addXp(c, xpToNext(1));
    return { w, c };
  }

  it('lasts at most EVOLVE_PROTECTION seconds', () => {
    const { w, c } = leveled();
    w.openEvolution(c);
    expect(c.evolveProtect).toBe(EVOLVE_PROTECTION);
    for (let t = 0; t < (EVOLVE_PROTECTION + 0.1) * 40; t++) w.step(1 / 40);
    expect(c.evolveProtect).toBe(0);
  });

  it('ends the moment you steer while the editor is open', () => {
    const { w, c } = leveled();
    w.openEvolution(c);
    c.input = { a: 0, t: 1 };
    w.step(1 / 40);
    expect(c.evolveProtect).toBe(0);
  });

  it('cannot be opened mid-combat; it waits until you have disengaged', () => {
    const { w, c } = leveled();
    c.lastCombatAt = w.time;
    expect(w.openEvolution(c)).toBeNull();
    expect(c.evolveProtect).toBe(0);
    for (let t = 0; t < (EVOLVE_COMBAT_LOCK + 0.1) * 40; t++) w.step(1 / 40);
    expect(w.openEvolution(c)).not.toBeNull();
  });
});

describe('strategy badge', () => {
  it('reads builds from layout and placement', () => {
    expect(classifyStrategy([])).toBeNull();
    expect(classifyStrategy([o('spikes', FRONT), o('spikes', 1), o('flagellum', REAR), o('venom', 1)])).toBe('Hunter');
    expect(classifyStrategy([o('membrane', FRONT), o('membrane', REAR), o('regen', 0), o('mitochondria', 1)])).toBe('Tank');
    expect(classifyStrategy([o('cilia', REAR), o('cilia', 7), o('cilia', 9), o('flagellum', 12)])).toBe('Speedster');
    expect(classifyStrategy([o('toxin', 0), o('membrane', FRONT), o('venom', 1)])).toBe('Toxic');
    expect(classifyStrategy([o('spikes', FRONT), o('membrane', REAR), o('toxin', 0)])).toBe('Hybrid');
  });

  it('the same organelles read differently depending on where they sit', () => {
    const front = [o('spikes', FRONT), o('spikes', 1), o('spikes', 15)];
    const rear = [o('spikes', REAR), o('spikes', 7), o('spikes', 9)];
    expect(classifyStrategy(front)).toBe('Hunter');
    expect(classifyStrategy(rear)).not.toBe('Hunter');
  });
});

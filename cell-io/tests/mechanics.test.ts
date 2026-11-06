import { describe, expect, it } from 'vitest';
import { MAX_HIT_FRACTION } from '../shared/constants';
import type { Organelle } from '../shared/organelles';
import { capacityForLevel, checkPlacement, organelleLocalPos, SURFACE_SLOTS, validSlots } from '../shared/placement';
import { generateOffers, xpToNext } from '../shared/progression';
import { armorMultiplier, computeStats, statSummary, thrustMultiplier } from '../shared/stats';
import { mulberry32 } from '../shared/math';
import { World } from '../shared/sim/world';
import type { Cell } from '../shared/sim/cell';
import { refreshStats } from '../shared/sim/cell';

const FRONT = 0;
const REAR = SURFACE_SLOTS / 2;
const o = (type: Organelle['type'], slot: number, level = 1, tilt = 0): Organelle => ({ type, slot, level, tilt });

function quietWorld() {
  return new World({ seed: 1, nutrientTarget: 0, crystalTarget: 0, hazards: false });
}

function place(c: Cell, x: number, y: number, heading: number, organelles: Organelle[] = []) {
  c.x = x;
  c.y = y;
  c.heading = heading;
  c.spawnProtect = 0;
  c.organelles = organelles;
  refreshStats(c);
  c.hp = c.stats.maxHp;
  c.energy = c.stats.energyMax;
}

describe('attachment system', () => {
  it('rejects overlapping, out-of-range, over-tilted and over-capacity placements', () => {
    const orgs = [o('membrane', FRONT)]; // spans slots 15, 0, 1
    expect(checkPlacement(orgs, 'spikes', 1, 0, 10)).toBe('occupied');
    expect(checkPlacement(orgs, 'spikes', 15, 0, 10)).toBe('occupied');
    expect(checkPlacement(orgs, 'spikes', 2, 0, 10)).toBeNull();
    expect(checkPlacement(orgs, 'spikes', 99, 0, 10)).toBe('range');
    expect(checkPlacement(orgs, 'spikes', 4, 1.2, 10)).toBe('tilt');
    expect(checkPlacement(orgs, 'mitochondria', 7, 0, 10)).toBe('range');
    expect(checkPlacement(orgs, 'mitochondria', 0, 0.3, 10)).toBe('tilt');
    expect(checkPlacement(orgs, 'venom', 0, 0, 3)).toBe('capacity'); // membrane 2 + venom 2 > 3
    expect(validSlots(orgs, 'membrane')).not.toContain(2); // would overlap slot 1
  });

  it('stores positions normalized so organelles stay attached as the cell grows', () => {
    const p = organelleLocalPos(o('spikes', 4));
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(1);
    const small = computeStats(10, 1, [o('spikes', FRONT)]);
    const big = computeStats(900, 1, [o('spikes', FRONT)]);
    expect(big.radius).toBeGreaterThan(small.radius * 3);
    expect(big.deliveries[0].dir).toBe(small.deliveries[0].dir);
  });
});

describe('placement changes movement', () => {
  it('rear cilia push forward harder than front cilia', () => {
    const rear = computeStats(10, 3, [o('cilia', REAR)]);
    const front = computeStats(10, 3, [o('cilia', FRONT)]);
    expect(thrustMultiplier(rear, 0)).toBeGreaterThan(thrustMultiplier(front, 0) + 0.04);
    // ...and the front-mounted cilia instead help backing away.
    expect(thrustMultiplier(front, Math.PI)).toBeGreaterThan(thrustMultiplier(rear, Math.PI));
  });

  it('side cilia improve turning more than rear cilia', () => {
    const side = computeStats(10, 3, [o('cilia', 4)]);
    const rear = computeStats(10, 3, [o('cilia', REAR)]);
    expect(side.turnRate).toBeGreaterThan(rear.turnRate);
  });

  it('a rear flagellum gives strong forward speed but costs turning; a side flagellum does not speed you forward', () => {
    const base = computeStats(10, 7, []);
    const rear = computeStats(10, 7, [o('flagellum', REAR)]);
    const side = computeStats(10, 7, [o('flagellum', 4)]);
    expect(thrustMultiplier(rear, 0)).toBeGreaterThan(1.25);
    expect(thrustMultiplier(side, 0)).toBeLessThan(1.02);
    expect(rear.turnRate).toBeLessThan(base.turnRate);
  });

  it('speed stacking is soft-capped', () => {
    const many = Array.from({ length: 8 }, (_, i) => o('cilia', 4 + i, 3));
    const s = computeStats(10, 20, [...many, o('flagellum', REAR, 3)]);
    expect(thrustMultiplier(s, 0)).toBeLessThan(1.8);
  });

  it('server movement cannot exceed the stat-derived speed even with a huge throttle', () => {
    const w = quietWorld();
    const c = w.addCell('player', 'speeder');
    place(c, 1000, 1000, 0);
    c.input = { a: 0, t: 50 };
    for (let i = 0; i < 200; i++) w.step(1 / 40);
    expect(Math.hypot(c.vx, c.vy)).toBeLessThanOrEqual(c.stats.baseSpeed * thrustMultiplier(c.stats, 0) + 1);
  });
});

describe('directional combat', () => {
  function duel(attackerOrgs: Organelle[], defenderOrgs: Organelle[], attackerHeading: number, defenderHeading: number) {
    const w = quietWorld();
    const a = w.addCell('player', 'A');
    const d = w.addCell('player', 'D');
    place(a, 1000, 1000, attackerHeading, attackerOrgs);
    place(d, 1000 + a.stats.radius + 10, 1000, defenderHeading, defenderOrgs);
    const before = d.hp;
    w.resolveHit(a, d, 1, 0, 220); // a rams d head-on along +x
    return { dealt: before - d.hp, w, a, d };
  }

  it('front spikes hurt when ramming; the same spikes on the rear do not', () => {
    const front = duel([o('spikes', FRONT)], [], 0, Math.PI).dealt;
    const rear = duel([o('spikes', REAR)], [], 0, Math.PI).dealt;
    const none = duel([], [], 0, Math.PI).dealt;
    expect(front).toBeGreaterThan(none + 8);
    expect(rear).toBeLessThan(none * 1.05); // only blunt bump damage (spike weight adds a little mass)
  });

  it('rear spikes punish a chaser that rams you from behind', () => {
    // Defender faces away (+x), so the attacker contacts its rear.
    const w = quietWorld();
    const chaser = w.addCell('player', 'chaser');
    const runner = w.addCell('player', 'runner');
    place(chaser, 1000, 1000, 0);
    place(runner, 1000 + chaser.stats.radius + 10, 1000, 0, [o('spikes', REAR)]);
    const hp = chaser.hp;
    w.resolveHit(runner, chaser, -1, 0, 220); // runner's rear spikes vs chaser's front
    expect(hp - chaser.hp).toBeGreaterThan(8);
  });

  it('armor only protects the side it covers', () => {
    const covered = duel([o('spikes', FRONT)], [o('membrane', FRONT)], 0, Math.PI).dealt; // defender faces attacker
    const exposed = duel([o('spikes', FRONT)], [o('membrane', FRONT)], 0, 0).dealt; // defender shows its rear
    expect(covered).toBeLessThan(exposed * 0.7);
    const s = computeStats(10, 2, [o('membrane', FRONT)]);
    expect(armorMultiplier(s, 0)).toBeLessThan(armorMultiplier(s, Math.PI));
  });

  it('no single hit removes more than the max-hit fraction of HP', () => {
    const { d, dealt } = duel([o('spikes', FRONT, 3)], [], 0, Math.PI);
    expect(dealt).toBeLessThanOrEqual(d.stats.maxHp * MAX_HIT_FRACTION * 2 + 1e-6); // spike + bump
  });

  it('spawn-protected cells neither take nor deal collision damage', () => {
    const w = quietWorld();
    const a = w.addCell('player', 'A');
    const d = w.addCell('player', 'D');
    place(a, 1000, 1000, 0, [o('spikes', FRONT)]);
    place(d, 1000 + a.stats.radius + 10, 1000, Math.PI);
    d.spawnProtect = 2;
    w.resolveHit(a, d, 1, 0, 300);
    expect(d.hp).toBe(d.stats.maxHp);
  });
});

describe('venom', () => {
  it('a venom sac needs a linked delivery organelle', () => {
    expect(computeStats(10, 4, [o('venom', 1)]).deliveries).toHaveLength(0);
    // Sac at internal slot 1 (angle 0, front) + front stinger => linked at full potency.
    const linked = computeStats(10, 4, [o('venom', 1), o('stinger', FRONT)]);
    expect(linked.deliveries[0].venom?.potency).toBe(1);
    // Same sac but the stinger is on the rear: no link.
    const unlinked = computeStats(10, 4, [o('venom', 1), o('stinger', REAR)]);
    expect(unlinked.deliveries[0].venom).toBeNull();
    // A centered sac links everything at reduced potency.
    const centered = computeStats(10, 4, [o('venom', 0), o('stinger', REAR)]);
    expect(centered.deliveries[0].venom?.potency).toBeCloseTo(0.6);
    expect(statSummary(linked).venomLinked).toBe(true);
  });

  it('poison stacks are capped and deal damage over time', () => {
    const w = quietWorld();
    const a = w.addCell('player', 'A');
    const d = w.addCell('player', 'D');
    place(a, 1000, 1000, 0, [o('venom', 1), o('stinger', FRONT)]);
    place(d, 1000 + a.stats.radius + 10, 1000, Math.PI);
    a.energy = 1000;
    for (let i = 0; i < 10; i++) w.resolveHit(a, d, 1, 0, 30);
    expect(d.poison.stacks).toBe(3);
    const hp = d.hp;
    d.x = 3000; // separate them
    for (let i = 0; i < 40; i++) w.step(1 / 40);
    expect(d.hp).toBeLessThan(hp - 5);
  });
});

describe('evolution flow (server-side validation)', () => {
  it('validates offers and placements', () => {
    const w = quietWorld();
    const c = w.addCell('player', 'evo');
    place(c, 1000, 1000, 0);
    expect(w.chooseEvolution(c, { index: 0, slot: 0 })).toMatch(/no evolution/);
    w.addXp(c, xpToNext(1));
    expect(c.level).toBe(2);
    const offers = w.openEvolution(c)!;
    expect(offers.length).toBe(3);
    expect(c.evolveProtect).toBeGreaterThan(0);
    const i = offers.findIndex((x) => x.kind === 'new');
    expect(w.chooseEvolution(c, { index: 9 })).toMatch(/invalid offer/);
    expect(w.chooseEvolution(c, { index: i, slot: 999, tilt: 0 })).toMatch(/invalid placement/);
    const off = offers[i];
    const slot = off.kind === 'new' ? validSlots(c.organelles, off.type)[0] : 0;
    expect(w.chooseEvolution(c, { index: i, slot, tilt: 0.1 })).toBeNull();
    expect(c.organelles).toHaveLength(1);
    expect(c.pendingEvolutions).toBe(0);
    expect(c.evolving).toBe(false);
  });

  it('protection is granted once per pending evolution, not per reopen', () => {
    const w = quietWorld();
    const c = w.addCell('player', 'evo');
    place(c, 1000, 1000, 0);
    w.addXp(c, xpToNext(1));
    w.openEvolution(c);
    w.closeEvolution(c);
    w.openEvolution(c);
    expect(c.evolveProtect).toBe(0);
  });
});

describe('progression', () => {
  it('first evolution is about 30 nutrients away and XP requirements increase', () => {
    expect(xpToNext(1)).toBe(30);
    for (let l = 1; l < 25; l++) expect(xpToNext(l + 1)).toBeGreaterThan(xpToNext(l));
    expect(capacityForLevel(3)).toBeGreaterThan(capacityForLevel(2));
  });

  it('offers respect unlock tiers and capacity', () => {
    const rand = mulberry32(3);
    for (let k = 0; k < 50; k++) {
      const offers = generateOffers({ level: 2, organelles: [] }, rand);
      for (const of of offers) {
        if (of.kind === 'new') expect(['cilia', 'spikes', 'membrane', 'mitochondria']).toContain(of.type);
        expect(of.kind).not.toBe('upgrade');
      }
    }
    const full = generateOffers({ level: 2, organelles: [o('membrane', 0)] }, rand);
    expect(full.every((x) => x.kind !== 'new')).toBe(true);
    expect(generateOffers({ level: 10, organelles: [] }, rand)).toHaveLength(4);
  });

  it('a kill rewards biomass and XP and bursts the victim into nutrients', () => {
    const w = quietWorld();
    const a = w.addCell('player', 'A');
    const v = w.addCell('player', 'V', 200);
    place(a, 1000, 1000, 0);
    place(v, 2000, 2000, 0);
    v.lastHitBy = a.id;
    v.lastHitAt = w.time;
    const bio = a.biomass;
    w.kill(v);
    expect(a.kills).toBe(1);
    expect(a.biomass).toBeGreaterThan(bio + 50);
    expect(w.nutrients.size).toBeGreaterThan(10);
    expect(w.cells.has(v.id)).toBe(false);
  });
});

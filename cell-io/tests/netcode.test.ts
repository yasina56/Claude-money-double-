import { describe, expect, it } from 'vitest';
import { Predictor } from '../client/src/predict';
import type { PrivateState } from '../shared/protocol';
import { World } from '../shared/sim/world';
import type { Cell } from '../shared/sim/cell';
import { refreshStats } from '../shared/sim/cell';
import { mulberry32 } from '../shared/math';

const DT = 1 / 40;

function soloWorld() {
  const w = new World({ seed: 5, nutrientTarget: 0, crystalTarget: 0, hazards: false });
  const c = w.addCell('player', 'me');
  c.x = 2000;
  c.y = 2000;
  c.spawnProtect = 0;
  return { w, c };
}

/** What the server would put in the snapshot's private state. */
function you(w: World, c: Cell): PrivateState {
  return {
    hp: c.hp, maxHp: c.stats.maxHp, energy: c.energy, energyMax: c.stats.energyMax, xp: 0, xpNext: 30, level: c.level,
    biomass: c.biomass, kills: 0, pendingEvolutions: 0, dashCd: c.dashCd, dashMaxCd: 2.6, toxinCd: 0, hasToxin: false,
    capacity: 0, capacityUsed: 0, protectedFor: 0, apex: false,
    x: c.x, y: c.y, vx: c.vx, vy: c.vy, heading: c.heading, ack: c.inputSeq, ackAge: w.time - c.inputAt,
    slow: 0, evolving: false, mutations: { ...c.mutations },
  };
}

describe('client-side prediction', () => {
  it('with zero latency the prediction matches the server exactly', () => {
    const { w, c } = soloWorld();
    const p = new Predictor();
    p.setStats(you(w, c), c.organelles);
    p.reconcile(you(w, c), []);
    for (let i = 0; i < 120; i++) {
      if (i % 10 === 0) {
        const a = i * 0.37;
        const seq = p.pushInput(a, 1);
        c.input = { a, t: 1 };
        c.inputSeq = seq;
        c.inputAt = w.time;
      }
      p.tick(DT, []);
      w.step(DT);
      p.reconcile(you(w, c), []);
    }
    expect(p.errorAvg).toBeLessThan(0.01);
    expect(Math.hypot(p.body!.x - c.x, p.body!.y - c.y)).toBeLessThan(0.01);
  });

  it('with input latency, corrections stay small and the predicted cell leads the server', () => {
    const { w, c } = soloWorld();
    const p = new Predictor();
    p.setStats(you(w, c), c.organelles);
    p.reconcile(you(w, c), []);
    const inFlight: { at: number; a: number; seq: number }[] = [];
    const LAG = 3; // ticks of one-way latency (75 ms)
    let maxErr = 0;
    for (let i = 0; i < 400; i++) {
      if (i % 4 === 0) {
        const a = Math.sin(i / 30) * 2.5;
        inFlight.push({ at: i + LAG, a, seq: p.pushInput(a, 1) });
      }
      while (inFlight.length && inFlight[0].at <= i) {
        const m = inFlight.shift()!;
        c.input = { a: m.a, t: 1 };
        c.inputSeq = m.seq;
        c.inputAt = w.time;
      }
      p.tick(DT, []);
      w.step(DT);
      if (i % 2 === 0) p.reconcile(you(w, c), []); // 20 Hz snapshots
      if (i > 40) maxErr = Math.max(maxErr, p.lastError);
    }
    // Without prediction the cell would be drawn ~LAG ticks behind (about 18 px at full speed).
    expect(maxErr).toBeLessThan(4);
  });

  it('a predicted dash is replayed during reconciliation', () => {
    const { w, c } = soloWorld();
    const p = new Predictor();
    p.setStats(you(w, c), c.organelles);
    p.reconcile(you(w, c), []);
    const seq = p.pushInput(0, 1);
    c.input = { a: 0, t: 1 };
    c.inputSeq = seq;
    c.inputAt = w.time;
    for (let i = 0; i < 20; i++) {
      p.tick(DT, []);
      w.step(DT);
    }
    expect(p.predictDash(you(w, c))).toBe(true);
    expect(w.dash(c)).toBe(true);
    for (let i = 0; i < 6; i++) {
      p.tick(DT, []);
      w.step(DT);
    }
    p.reconcile(you(w, c), []);
    expect(p.lastError).toBeLessThan(1);
    // A second dash right away is not predicted (local cooldown).
    expect(p.predictDash(you(w, c))).toBe(false);
  });
});

describe('spatial grid', () => {
  it('cellsNear finds every overlapping pair that brute force finds', () => {
    const w = new World({ seed: 9, nutrientTarget: 0, crystalTarget: 0, hazards: false });
    const r = mulberry32(3);
    const cells: Cell[] = [];
    for (let i = 0; i < 250; i++) {
      const c = w.addCell('ai', `c${i}`, 5 + r() * 900);
      c.x = r() * 1500;
      c.y = r() * 1500;
      refreshStats(c);
      cells.push(c);
    }
    w.rebuildCellGrid();
    let pairs = 0;
    for (const A of cells) {
      const found = new Set<number>();
      w.cellsNear(A.x, A.y, A.stats.radius, (B) => found.add(B.id));
      for (const B of cells) {
        if (B === A) continue;
        if (Math.hypot(A.x - B.x, A.y - B.y) < A.stats.radius + B.stats.radius) {
          pairs++;
          expect(found.has(B.id)).toBe(true);
        }
      }
    }
    expect(pairs).toBeGreaterThan(50);
  });
});

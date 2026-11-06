import { describe, expect, it } from 'vitest';
import { angleDiff } from '../shared/math';
import type { Organelle } from '../shared/organelles';
import { capacityForLevel, capacityUsed, checkPlacement, SURFACE_SLOTS } from '../shared/placement';
import { maxOrganelleLevel } from '../shared/progression';
import { difficultyFor, spawnAI } from '../shared/sim/ai';
import { BUILDS } from '../shared/sim/builds';
import type { Cell } from '../shared/sim/cell';
import { refreshStats } from '../shared/sim/cell';
import { engage, evade, readLayout } from '../shared/sim/tactics';
import { World } from '../shared/sim/world';

const REAR = SURFACE_SLOTS / 2;
const o = (type: Organelle['type'], slot: number, level = 1, tilt = 0): Organelle => ({ type, slot, level, tilt });

function world() {
  return new World({ seed: 4, nutrientTarget: 0, crystalTarget: 0, hazards: false });
}
function cell(w: World, x: number, heading: number, orgs: Organelle[], biomass = 80) {
  const c = w.addCell('ai', 'bot', biomass);
  c.x = x;
  c.y = 1000;
  c.heading = heading;
  c.spawnProtect = 0;
  c.level = 10;
  c.organelles = orgs;
  c.orgHealth = [];
  refreshStats(c);
  c.hp = c.stats.maxHp;
  c.energy = c.stats.energyMax;
  return c;
}
/** World angle the given local organelle direction points at after steering settles. */
const faced = (c: Cell, steerA: number, localDir: number) => steerA + localDir;

describe('reference builds', () => {
  it('are legal level-10 layouts', () => {
    for (const [name, orgs] of Object.entries(BUILDS)) {
      const placed: Organelle[] = [];
      for (const org of orgs) {
        expect(checkPlacement(placed, org.type, org.slot, org.tilt, capacityForLevel(10)), `${name} ${org.type}@${org.slot}`).toBeNull();
        expect(org.level).toBeLessThanOrEqual(maxOrganelleLevel(10));
        placed.push(org);
      }
      expect(capacityUsed(placed)).toBeLessThanOrEqual(capacityForLevel(10));
    }
  });
});

describe('layout-aware tactics', () => {
  it('an armored cell with no speed turns its armor toward a close attacker', () => {
    const w = world();
    const me = cell(w, 1000, 0, [o('membrane', REAR)]); // armor on the back
    const foe = cell(w, 1000 + me.stats.radius * 2 + 40, Math.PI, [o('spikes', 0)]);
    const s = evade(w, me, foe);
    // Steering so the rear armor ends up pointing at the attacker (+x).
    expect(Math.abs(angleDiff(faced(me, s.a, Math.PI), 0))).toBeLessThan(0.05);
    expect(s.t).toBeLessThan(0.5);
  });

  it('a rear-spike cell keeps its spikes toward a chaser and brakes to lure it in', () => {
    const w = world();
    const me = cell(w, 1000, Math.PI, [o('spikes', REAR, 2)]);
    const chaser = cell(w, 1000 + me.stats.radius * 2 + 30, Math.PI, [o('spikes', 0)]);
    chaser.vx = -200; // charging at us
    const s = engage(w, me, chaser, { retreatUntil: 0 }, 0.5);
    expect(Math.abs(angleDiff(faced(me, s.a, Math.PI), 0))).toBeLessThan(0.3);
    expect(s.t).toBeLessThan(0.5);
    expect(readLayout(me).rearWeapon).toBe(true);
  });

  it('a flagellum kiter disengages right after landing a hit', () => {
    const w = world();
    const me = cell(w, 1000, 0, BUILDS.Speedster);
    const foe = cell(w, 1000 + me.stats.radius * 2 + 10, Math.PI, [o('membrane', 4)]);
    expect(readLayout(me).kiter).toBe(true);
    foe.lastHitBy = me.id;
    foe.lastHitAt = w.time;
    const st = { retreatUntil: 0 };
    const s = engage(w, me, foe, st, 0.5);
    expect(st.retreatUntil).toBeGreaterThan(w.time);
    expect(Math.abs(angleDiff(s.a, Math.PI))).toBeLessThan(0.5); // running away from +x
  });

  it('attackers swing around armor that faces them', () => {
    const w = world();
    const me = cell(w, 1000, 0, [o('spikes', 0)]);
    const armored = cell(w, 1400, Math.PI, [o('membrane', 0)]); // armor facing us
    const bare = cell(w, 1400, 0, [o('membrane', 0)]); // armor facing away
    const toArmored = engage(w, me, armored, { retreatUntil: 0 }, 0.5);
    const toBare = engage(w, me, bare, { retreatUntil: 0 }, 0.5);
    expect(Math.abs(angleDiff(toBare.a, 0))).toBeLessThan(0.05);
    expect(Math.abs(angleDiff(toArmored.a, 0))).toBeGreaterThan(0.3);
  });

  it('dashes only when the dash would actually fly at the target', () => {
    const w = world();
    // Side flagellum: dash goes sideways, so a bot charging straight ahead must not dash.
    const side = cell(w, 1000, 0, [o('spikes', 0), o('flagellum', 4)]);
    const target = cell(w, 1000 + side.stats.radius * 2 + 40, Math.PI, []);
    for (let i = 0; i < 20; i++) engage(w, side, target, { retreatUntil: 0 }, 1);
    expect(side.dashCd).toBe(0);
    const rear = cell(w, 3000, 0, [o('spikes', 0), o('flagellum', REAR)]);
    const t2 = cell(w, 3000 + rear.stats.radius * 2 + 40, Math.PI, []);
    for (let i = 0; i < 20 && rear.dashCd === 0; i++) engage(w, rear, t2, { retreatUntil: 0 }, 1);
    expect(rear.dashCd).toBeGreaterThan(0);
  });
});

describe('difficulty scaling', () => {
  it('follows the strongest human and stays within 0..1', () => {
    expect(difficultyFor(1, 10)).toBe(0);
    expect(difficultyFor(8, 300)).toBeGreaterThan(difficultyFor(4, 80));
    expect(difficultyFor(30, 3000)).toBe(1);
  });

  it('stronger rooms spawn stronger bots', () => {
    const levels = (d: number) => {
      const w = world();
      w.aiDifficulty = d;
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += spawnAI(w, 'predator').level;
      return sum / 12;
    };
    expect(levels(1)).toBeGreaterThan(levels(0) + 3);
  });
});

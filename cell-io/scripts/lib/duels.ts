/** Duel engine shared by `npm run sim` and the tuner. */
import { TICK_RATE } from '../../shared/constants';
import { mulberry32, TAU } from '../../shared/math';
import { BUILD_NAMES, BUILDS } from '../../shared/sim/builds';
import type { Cell } from '../../shared/sim/cell';
import { refreshStats } from '../../shared/sim/cell';
import { engage, type TacticState } from '../../shared/sim/tactics';
import { World } from '../../shared/sim/world';

const DT = 1 / TICK_RATE;
export const DUEL_SECONDS = 120;
// ------------------------------------------------------------------ duels

function setupDuelist(w: World, name: string, x: number, y: number, heading: number, biomass: number): Cell {
  const c = w.addCell('player', name, biomass);
  c.x = x;
  c.y = y;
  c.heading = heading;
  c.spawnProtect = 0;
  c.level = 10;
  c.organelles = BUILDS[name].map((o) => ({ ...o }));
  c.orgHealth = [];
  refreshStats(c);
  c.hp = c.stats.maxHp;
  c.energy = c.stats.energyMax;
  return c;
}

export type Result = 'a' | 'b' | 'draw';

export function duel(aName: string, bName: string, seed: number): { result: Result; time: number; ko: boolean } {
  const w = new World({ seed, nutrientTarget: 0, crystalTarget: 0, hazards: false });
  w.aiDifficulty = 0.7;
  const r = mulberry32(seed * 7919);
  const ang = r() * TAU;
  const cx = 2400;
  const cy = 2400;
  // Plausible-fight variation: size, distance, skill and reaction time differ per duel.
  const dist = 200 + r() * 300;
  const a = setupDuelist(w, aName, cx - Math.cos(ang) * dist, cy - Math.sin(ang) * dist, r() * TAU, 120 + r() * 60);
  const b = setupDuelist(w, bName, cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r() * TAU, 120 + r() * 60);
  const skillA = 0.4 + r() * 0.5;
  const skillB = 0.4 + r() * 0.5;
  const sa: TacticState = { retreatUntil: 0 };
  const sb: TacticState = { retreatUntil: 0 };
  const limit = DUEL_SECONDS * TICK_RATE;
  let think = 0;
  for (let t = 0; t < limit; t++) {
    if (think-- <= 0) {
      think = 3 + Math.floor(r() * 4); // 6-13 decisions per second, like the AI
      if (a.alive && b.alive) {
        w.aiDifficulty = skillA;
        const ia = engage(w, a, b, sa, skillA);
        w.aiDifficulty = skillB;
        const ib = engage(w, b, a, sb, skillB);
        a.input = { a: ia.a, t: ia.t };
        b.input = { a: ib.a, t: ib.t };
      }
    }
    w.step(DT);
    if (!a.alive || !b.alive) return { result: a.alive ? 'a' : b.alive ? 'b' : 'draw', time: w.time, ko: true };
  }
  const fa = a.hp / a.stats.maxHp;
  const fb = b.hp / b.stats.maxHp;
  return { result: Math.abs(fa - fb) < 0.05 ? 'draw' : fa > fb ? 'a' : 'b', time: w.time, ko: false };
}

export function runDuels(DUELS: number, SEED: number) {
  const names = BUILD_NAMES;
  // wins[a][b] = share of a-vs-b duels a won (draws count half)
  const score: Record<string, Record<string, number>> = {};
  const kos: Record<string, number> = {};
  let totalTime = 0;
  let decisive = 0;
  let count = 0;
  for (const a of names) score[a] = {};
  let seed = SEED * 1000;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const A = names[i];
      const B = names[j];
      let pts = 0;
      for (let k = 0; k < DUELS; k++) {
        // Alternate sides so spawn order never matters.
        const swap = k % 2 === 1;
        const { result, time, ko } = swap ? flip(duel(B, A, ++seed)) : duel(A, B, ++seed);
        pts += result === 'a' ? 1 : result === 'draw' ? 0.5 : 0;
        if (ko) {
          decisive++;
          kos[result === 'a' ? A : B] = (kos[result === 'a' ? A : B] ?? 0) + 1;
        }
        totalTime += time;
        count++;
      }
      score[A][B] = pts / DUELS;
      score[B][A] = 1 - pts / DUELS;
    }
  }
  return { score, kos, avgTime: totalTime / count, decisiveShare: decisive / count };
}

function flip(r: { result: Result; time: number; ko: boolean }) {
  return { time: r.time, ko: r.ko, result: (r.result === 'a' ? 'b' : r.result === 'b' ? 'a' : 'draw') as Result };
}


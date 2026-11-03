/**
 * Coordinate-descent tuner over the main balance knobs. Scales TUNING values
 * in place, re-runs the duel matrix with fixed seeds (common random numbers,
 * so comparisons are fair) and keeps changes that lower the worst matchup.
 * Prints the best multipliers; apply them to shared/organelles.ts by hand.
 *
 *   npx tsx scripts/tune.ts [duelsPerPair=16] [rounds=2]
 */
import { TUNING } from '../shared/organelles';
import { BUILD_NAMES } from '../shared/sim/builds';
import { runDuels } from './lib/duels';

const DUELS = Number(process.argv[2] ?? 16);
const ROUNDS = Number(process.argv[3] ?? 2);
type Arr = number[];
const base = JSON.parse(JSON.stringify(TUNING)) as typeof TUNING;

const knobs: Record<string, (k: number) => void> = {
  spike: (k) => ((TUNING.spikeDmg as Arr) = (base.spikeDmg as Arr).map((v) => v * k)),
  membrane: (k) => ((TUNING.membraneReduction as Arr) = (base.membraneReduction as Arr).map((v) => Math.min(0.8, v * k))),
  regen: (k) => ((TUNING.regenFrac as Arr) = (base.regenFrac as Arr).map((v) => v * k)),
  toxin: (k) => ((TUNING.toxinDps as Arr) = (base.toxinDps as Arr).map((v) => v * k)),
  toxinCd: (k) => (TUNING.toxinCooldown = base.toxinCooldown * k),
  venom: (k) => ((TUNING.venomDps as Arr) = (base.venomDps as Arr).map((v) => v * k)),
  bump: (k) => (TUNING.bumpFactor = base.bumpFactor * k),
  toxinSlow: (k) => (TUNING.toxinSlow = Math.min(0.6, base.toxinSlow * k)),
  cilia: (k) => ((TUNING.ciliaEff as Arr) = (base.ciliaEff as Arr).map((v) => v * k)),
};
const mult: Record<string, number> = Object.fromEntries(Object.keys(knobs).map((k) => [k, 1]));
const apply = () => Object.entries(mult).forEach(([k, v]) => knobs[k](v));

function evaluate() {
  apply();
  const { score } = runDuels(DUELS, 7);
  let worst = 0;
  let sum = 0;
  let n = 0;
  for (const a of BUILD_NAMES) for (const b of BUILD_NAMES) {
    if (a >= b) continue;
    const dev = Math.abs(score[a][b] - 0.5);
    worst = Math.max(worst, dev);
    sum += dev;
    n++;
  }
  return { obj: worst + 0.5 * (sum / n), worst: 0.5 + worst };
}

let best = evaluate();
console.log(`start: worst matchup ${(best.worst * 100).toFixed(0)}%  objective ${best.obj.toFixed(3)}`);
for (let r = 0; r < ROUNDS; r++) {
  for (const k of Object.keys(knobs)) {
    for (const step of [0.8, 1.25]) {
      const old = mult[k];
      mult[k] = Math.max(0.4, Math.min(2.5, old * step));
      const e = evaluate();
      if (e.obj < best.obj - 1e-6) {
        best = e;
        console.log(`  ${k} x${mult[k].toFixed(2)} -> worst ${(e.worst * 100).toFixed(0)}%  objective ${e.obj.toFixed(3)}`);
      } else mult[k] = old;
    }
  }
}
apply();
const final = runDuels(DUELS, 7).score;
for (const a of BUILD_NAMES) console.log(a.padEnd(10), BUILD_NAMES.map((b) => (a === b ? '  - ' : `${Math.round(final[a][b] * 100)}%`.padStart(4))).join(' '));
console.log('\nbest multipliers:', JSON.stringify(Object.fromEntries(Object.entries(mult).map(([k, v]) => [k, Number(v.toFixed(3))]))));
console.log(`worst matchup ${(best.worst * 100).toFixed(0)}%`);

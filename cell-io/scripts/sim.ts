/**
 * Headless balance harness.
 *
 *   npm run sim                       # default: 30 duels per pairing, 8 five-minute FFA matches
 *   npm run sim -- --duels 60 --matches 12 --seed 3 --report docs/balance-report.md
 *
 * 1. Duels: every reference build (shared/sim/builds.ts) fights every other
 *    build 1v1 at level 10 / 150 biomass in an empty arena, using the same
 *    layout-aware tactics the AI uses. A duel ends on a death or after 120 s,
 *    when the higher HP share wins (within 5% is a draw).
 * 2. FFA: five-minute matches in the normal world (hazards, nutrients and the
 *    usual wildlife) with three bots per build that start at level 1 and evolve
 *    toward their build. It reports time to level 2/5/8, average lifespan,
 *    kills per life and who ends each match with the most biomass.
 */
import { writeFileSync } from 'node:fs';
import { TICK_RATE } from '../shared/constants';
import { ORGANELLES, type Organelle } from '../shared/organelles';
import { nearestValidSlot, organelleAngle } from '../shared/placement';
import type { Offer } from '../shared/progression';
import { AI_POPULATION, spawnAI, updateAI, type Archetype } from '../shared/sim/ai';
import { BUILD_NAMES, BUILDS } from '../shared/sim/builds';
import type { Cell } from '../shared/sim/cell';
import { runDuels } from './lib/duels';
import { World } from '../shared/sim/world';

const args = process.argv.slice(2);
const arg = (name: string, d: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const DUELS = arg('duels', 30);
const MATCHES = arg('matches', 8);
const SEED = arg('seed', 1);
const reportIdx = args.indexOf('--report');
const REPORT = reportIdx >= 0 ? args[reportIdx + 1] : null;
const DT = 1 / TICK_RATE;

// ------------------------------------------------------------------- FFA

interface BuildStats {
  lives: number;
  lifeTime: number;
  kills: number;
  reach: Record<number, number[]>;
  topFinishes: number;
  finalBiomass: number;
}

/** Evolve toward the bot's target build: take missing pieces first, then upgrades. */
function evolveToward(w: World, c: Cell, plan: Organelle[]) {
  let guard = 10;
  while (c.pendingEvolutions > 0 && guard-- > 0) {
    const offers = w.openEvolution(c);
    if (!offers) return;
    const have = (t: string) => c.organelles.filter((o) => o.type === t).length;
    const want = (t: string) => plan.filter((o) => o.type === t).length;
    const score = (o: Offer) => {
      if (o.kind === 'new') return have(o.type) < want(o.type) ? 10 - plan.findIndex((p) => p.type === o.type) * 0.5 : 0;
      if (o.kind === 'upgrade') return want(o.type) ? 5 : 1;
      return o.mutation === 'vitality' ? 2 : 1;
    };
    let best = 0;
    offers.forEach((o, i) => {
      if (score(o) > score(offers[best])) best = i;
    });
    const o = offers[best];
    let slot: number | undefined;
    if (o.kind === 'new') {
      const target = plan.filter((p) => p.type === o.type)[have(o.type)] ?? plan.find((p) => p.type === o.type);
      const preferCenter = ORGANELLES[o.type].mount === 'internal' && target?.slot === 0;
      slot = nearestValidSlot(c.organelles, o.type, target ? organelleAngle(target) : 0, preferCenter) ?? undefined;
    }
    if (w.chooseEvolution(c, { index: best, slot, tilt: 0 })) {
      const alt = offers.findIndex((x) => x.kind !== 'new');
      if (alt < 0 || w.chooseEvolution(c, { index: alt })) break;
    }
  }
  w.closeEvolution(c);
}

function runFFA() {
  const stats: Record<string, BuildStats> = {};
  for (const n of BUILD_NAMES) stats[n] = { lives: 0, lifeTime: 0, kills: 0, reach: { 2: [], 5: [], 8: [] }, topFinishes: 0, finalBiomass: 0 };
  const PER_BUILD = 3;
  const MATCH_S = 300;
  for (let m = 0; m < MATCHES; m++) {
    const w = new World({ seed: SEED * 31 + m });
    for (const [arch, n] of Object.entries(AI_POPULATION) as [Archetype, number][]) for (let i = 0; i < n; i++) spawnAI(w, arch);
    const buildOf = new Map<number, string>();
    const reached = new Map<number, Set<number>>();
    const spawn = (name: string) => {
      const c = w.addCell('player', name);
      c.ai = { archetype: 'predator', think: 0, targetId: null, wander: 0, mode: 'graze', chase: 0, rest: 0 };
      buildOf.set(c.id, name);
      reached.set(c.id, new Set());
      stats[name].lives++;
      return c;
    };
    w.onDeath = (c) => {
      const b = buildOf.get(c.id);
      if (b) {
        stats[b].lifeTime += w.time - c.bornAt;
        stats[b].kills += c.kills;
        spawn(b);
      } else if (c.ai) spawnAI(w, c.ai.archetype);
    };
    for (const n of BUILD_NAMES) for (let i = 0; i < PER_BUILD; i++) spawn(n);
    for (let t = 0; t < MATCH_S * TICK_RATE; t++) {
      for (const c of w.cells.values()) {
        if (!c.alive || !c.ai) continue;
        const b = buildOf.get(c.id);
        if (b && c.pendingEvolutions > 0) evolveToward(w, c, BUILDS[b]);
        updateAI(w, c, DT);
      }
      w.step(DT);
      if (t % TICK_RATE === 0) {
        for (const c of w.cells.values()) {
          const b = buildOf.get(c.id);
          if (!b) continue;
          for (const L of [2, 5, 8]) {
            const seen = reached.get(c.id)!;
            if (c.level >= L && !seen.has(L)) {
              seen.add(L);
              stats[b].reach[L].push(w.time - c.bornAt);
            }
          }
        }
      }
    }
    // Censor survivors' lives at the end of the match.
    let top: Cell | null = null;
    for (const c of w.cells.values()) {
      const b = buildOf.get(c.id);
      if (!b) continue;
      stats[b].lifeTime += w.time - c.bornAt;
      stats[b].kills += c.kills;
      stats[b].finalBiomass += c.biomass;
      if (!top || c.biomass > top.biomass) top = c;
    }
    if (top) stats[buildOf.get(top.id)!].topFinishes++;
    process.stdout.write(`  match ${m + 1}/${MATCHES} done\n`);
  }
  return { stats, perBuild: PER_BUILD };
}

// ------------------------------------------------------------------ report

const pct = (v: number) => `${Math.round(v * 100)}%`;
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const fmtS = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)} s` : 'n/a');

console.log(`CELL.IO balance sim: ${DUELS} duels per pairing, ${MATCHES} five-minute FFA matches, seed ${SEED}\n`);
const t0 = performance.now();
const d = runDuels(DUELS, SEED);
const lines: string[] = [];
lines.push('### Duel win rates (row vs column, draws count half)', '');
lines.push(`| | ${BUILD_NAMES.join(' | ')} | Overall |`);
lines.push(`|---|${BUILD_NAMES.map(() => '---').join('|')}|---|`);
let worst = 0;
for (const a of BUILD_NAMES) {
  const cells = BUILD_NAMES.map((b) => (a === b ? '-' : pct(d.score[a][b])));
  const overall = avg(BUILD_NAMES.filter((b) => b !== a).map((b) => d.score[a][b]));
  for (const b of BUILD_NAMES) if (a !== b) worst = Math.max(worst, d.score[a][b]);
  lines.push(`| **${a}** | ${cells.join(' | ')} | ${pct(overall)} |`);
}
lines.push('', `Highest single matchup: **${pct(worst)}**. Duels decided by a kill: ${pct(d.decisiveShare)}; average duel length ${d.avgTime.toFixed(0)} s.`, '');
console.log(lines.join('\n'));
console.log('\nRunning FFA matches...');
const f = runFFA();
const ffa: string[] = [];
ffa.push('### Five-minute FFA matches (3 bots per build, normal world and wildlife)', '');
ffa.push('| Build | Time to L2 | Time to L5 | Time to L8 | Avg lifespan | Kills per life | Avg final biomass | Top-biomass finishes |');
ffa.push('|---|---|---|---|---|---|---|---|');
for (const n of BUILD_NAMES) {
  const s = f.stats[n];
  ffa.push(
    `| **${n}** | ${fmtS(avg(s.reach[2]))} | ${fmtS(avg(s.reach[5]))} | ${fmtS(avg(s.reach[8]))} (${s.reach[8].length}) | ${fmtS(s.lifeTime / s.lives)} | ${(s.kills / s.lives).toFixed(2)} | ${Math.round(s.finalBiomass / (MATCHES * f.perBuild))} | ${s.topFinishes}/${MATCHES} |`,
  );
}
ffa.push('', `(Time to L8 shows in brackets how many lives got there.) Ran in ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
console.log('\n' + ffa.join('\n'));
if (REPORT) {
  writeFileSync(REPORT, [`<!-- generated by npm run sim -- --duels ${DUELS} --matches ${MATCHES} --seed ${SEED} -->`, '', ...lines, ...ffa, ''].join('\n'));
  console.log(`\nWrote ${REPORT}`);
}

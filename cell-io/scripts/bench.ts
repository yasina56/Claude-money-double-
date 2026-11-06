/**
 * Per-tick cost benchmark: one world with N human-like players (driven by the
 * grazer/predator AI so they move and fight) plus the normal bot population.
 * Usage: npx tsx scripts/bench.ts [players=40] [seconds=60]
 */
import { TICK_RATE } from '../shared/constants';
import { World } from '../shared/sim/world';
import { AI_POPULATION, spawnAI, updateAI, type Archetype } from '../shared/sim/ai';

const players = Number(process.argv[2] ?? 40);
const seconds = Number(process.argv[3] ?? 60);
const world = new World({ seed: 42 });
for (const [arch, n] of Object.entries(AI_POPULATION) as [Archetype, number][]) for (let i = 0; i < n; i++) spawnAI(world, arch);
const archs: Archetype[] = ['grazer', 'predator', 'defender', 'prey'];
for (let i = 0; i < players; i++) {
  const c = world.addCell('player', `p${i}`, 20 + (i % 10) * 30);
  c.ai = { archetype: archs[i % 4], think: 0, targetId: null, wander: 0, mode: 'graze', chase: 0, rest: 0 };
}
world.onDeath = (c) => {
  // Keep the population constant: players respawn immediately.
  if (c.kind === 'player') {
    const n = world.addCell('player', c.name);
    n.ai = c.ai;
  }
};
const dt = 1 / TICK_RATE;
const ticks = seconds * TICK_RATE;
const samples: number[] = [];
for (let t = 0; t < ticks; t++) {
  const t0 = performance.now();
  for (const c of world.cells.values()) if (c.ai && c.alive) updateAI(world, c, dt);
  world.step(dt);
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
const pct = (p: number) => samples[Math.floor(samples.length * p)];
console.log(
  `cells=${world.cells.size} nutrients=${world.nutrients.size} ticks=${ticks}  per-tick ms: avg ${avg.toFixed(3)}  p50 ${pct(0.5).toFixed(3)}  p95 ${pct(0.95).toFixed(3)}  p99 ${pct(0.99).toFixed(3)}  budget ${(1000 / TICK_RATE).toFixed(1)}`,
);

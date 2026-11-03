/** Headless balance probe: a greedy grazer bot plays in a full world; prints progression timings. */
import { World } from '../server/world';
import { spawnAI, updateAI, AI_POPULATION, type Archetype } from '../server/ai';
import { autoEvolve } from '../server/ai';

const world = new World({ seed: Number(process.argv[2] ?? 7) });
for (const [arch, n] of Object.entries(AI_POPULATION) as [Archetype, number][]) for (let i = 0; i < n; i++) spawnAI(world, arch);
const bot = world.addCell('player', 'probe');
bot.ai = { archetype: 'grazer', think: 0, targetId: null, wander: 0, mode: 'graze', chase: 0, rest: 0 };
let deaths = 0;
world.onDeath = (c) => { if (c === bot) deaths++; };
const dt = 1 / 40;
const levelTimes: Record<number, number> = {};
let aiDeaths = 0;
const origOnDeath = world.onDeath;
world.onDeath = (c, s) => { origOnDeath(c, s); if (c !== bot) aiDeaths++; };
for (let t = 0; t < 300 / dt; t++) {
  for (const c of world.cells.values()) if (c.ai && c.alive) updateAI(world, c, dt);
  if (bot.pendingEvolutions) autoEvolve(world, bot);
  world.step(dt);
  if (!levelTimes[bot.level]) levelTimes[bot.level] = Math.round(world.time);
  if (!bot.alive) break;
}
console.log('levels reached at (s):', levelTimes);
console.log('bot alive', bot.alive, 'biomass', bot.biomass.toFixed(1), 'radius', bot.stats.radius.toFixed(1), 'organelles', bot.organelles.map(o=>o.type+o.level).join(','));
console.log('ai deaths', aiDeaths, 'cells', world.cells.size, 'nutrients', world.nutrients.size);

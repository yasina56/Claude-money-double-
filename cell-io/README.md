# CELL.IO

A real-time multiplayer browser game about designing your own microorganism. Eat nutrients to grow and level up, then **attach organelles by hand** wherever you want on your cell. Where you put them changes how the cell moves, fights and survives: front spikes ram, rear spikes punish chasers, armor only protects the side it covers, and a flagellum pushes away from wherever it is mounted.

Built with **TypeScript**, **Phaser 3** (rendering), **Node.js + Socket.IO** (authoritative server) and **Vite** (client build). All art is procedural; there are no image or audio assets.

---

## Quick start

```bash
cd cell-io
npm install
npm run dev          # server on :3001 + Vite client on :5173 (proxied websockets)
```

Open **http://localhost:5173**. Open more tabs or browsers to play multiplayer locally.

Production build (single port):

```bash
npm run build        # bundles the client into dist/client
npm start            # serves dist/client and the game on http://localhost:3001 (PORT env to change)
```

Checks:

```bash
npm run typecheck    # tsc --noEmit over client, server, shared and tests
npm test             # vitest: mechanics + a two-client Socket.IO integration test
npm run check        # both
npx tsx scripts/simulate.ts 7   # headless balance probe: bot progression timings
```

Dev cheats: start the server with `CELLIO_DEV=1` and, in the browser console, run `cellioDevXp(500)` (grant XP) or `cellioDevTp()` (jump next to another player). They are disabled unless that variable is set.

## Controls

| Input | Action |
|---|---|
| Mouse | Steer. The cell follows the cursor; the further the cursor, the faster you go. |
| Space | Dash burst (28 energy, 2.6 s cooldown) |
| Q | Toxin cloud (needs a Toxin Gland) |
| E | Open the evolution screen when an evolution is pending |
| M | Mute |
| Evolution screen | Click a card or press **1-4**. Drag or click on the cell to attach. **Wheel / Q / E** tilts surface organelles. **Enter** confirms, **Esc** goes back / closes. |

Touch works through the same pointer path: touch and hold to steer, and the ability buttons are tappable.

## How the game works

### Growth
* **Biomass** sets size and mass: radius = 14 + 2.6·√biomass. Bigger cells have more HP and push harder in collisions, but have lower top speed, acceleration and turning. Above 350 biomass a cell slowly decays, so nobody stays huge forever.
* **Evolution XP** sets your level. Nutrients give 1 XP, glowing **evolution crystals** (mostly on the rims of acid pools) give 8, and kills give a lot.

### Progression

| Level | Unlock |
|---|---|
| 1 | Basic cell |
| 2 | First organelles: Cilia, Spikes, Reinforced Membrane, Mitochondria (capacity 2) |
| 3 | Improved capacity (3) |
| 4 | Second tier: Stinger, Venom Sac, Regeneration Nucleus (capacity 4) |
| 5 | Basic upgrades: organelles can reach level II |
| 7 | Third tier: Flagellum, Toxin Gland (capacity 6) |
| 10 | Advanced tier: four choices per evolution (capacity 8) |
| 15 | Specialized upgrades: organelles can reach level III |
| 20 | Apex: Hyper Burst dash (+25% impulse, 30% shorter cooldown) and +15% max HP |

XP to next level: `30 + 16·(level−1)^1.4` (30, 46, 72, 105, 144, ...). The first evolution takes roughly 30-45 s of grazing. After that, an evolution arrives every 40-70 s during the first five minutes. Every level-up gives one evolution: three random offers (new organelle, upgrade, or a free mutation when nothing else fits).

### The attachment system
* Positions are **normalized**, never in pixels. Surface organelles snap to one of **16 angles** around the membrane (angle 0 = the cell's front/heading). Internal organelles use one of **7 internal slots** (center plus a ring at half radius). Everything is stored relative to the radius, so organelles stay attached while the cell grows and wobbles.
* Surface organelles can be **tilted ±45°** in 15° steps. The reinforced membrane spans 3 snaps.
* Each organelle has a **slot cost** (capacity), a **weight** (soft-capped speed penalty) and an **energy upkeep**, so no build gets everything.
* The server re-validates every placement (`shared/placement.ts`): mount type, slot range, overlap, tilt limits and capacity. Invalid or forged choices are rejected.

The cell's **heading** turns toward the cursor at its turn rate, and thrust depends on the angle between heading and travel direction. Turning ability therefore matters, and so does the layout of the propulsion organelles.

### Organelles and why placement matters

| Organelle | Mount | Effect | Placement rule |
|---|---|---|---|
| **Cilia** | surface, cost 1 | +8 / 15 / 25% movement effectiveness | Pushes *away* from its side (35% of the bonus is omnidirectional). Side cilia add the most turning. Rear = speed, ring = agility. |
| **Spikes** | surface, cost 1 | 11 / 16.5 / 23 contact damage × impact speed × size; barbed (III) adds bleed | Only hits inside the spike's ±22° arc count. Needs real closing speed. |
| **Stinger** | surface, cost 1 | small damage; delivers venom at full potency, even on light touches | Narrow arc; links to a venom sac on the same side |
| **Reinforced Membrane** | surface (3 snaps), cost 2 | −35 / 50 / 62% damage from the covered ~72° arc, +HP | Only the covered side is protected. Heavy. |
| **Mitochondria** | internal, cost 1 | +3 / 5 / 7.5 energy/s, +max energy | Centered (or ringing a centered regen nucleus): +15% regeneration |
| **Venom Sac** | internal, cost 2 | 3 / 4.5 / 6 poison dps per stack (max 3 stacks, 4 s, refreshes); II-III also slow | Must link to a stinger/spike within 70° of its side. A centered sac links to everything at 60%. Spikes deliver at 60%. Each application costs 5 energy. **No delivery, no poison.** |
| **Regeneration Nucleus** | internal, cost 2 | heals 0.8 / 1.2 / 1.7% max HP/s, ×3 out of combat; costs energy | Center slot: +25% |
| **Flagellum** | surface, cost 2 | +35 / 45 / 55% thrust in a narrow cone, −16 / 13 / 10% turning | Thrusts opposite its mount, so a side flagellum is useless for straight-line speed. Tilt to curve. |
| **Toxin Gland** | internal, cost 2 | [Q] cloud 9 / 13 / 17 dps for 4 s, 35 energy, 9 s cooldown | Centered: the cloud surrounds you. Edge: the cloud is projected outward on that side. |

The evolution editor shows these consequences live: hit arcs, armor arcs, thrust arrows, venom link cones and toxin cloud previews, plus a before/after stat table (forward vs sideways speed, turning, armor front/side/rear, spike damage front/rear, venom link, and more).

Example builds (not classes): **Hunter** (front spikes, rear flagellum, front-side venom sac and stinger), **Tank** (membranes, centered regen nucleus, mitochondria), **Speedster** (rear and side cilia clusters, flagellum, mitochondria), **Toxic Defender** (centered toxin gland, membranes, regeneration).

### Combat
On contact the server resolves each side's attack separately:
1. The contact point is converted to each cell's local angle.
2. The attacker's best spike or stinger covering that angle deals `damage × sizeFactor × impact`, where impact grows with closing speed (0.35-2×).
3. The defender's armor covering its own contact angle and its global resistance reduce the damage.
4. Heavier cells also deal blunt bump damage at high closing speed, which is why a small, fast cell can still escape a big one.

Anti-exploit rules:
* No single hit can remove more than 30% of max HP.
* Each pair of cells has a 0.35 s hit cooldown.
* Poison stacks are capped at 3 and refresh instead of stacking.
* New players get 5 s of spawn protection and spawn far from larger armed cells. AI predators ignore level 1-2 players and tire after a 7 s chase.
* Evolution protection (12 s, −70% damage, 45% speed, no damage dealt) is granted only once per pending evolution.

Dead cells burst into nutrients (plus a crystal at level 4+). The killer receives 35% of the victim's biomass and bonus XP.

### World
4800×4800 arena with nutrient blooms that drift over time, **acid pools** (damage over time, crystals on the rims) and **currents** (flow fields that push cells). AI organisms keep the arena alive even with one player:
* **Prey**: tiny, flee everything.
* **Grazers**: passive nutrient collectors.
* **Predators**: front spikes and flagellum. They hunt cells their size or smaller, lead their targets and dash in.
* **Defenders**: armored, toxin clouds against anything that hugs them.

AI cells use exactly the same movement, combat and evolution code as players, including server placement validation.

## Architecture

```
cell-io/
  shared/            pure game rules used by both sides
    constants.ts     world size, tick rates, tuning, radius and camera-zoom formulas
    organelles.ts    organelle catalogue + per-level tuning numbers
    placement.ts     normalized attachment slots, validation, capacity
    stats.ts         derives the full stat block from organelle layout (thrust, armor arcs, deliveries, venom links, toxins)
    progression.ts   XP curve, unlock tiers, evolution offer generation
    protocol.ts      Socket.IO event types and compact snapshot layout
    math.ts          angles, soft caps, seeded RNG
  server/
    index.ts         HTTP static server + Socket.IO bootstrap
    room.ts          Room (fixed 40 Hz loop, per-client area-of-interest snapshots at 20 Hz, input validation) and RoomManager (matchmaking)
    world.ts         authoritative simulation: movement, nutrients, collisions, directional combat, DoT, hazards, evolution, deaths
    ai.ts            AI archetypes, behaviour and auto-evolution
    cell.ts          Cell entity + stat refresh
    spatial.ts       uniform grid for nutrient queries
  client/
    index.html, style.css   menu, HUD, evolution screen, death screen (DOM)
    src/main.ts      wiring: Phaser game, screens, keyboard, auto-open evolution
    src/net.ts       socket client, snapshot buffer and interpolation
    src/GameScene.ts Phaser scenes: parallax background, world, cells, nutrients, hazards, clouds, particles, camera, input
    src/art.ts       procedural cell/organelle renderer behind a Painter interface (Phaser Graphics or Canvas 2D)
    src/evolutionUI.ts  offer cards + drag-and-drop placement editor with live stat preview
    src/hud.ts       bars, organelle chips, abilities, leaderboard, kill feed, minimap
    src/audio.ts     WebAudio synthesized sound effects
  tests/             vitest suites
  scripts/simulate.ts  headless balance probe
```

**Networking model**
* Clients send only intent: an input angle and throttle (rate-limited), ability presses and evolution choices. The server owns positions, health, collisions, damage, nutrients and upgrades, so speed hacks and impossible placements have nothing to exploit.
* Snapshots are flat number arrays for every cell in the client's view: position, heading, radius, HP fraction, status flags, velocity. Cell layouts (`CellInfo`) are sent only when a cell first appears or its organelles change. Visible nutrients are resent at 10 Hz.
* The client renders other cells ~110 ms in the past and interpolates between snapshots. Your own cell is extrapolated from the newest snapshot and smoothed, for responsiveness.
* `RoomManager.assign()` is the single place that picks a room (up to 40 humans each), so matchmaking, regions or private rooms can be added there.

## Known limitations and next steps
* **No client-side prediction** for your own cell beyond velocity extrapolation. Full prediction plus reconciliation can reuse `shared/stats.ts`, since the movement formula is deterministic.
* Cell-cell collision is O(n²) per room. That is fine for ~70 cells; move cells into `SpatialGrid` for bigger rooms.
* JSON over Socket.IO. A binary encoding of the flat arrays would cut bandwidth further.
* Internal organelles are never damaged individually. A natural next step is organelle HP, so hits on a side can disable what is mounted there.
* Balance numbers live in `shared/organelles.ts` (`TUNING`) and `shared/constants.ts`; `scripts/simulate.ts` helps check pacing after changes.

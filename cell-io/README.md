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

Solo static build (no backend: the shared simulation and a local Room run inside the page):

```bash
npm run build:solo   # dist/solo, host anywhere as static files (build:offline is an alias)
```

Checks:

```bash
npm run typecheck    # tsc --noEmit over client, server, shared, tests and scripts
npm test             # vitest: mechanics, netcode, soft body, Socket.IO integration
npm run smoke        # boots the real server, connects 4 clients, steers, evolves, checks acks/deltas/health
npm run check        # all three
npm run bench -- 40 60          # per-tick cost with 40 players + bots for 60 simulated seconds
npm run sim                     # balance harness: duel matrix of the reference builds + 5-minute FFA matches
npx tsx scripts/tune.ts 24 2    # coordinate-descent tuner over the main TUNING knobs (prints suggested multipliers)
npx tsx scripts/simulate.ts 7   # headless balance probe: bot progression timings
```

Dev cheats: start the server with `CELLIO_DEV=1` and, in the browser console, run `cellioDevXp(500)` (grant XP) or `cellioDevTp()` (jump next to another player). They are disabled unless that variable is set.

## Deploy

**Server on Render (free tier)**
1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. Render reads [`render.yaml`](../render.yaml) at the repo root: a Docker web service built from [`cell-io/Dockerfile`](Dockerfile), free plan, health check on `/health`.
3. Render injects `PORT`; the server listens on it. Your server URL looks like `https://cell-io.onrender.com`.

Free Render services sleep when idle, so the first visit can take 30-60 s while it wakes. The menu says so.

Run the same image anywhere:

```bash
docker build -t cell-io cell-io
docker run -p 3001:3001 cell-io          # PORT defaults to 3001
# Docker Hub rate-limited? use the official image from AWS's mirror:
docker build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine -t cell-io cell-io
```

The image is two-stage: build stage `npm ci` + `npm run build`; runtime stage production dependencies only plus `dist/client`, `shared/` and `server/`. It runs as the unprivileged `node` user and has a Docker `HEALTHCHECK` on `/health`.

**Solo build on GitHub Pages + "Play online"**
* `VITE_SERVER_URL` (build-time env var) tells the client where the game server is. The solo build then shows a **Play online with others** link that reloads with `?online` and connects there (the server allows cross-origin Socket.IO). Without it, the solo build is single-player only.
* [`.github/workflows/cellio.yml`](../.github/workflows/cellio.yml) runs `npm ci`, typecheck, tests and the smoke test on every push and pull request that touches `cell-io/`. On the default branch it then builds the solo version with `VITE_SERVER_URL` from the repository variable `CELLIO_SERVER_URL` and deploys it to GitHub Pages.
* One-time setup:
  1. **Settings → Pages → Source: GitHub Actions.**
  2. Optionally, **Settings → Secrets and variables → Actions → Variables → `CELLIO_SERVER_URL`** = your Render URL.

## Controls

| Input | Action |
|---|---|
| Mouse | Steer. The cell follows the cursor; the further the cursor, the faster you go. |
| Space | Dash burst (28 energy, 2.6 s cooldown). Fires along your propulsion layout (see below). |
| Q | Toxin cloud (needs a Toxin Gland); venom surge if you have a linked Venom Sac and no gland |
| R | Venom surge (needs a Venom Sac linked to a stinger or spike) |
| E | Open the evolution screen when an evolution is pending |
| M | Mute |
| F3 | Network debug overlay: ping, snapshot rate, interpolation buffer, prediction error, nutrient delta rate |
| Evolution screen | Click a card or press **1-4**. Drag or click on the cell to attach. **Wheel / Q / E** tilts surface organelles. **Enter** confirms, **Esc** goes back / closes. |

**Touch:** put a finger anywhere on the left two-thirds of the screen and a virtual joystick appears under it. Drag to steer (distance = speed). Ability buttons are tappable. Phones and tablets automatically get a lighter quality tier.

**Settings** (gear button, or "Settings" on the menu): mute, music volume, effects volume, show names, reduce effects (fewer particles, no screen shake) and "play the tutorial again". They are stored in your browser.

## First play and feedback

* **Tutorial (about 60 s, first play only).** A step panel walks you through eating 8 nutrients, reaching level 2, attaching an organelle and dashing. Each step ticks off from real game events, and **Skip tutorial** is always there. The server gives a tutorial cell double nutrient XP until level 2. It honors this once per connection, for a fresh level-1 cell only, so a client cannot farm it.
* **Kill feed** with the cause ("Didinium spiked Bob", "gassed", "poisoned", ...). **Damage numbers** float off every hit.
* **"Killed by" camera:** when someone kills you, the server keeps streaming your view around the killer for 3 s and the camera follows them before the death screen.
* **Threat arrows:** red (armed) or yellow (just bigger) arrows on the screen edge point at dangerous cells just off-screen. Bigger threats get bigger arrows.
* **Audio:** generative ambient music (a slow minor-key pad plus sparse pentatonic plucks through a delay, all WebAudio), and sounds that follow your layout. A flagellum dash whooshes, a cilia dash flutters, your spikes connecting crunch, and organelles breaking crack.

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
| **Cilia** | surface, cost 1 | +9 / 17 / 28% movement effectiveness | Pushes *away* from its side (35% of the bonus is omnidirectional). Side cilia add the most turning. Rear = speed, ring = agility. |
| **Spikes** | surface, cost 1 | 11.5 / 17.5 / 24 contact damage × impact speed × size; barbed (III) adds bleed | Only hits inside the spike's ±22° arc count. Needs real closing speed. |
| **Stinger** | surface, cost 1 | small damage; delivers venom at full potency, even on light touches | Narrow arc; links to a venom sac on the same side |
| **Reinforced Membrane** | surface (3 snaps), cost 2 | −34 / 47 / 56% damage from the covered ~72° arc, +HP | Only the covered side is protected. Heavy. |
| **Mitochondria** | internal, cost 1 | +3 / 5 / 7.5 energy/s, +max energy | Centered (or ringing a centered regen nucleus): +15% regeneration |
| **Venom Sac** | internal, cost 2 | 2.8 / 4.2 / 5.6 poison dps per stack (max 3 stacks, 4 s, refreshes); II-III also slow | Must link to a stinger/spike within 70° of its side. A centered sac links to everything at 60%. Spikes deliver at 60%. Each application costs 5 energy. **No delivery, no poison.** |
| **Regeneration Nucleus** | internal, cost 2 | heals 0.5 / 0.75 / 1.1% max HP/s, ×3 out of combat; costs energy | Center slot: +25% |
| **Flagellum** | surface, cost 2 | +35 / 45 / 55% thrust in a narrow cone, −16 / 13 / 10% turning | Thrusts opposite its mount, so a side flagellum is useless for straight-line speed. Tilt to curve. |
| **Toxin Gland** | internal, cost 2 | [Q] cloud 10 / 13.5 / 17 dps for 6 s, slows 20%, shoves enemies inside it outward on release, 35 energy, 13 s cooldown. Overlapping clouds from one owner do not stack | Centered: the cloud surrounds you. Edge: the cloud is projected outward on that side. |

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
* Evolution protection (−70% damage, 45% speed, no damage dealt) is granted once per pending evolution. It lasts at most 8 s and ends the moment you steer while the editor is open. The menu cannot open within 1.5 s of taking or dealing damage: it is queued ("Evolution queued: get out of combat") and opens on its own once you disengage. The server enforces all of this.

### Organelle damage (protect your weapon side)
Spikes, stingers and reinforced membranes have their own integrity (scaled by cell size; see `shared/integrity.ts`). Every hit is resolved at a contact angle, and that angle decides what gets hurt:
* A **membrane** covering the struck side soaks 80% of the hit's raw damage into its own integrity, on top of reducing what reaches your HP.
* **Spikes or stingers** pointing at the struck side clash and take 45%. Weapons pointing elsewhere are untouched.
* Weapons that ram **armor** chip by half of the damage the armor blocked.
* A broken organelle contributes nothing (no hit arc, no armor, no weight) and regrows after **12 s**. Damaged ones heal 4% per second out of combat.
* Clients see three crack stages: hairline cracks, deep cracks with a bruised tint, then a regrowing stub (or loose shards for a membrane). A crunch plays when something breaks.

So a front-spike hunter that keeps ramming armored fronts will lose its spikes. Turning your armor toward a rammer, or hiding your weapon side, is a real choice.

### Venom surge
With a Venom Sac linked to a stinger or spike, **R** (or **Q** without a Toxin Gland) costs 25 energy and has a 10 s cooldown. For 3 s every linked hit injects double poison (two stacks per hit instead of one), with no per-hit energy cost. Poison still caps at 3 stacks. The weapons glow purple while it is active.

### Directional dash
The dash fires along your net propulsion vector (the sum of every cilia and flagellum push, relative to your heading). Stronger propulsion dashes up to 50% harder:
* A rear flagellum dashes straight ahead, whatever you are steering at.
* A side flagellum gives a sideways dodge.
* If the layout cancels out (an even ring of cilia, or no propulsion), the dash follows your steering, as before.

The rule lives in `shared/sim/movement.ts`, so client prediction replays dashes exactly.

### Strategy badges
Every cell shows a badge under its name, read from its layout by `shared/strategy.ts`: **Hunter**, **Tank**, **Speedster**, **Toxic** or **Hybrid** (no clear leader). Placement counts: front spikes say Hunter, rear spikes count toward Tank, and only a rear-mounted flagellum counts as a sprint build.

Dead cells burst into nutrients (plus a crystal at level 4+). The killer receives 35% of the victim's biomass and bonus XP.

### World
4800×4800 arena with nutrient blooms that drift over time, **acid pools** (damage over time, crystals on the rims) and **currents** (flow fields that push cells). AI organisms keep the arena alive even with one player:
* **Prey**: tiny, flee everything.
* **Grazers**: passive nutrient collectors.
* **Predators**: front spikes and flagellum. They hunt cells their size or smaller, lead their targets and dash in.
* **Defenders**: armored, toxin clouds against anything that hugs them.

AI cells use exactly the same movement, combat and evolution code as players, including server placement validation.

**Layout-aware tactics** (`shared/sim/tactics.ts`). When a bot hunts or is threatened up close, it reads its own layout (best weapon, best armor, net propulsion) and the target's:
* It points its weapon side at the target. Rear-spike cells turn away from a chaser and brake so it runs onto the spikes.
* Armored cells without speed turn their plates toward an attacker.
* Flagellum and cilia kiters hit and run. Bots only dash when the (directional) dash would actually fly toward or away from the target.
* It swings around armor that faces it to hit an exposed side.
* It hovers outside a toxin gland that is ready to fire, then strikes while it is on cooldown, and steers out of enemy clouds unless it is about to land an aimed hit.
* It fires venom surges before aligned hits and toxin clouds at close range.

**Difficulty** follows the strongest human in the room: `difficultyFor(level, biomass)`, 0-1, updated every second. It rises quickly and eases off slowly after that player dies. Higher difficulty means faster reactions (decision interval 0.32 s down to 0.14 s), longer chases and shorter rests, more dashing, earlier cloud avoidance, and stronger spawns (predators and defenders up to +5 levels). `/health` reports each room's current difficulty.

## Balance

`npm run sim` plays the five reference builds in `shared/sim/builds.ts` (Hunter, Tank, Speedster, Toxic, Bruiser) against each other.
* **Duels:** randomized size, distance, bot skill and reaction time, up to 120 s each. Kills win; otherwise the higher HP share wins.
* **FFA:** five-minute free-for-all matches in the normal world with bots that grow toward each build from level 1. Reports time to level, lifespan and kills.

Add `--report <file>` to write the tables as Markdown.

The current numbers were tuned so every build's overall duel win rate stays between about 43% and 56% (seed 1: Hunter 52%, Tank 55%, Speedster 43%, Toxic 46%, Bruiser 55%). Method, before/after tables and the strongest remaining counter (Bruiser beats Toxic 72-82% of the time) are in [`docs/balance-report.md`](docs/balance-report.md). Raw output is in [`docs/balance-sim.md`](docs/balance-sim.md).

## Architecture

```
cell-io/
  shared/            all game rules; used by the server, the solo build and the client predictor
    constants.ts     world size, tick rates, tuning, radius and camera-zoom formulas
    organelles.ts    organelle catalogue + per-level tuning numbers
    placement.ts     normalized attachment slots, validation, capacity
    stats.ts         derives the full stat block from organelle layout (thrust, armor arcs, deliveries, venom links, toxins)
    progression.ts   XP curve, unlock tiers, evolution offer generation
    protocol.ts      Socket.IO event types and compact snapshot layout
    math.ts          angles, soft caps, seeded RNG
    sim/world.ts     authoritative simulation: nutrients, collisions, directional combat, DoT, hazards, evolution, deaths
    sim/movement.ts  movement + dash integration, shared by World and the client predictor
    sim/ai.ts        AI archetypes, behaviour and auto-evolution
    sim/cell.ts      Cell entity + stat refresh
    sim/spatial.ts   uniform grid (nutrients; cells rebuilt every tick)
  server/            networking only
    index.ts         HTTP static server + /health + Socket.IO bootstrap
    room.ts          Room (40 Hz loop, per-client area-of-interest snapshots at 20 Hz, input + seq validation, nutrient deltas) and RoomManager (matchmaking)
  client/
    index.html, style.css   menu, HUD, evolution screen, death screen (DOM)
    src/main.ts      wiring: Phaser game, screens, keyboard, auto-open evolution
    src/net.ts       socket client, snapshot buffer, interpolation, nutrient deltas, network stats
    src/predict.ts   client-side prediction and reconciliation for your own cell
    src/solo.ts      in-memory socket pair that runs a Room in the page (solo build)
    src/softbody.ts  spring-ring membrane that reacts to turning, acceleration and hits
    src/GameScene.ts Phaser scenes: parallax background, world, cells, nutrients, hazards, clouds, particles, camera, input
    src/art.ts       procedural cell/organelle renderer behind a Painter interface (Phaser Graphics or Canvas 2D)
    src/evolutionUI.ts  offer cards + drag-and-drop placement editor with live stat preview
    src/hud.ts       bars, organelle chips, abilities, leaderboard, kill feed, minimap
    src/audio.ts     WebAudio synthesized sound effects
  tests/             vitest suites
  scripts/           smoke.ts (end-to-end server check), bench.ts (tick cost), simulate.ts (pacing probe)
```

**Networking model**
* Clients send only intent: an input angle and throttle (rate-limited), ability presses and evolution choices. The server owns positions, health, collisions, damage, nutrients and upgrades, so speed hacks and impossible placements have nothing to exploit.
* Snapshots are flat number arrays for every cell in the client's view: position, heading, radius, HP fraction, status flags, velocity. Cell layouts (`CellInfo`) are sent only when a cell first appears or its organelles change.
* **Nutrient deltas.** The server remembers which nutrients each client has. At 10 Hz it sends only records entering the view (`nAdd`: id, x, y, kind) and ids leaving it or eaten (`nDel`). `nFull` resets the set after a (re)spawn. A test checks that the client's rebuilt set equals the server's record. In a browser session this was about 20-60 records/s instead of roughly 1,200-1,800/s (120-180 visible nutrients resent 10 times a second).
* **Client-side prediction.** Every `input` carries an increasing `seq`, and the server ignores stale or replayed ones. Your private state returns your exact body, the last applied `ack` and `ackAge` (how long that input has been running on the server). The client steps your cell every frame with the same `shared/sim/movement.ts` code the server uses, including a predicted dash. On each snapshot it rewinds to the server body, replays the unacknowledged inputs (plus the unapplied tail of the acked one) and turns any mismatch into an offset that fades over ~120 ms. Mismatches larger than 160 px snap. Collisions are not predicted, so bumps arrive as smooth corrections. Tests cover exact agreement with zero latency, small corrections at 75 ms one-way latency, and dash replay.
* Other cells are rendered ~110 ms in the past and interpolated between snapshots.
* **Spatial grid.** `World` rebuilds a 240 px cell grid every tick. Collisions, toxin clouds and AI perception query it (`cellsNear`) instead of scanning every cell; nutrients already had their own grid. `npm run bench` (one process, simulated time):

  | Cells in room | Before (O(n²)) avg / p99 | After (grid) avg / p99 |
  |---|---|---|
  | ~62 (40 players + bots) | 0.27 / 1.01 ms | 0.27 / 1.10 ms |
  | ~171 (150 players + bots) | 1.14 / 3.62 ms | 0.98 / 3.86 ms |
  | ~414 (400 players + bots) | 4.23 / 11.8 ms | 2.46 / 10.5 ms |

  The tick budget is 25 ms. At the 40-player cap the cost is dominated by movement, nutrient pickup and AI, not pair checks. The grid pays off as rooms grow.
* `RoomManager.assign()` is the single place that picks a room (up to 40 humans each), so matchmaking, regions or private rooms can be added there.

## Known limitations and next steps
* Prediction covers movement and dash, not collisions or currents' interaction with other cells; those reconcile smoothly.
* **Performance.** Membrane detail scales with on-screen size (44/32/20/12 points; 36/24/16/10 on touch devices). Tiny cells skip the soft-body simulation and decoration. Cells outside the view build no geometry. The particle budget shrinks when zoomed out, on touch devices and with reduce-effects. The DOM HUD and threat overlay refresh at 10-15 Hz. Measured with Pixel 5 emulation in a GPU-less sandbox: our JavaScript costs about 3.7 ms per frame (down from about 4.4 ms). Most of the remaining frame time there is software rasterization, which a phone's GPU handles. A 3-4x slower phone CPU puts the JavaScript at roughly 11-15 ms per frame, inside the 16.7 ms budget for 60 fps. This is an estimate, not a measurement on real hardware.
* JSON over Socket.IO. A binary encoding of the flat arrays would cut bandwidth further.
* Internal organelles are never damaged individually. A natural next step is organelle HP, so hits on a side can disable what is mounted there.
* Balance numbers live in `shared/organelles.ts` (`TUNING`) and `shared/constants.ts`; `scripts/simulate.ts` helps check pacing after changes.

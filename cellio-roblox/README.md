# CELL.IO for Roblox

A Roblox port of [CELL.IO](../cell-io/README.md): grow a microscopic cell, level up, and **attach organelles by hand** where you want them. Placement changes how you move and fight: front spikes ram, rear spikes punish chasers, armor only covers its side, and a flagellum pushes away from where it sits (and your dash follows it).

## Play it in Roblox Studio

**Fastest:** open `CellIO.rbxlx` in Roblox Studio (File → Open from File), then press **Play**. For multiplayer, use **Test → Clients and Servers** with 2+ players. To put it online, use **File → Publish to Roblox**.

**With Rojo** (to keep editing the source in your own editor):

```bash
rojo serve          # then connect from the Rojo plugin in Studio
rojo build -o CellIO.rbxlx
```

No Rojo? Rebuild the place file with the included script (Python 3, no dependencies):

```bash
python3 tools/build_rbxlx.py      # writes CellIO.rbxlx from src/
python3 tools/check_luau.py src   # quick block-balance / syntax sanity check
```

## Controls

| Input | Action |
|---|---|
| Mouse (or hold a finger on the screen) | Steer; distance from your cell = speed |
| Space | Dash (follows your flagellum/cilia layout) |
| Q | Toxin cloud (Toxin Gland); venom surge if you have a linked Venom Sac and no gland |
| R | Venom surge (Venom Sac linked to a stinger or spike) |
| E | Evolve (also opens on its own once you are out of combat) |

Ability buttons at the bottom of the screen are tappable on phones and tablets.

**Evolution:** pick one of 3-4 cards. For a new organelle, click a snap point on the cell preview (rim = surface, inside = internal). Tilt surface organelles with ⟲ / ⟳, check the before/after stat table, and press **Confirm**. The server validates every placement.

## How it is built

| Roblox location | Source | What it does |
|---|---|---|
| `ReplicatedStorage.Shared` | `src/shared/` | Game rules shared by both sides: `Organelles` (catalogue + tuning), `Placement` (16 surface + 7 internal normalized slots, validation), `Stats` (layout → thrust, armor arcs, hit arcs, venom links, toxins), `Progression` (XP curve, unlocks, offers), `Movement` (steering + directional dash), `Strategy` (Hunter/Tank/... badge), `Config`, `MathUtil` |
| `ServerScriptService.Server` | `src/server/` | Authoritative simulation at 30 Hz (`World`: nutrients on a spatial grid, collisions, directional combat, organelle damage and regrowth, poison, toxin clouds with knockback, evolution, kills) and bots (`AI`: four archetypes, auto-evolving builds, layout-aware tactics, difficulty that follows the strongest player). The entry script owns the remotes, validates and rate-limits every client message, and sends each player a snapshot of only what they can see at 15 Hz, with nutrient deltas |
| `StarterPlayerScripts.Client` | `src/client/` | `Net` (snapshot buffer, ~120 ms interpolation, nutrient deltas), `Renderer` (cells built from parts: translucent disc + neon rim, spikes from mirrored wedges, plated membranes, waving cilia, swimming flagellum, glowing internal organelles, crack/broken states, labels with strategy badges, nutrients, clouds, particles, damage numbers), `UI` (menu, HUD, leaderboard, kill feed, evolution placement editor, death screen) and the entry script (top-down camera, input, wiring) |

**Security** (following Roblox best practice, "assume every client is compromised"):
* Clients send only intent: a steering angle and throttle, ability keys and evolution choices.
* The server type-checks and clamps every argument, rate-limits each remote with a token bucket, re-validates every placement and upgrade with the shared rules, and owns all health, damage, XP and growth.
* Player names go through `TextService` filtering.
* Players have no avatar (`CharacterAutoLoads = false`), so there is no client-owned physics to exploit.

**Same balance as the web version.** Simulation units are the web version's pixels, rendered at `0.1` studs per unit, so all tuned numbers carry over unchanged.

## Differences from the web version

* No client-side prediction yet: your own cell is interpolated like everyone else's, about 120 ms behind. `Shared.Movement` is already shared, so prediction can be added the same way as on the web.
* No soft-body membrane, tutorial, settings panel, music or threat arrows yet.
* One arena per Roblox server (Roblox handles matchmaking across servers). The default player cap is the place's Max Players setting.
* Organelles are built from simple parts. Swapping in meshes is a renderer-only change.

## Status

Written without access to Roblox Studio or a Luau runtime. It's a line-by-line port of the TypeScript rules, which have 60 tests on the web side, plus checks run here:
* Block balance on every file.
* Every cross-module call resolves to a defined function.
* Remote names match between client and server.
* The spike wedge geometry was verified numerically.

The first Studio run is the real test. If anything errors, the Output window shows the script and line, and fixes should be small.

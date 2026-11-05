# Balance report (Phase C)

Produced with `npm run sim` (`scripts/sim.ts`) and `scripts/tune.ts`. The raw tables from the final run are in [`balance-sim.md`](balance-sim.md). Regenerate them with:

```bash
npm run sim -- --duels 100 --matches 10 --seed 1 --report docs/balance-sim.md
```

## Method

* **Builds.** Five reference level-10 layouts in `shared/sim/builds.ts`, each using the full 8 capacity with level-II organelles. A test checks that every placement is legal.
  * **Hunter:** two front spikes, front stinger, front venom sac, rear flagellum, one cilia.
  * **Tank:** front and rear membranes, centered regen nucleus, one spike, mitochondria.
  * **Speedster:** four rear and side cilia, rear flagellum, two front spikes.
  * **Toxic:** centered and front toxin glands, front membrane, regen nucleus. This is the Toxic Defender from the design.
  * **Bruiser:** front spike, rear membrane, centered toxin gland, two side cilia, mitochondria.
* **Duels.** Every pairing is played 100 times in an empty arena. Both sides are driven by the same layout-aware tactics the in-game bots use, so the layout is the only difference.
  * Each duel randomizes both cells' biomass (120-180), the starting distance, each side's bot skill (difficulty 0.4-0.9) and reaction time.
  * A duel ends on a kill, or after 120 s by HP share. Within 5% is a draw, and a draw counts as half a win.
  * The randomization matters. With identical starts, the same small edge decided every duel and every matchup read 0% or 100%.
* **Target.** I read "no build wins more than ~60% of matchups" as each build's *overall* win rate across its four opponents staying at or below about 60%. Single pairings may be lopsided: hard counters are healthy, as long as no build beats the field.
* **FFA.** Ten 5-minute matches in the normal world (hazards, nutrients, the usual wildlife), with three bots per build. They start at level 1, evolve toward their build, and respawn on death. This measures pacing and survival, not who wins a fight. In 5 minutes nobody reaches level 8, so the FFA covers the early game and the duels cover full builds.

## Starting point

The first reliable matrix, after fixing two harness bugs (kill detection and a missing Toxic plan) and adding the variation above:

| Build | Overall | Worst pairing |
|---|---|---|
| Tank | 78% | beat Speedster and Bruiser 100% |
| Hunter | 60% | |
| Bruiser | 48% | |
| Speedster | 43% | |
| Toxic | 21% | lost to Speedster and Bruiser 100% |

## What changed and why

Most of the imbalance came from behavior, not numbers. Bots with these layouts did things no sensible player would, so I fixed the tactics first and then used `scripts/tune.ts` (coordinate descent over the main `TUNING` knobs, fixed seeds) plus 80-100-duel checks for the numbers.

**Behavior and rules (in `shared/`)**
1. Bots steer out of enemy toxin clouds unless their weapon is actually aimed at the target. They used to sit in clouds.
2. Bots read the target's layout. They swing around armor that faces them, and they hover outside a ready toxin gland, then strike while it is on cooldown. They do not hover when the enemy is charging weapon-first, which was getting them rammed.
3. Toxin users release the cloud at the gland's real reach on the attacker's path. When an attacker is already closing, they hold armor-first instead of charging into its spikes.
4. Same-owner toxin clouds no longer stack (a cell takes the strongest one per owner), like the poison stack cap. Clouds slow by 20%.
5. Venom surge gives two stacks per hit, as specified ("double poison"), but no longer also doubles damage per second.

**Numbers (`shared/organelles.ts`, `shared/stats.ts`, `shared/integrity.ts`)**

| Knob | Before | After |
|---|---|---|
| Spike damage I/II/III | 11 / 16.5 / 23 | 11.5 / 17.5 / 24 |
| Membrane reduction I/II/III | 35 / 50 / 62% | 34 / 47 / 56% |
| Regeneration (in combat) I/II/III | 0.8 / 1.2 / 1.7% max HP/s | 0.5 / 0.75 / 1.1% |
| Venom dps per stack I/II/III | 3 / 4.5 / 6 | 2.8 / 4.2 / 5.6 |
| Toxin dps I/II/III | 9 / 13 / 17 | 10 / 13.5 / 17 |
| Toxin cloud duration | 4 s | 6 s |
| Toxin release knockback | none | 380 px/s at the centre, less for heavy cells |
| Toxin cooldown | 9 s | 13 s |
| Toxin slow | none | 20% |
| Centered gland extra reach | 0.9 radii | 0.4 radii |
| Cilia effectiveness I/II/III | 8 / 15 / 25% | 9 / 17 / 28% |
| Side-cilia turning bonus | 0.4 + 0.9·sin | 0.3 + 0.6·sin |
| Weapon chip on armor | 50% of blocked | 30% |

The Speedster reference build swapped its mitochondria for a second front spike. A one-spike runner has no way to win a duel, so the matrix was measuring the build, not the organelles.

## Result

Overall duel win rate per build (100 duels per pairing):

| Build | Seed 1 | Seed 2 |
|---|---|---|
| Hunter | 52% | 52% |
| Tank | 55% | 56% |
| Speedster | 43% | 45% |
| Toxic | 46% | 43% |
| Bruiser | 55% | 55% |

No build beats the field by more than ~56%. Full matrices are in [`balance-sim.md`](balance-sim.md).

## Remaining issues

* **Bruiser still beats Toxic (72-82%), down from 88-93%.** Toxic has no melee weapon. Bruiser waits out its gland cooldown, then rams a side its single front membrane does not cover. Two follow-up changes helped:
  * Clouds now linger 6 s instead of 4 s, so the zone is harder to wait out.
  * Releasing a cloud now knocks enemies inside it outward. This barely changes bot duels, since bots already avoid ready glands, but it gives a human an answer to a rammer.

  Every other pairing is 35-65%. A Toxic variant with a stinger would be the next thing to try.
* **Speedster sits low in duels (43%) but is the best FFA survivor.** It has the longest average lifespan and the most top-biomass finishes. That fits its design: it runs rather than brawls.
* **About half of duels end without a kill**, decided on HP share after 120 s. Regeneration and armor make 1v1 fights slow, which is intended (no instant kills), but it means the matrix partly measures sustain.
* **Bot skill.** The harness uses the in-game bot tactics. A skilled human will play every build better than the bots, especially Speedster and Hunter, which reward timing.

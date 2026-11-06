/**
 * Levels, XP curve and evolution offers.
 *
 *  L2  first organelles (cilia, spikes, membrane, mitochondria), capacity 2
 *  L3  improved capacity (3)
 *  L4  second unlock tier (stinger, venom sac, regeneration nucleus)
 *  L5  basic upgrades (organelles can reach level 2)
 *  L7  third unlock tier (flagellum, toxin gland)
 *  L10 advanced evolution tier: four choices per evolution
 *  L15 specialized upgrades (organelles can reach level 3)
 *  L20 apex: Hyper Burst dash (stronger, faster cooldown) and +15% max HP
 */
import { ORGANELLES, ORGANELLE_TYPES, type Organelle, type OrganelleType } from './organelles';
import { capacityForLevel, capacityUsed, validSlots } from './placement';

export const MAX_LEVEL = 30;

/**
 * XP needed to go from `level` to `level + 1`. L1 to L2 is 30 XP (roughly
 * 30-45 s of grazing); then 46, 72, 105, 144 ... so a new evolution lands
 * every 40-70 s during the first five minutes.
 */
export function xpToNext(level: number): number {
  return Math.round(30 + 16 * Math.pow(level - 1, 1.4));
}

export function maxOrganelleLevel(level: number): number {
  return level >= 15 ? 3 : level >= 5 ? 2 : 1;
}

export function offerCount(level: number): number {
  return level >= 10 ? 4 : 3;
}

export const APEX_LEVEL = 20;

export type MutationKind = 'vitality' | 'metabolism' | 'growth';

export type Offer =
  | { kind: 'new'; type: OrganelleType }
  | { kind: 'upgrade'; type: OrganelleType; index: number; toLevel: number }
  | { kind: 'mutation'; mutation: MutationKind };

export const MUTATIONS: Record<MutationKind, { name: string; text: string }> = {
  vitality: { name: 'Vitality Mutation', text: '+10% max HP' },
  metabolism: { name: 'Metabolic Mutation', text: '+15 max energy' },
  growth: { name: 'Growth Spurt', text: '+20 biomass instantly' },
};

export interface OfferContext {
  level: number;
  organelles: Organelle[];
}

export function generateOffers(ctx: OfferContext, rand: () => number): Offer[] {
  const cap = capacityForLevel(ctx.level);
  const free = cap - capacityUsed(ctx.organelles);
  const maxLvl = maxOrganelleLevel(ctx.level);

  const news: Offer[] = ORGANELLE_TYPES.filter((t) => {
    const def = ORGANELLES[t];
    return def.unlockLevel <= ctx.level && def.slotCost <= free && validSlots(ctx.organelles, t).length > 0;
  }).map((type) => ({ kind: 'new' as const, type }));

  const upgrades: Offer[] = ctx.organelles
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => o.level < maxLvl)
    .map(({ o, index }) => ({ kind: 'upgrade' as const, type: o.type, index, toLevel: o.level + 1 }));

  const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffle(news);
  shuffle(upgrades);

  const want = offerCount(ctx.level);
  const out: Offer[] = [];
  // Always offer at least one new organelle when one fits; mix in upgrades.
  if (news.length) out.push(news.shift()!);
  if (upgrades.length) out.push(upgrades.shift()!);
  const pool = shuffle([...news, ...upgrades]);
  // Avoid offering two upgrades for the same organelle type twice in a row.
  while (out.length < want && pool.length) {
    const next = pool.shift()!;
    if (out.some((o) => sameOffer(o, next))) continue;
    out.push(next);
  }
  const muts = shuffle<MutationKind>(['vitality', 'metabolism', 'growth']);
  while (out.length < want) out.push({ kind: 'mutation', mutation: muts.shift()! });
  return out;
}

function sameOffer(a: Offer, b: Offer): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'new' && b.kind === 'new') return a.type === b.type;
  if (a.kind === 'upgrade' && b.kind === 'upgrade') return a.index === b.index;
  return false;
}

export function offerTitle(o: Offer): string {
  if (o.kind === 'mutation') return MUTATIONS[o.mutation].name;
  const def = ORGANELLES[o.type];
  if (o.kind === 'upgrade') return `${def.levelNames[o.toLevel - 1]} (Lv${o.toLevel})`;
  return def.levelNames[0];
}

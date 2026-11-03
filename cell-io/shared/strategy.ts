/**
 * Reads an organism's evolutionary strategy from its layout, so players can
 * size up an opponent at a glance. Placement counts: front spikes say Hunter,
 * a side flagellum is not a sprint build, rear spikes are a defensive trick.
 */
import { angleDiff } from './math';
import type { Organelle } from './organelles';
import { organelleAngle, organelleDirection } from './placement';

export type Strategy = 'Hunter' | 'Tank' | 'Speedster' | 'Toxic' | 'Hybrid';

export const STRATEGY_COLORS: Record<Strategy, string> = {
  Hunter: '#ff7a7a',
  Tank: '#8fb4ff',
  Speedster: '#ffe066',
  Toxic: '#c6ff3d',
  Hybrid: '#d9c2ff',
};

const facing = (o: Organelle, target: number, tol: number) => Math.abs(angleDiff(organelleDirection(o), target)) <= tol;

export function strategyScores(organelles: readonly Organelle[]): Record<Exclude<Strategy, 'Hybrid'>, number> {
  const s = { Hunter: 0, Tank: 0, Speedster: 0, Toxic: 0 };
  for (const o of organelles) {
    const w = 1 + 0.25 * (o.level - 1);
    switch (o.type) {
      case 'spikes':
        if (facing(o, 0, Math.PI / 3)) s.Hunter += 2 * w;
        else if (facing(o, Math.PI, Math.PI / 3)) s.Tank += 0.8 * w; // rear spikes punish chasers
        else s.Hunter += 0.8 * w;
        break;
      case 'stinger':
        s.Hunter += 1 * w;
        s.Toxic += 0.6 * w;
        break;
      case 'venom':
        s.Hunter += 1 * w;
        s.Toxic += 1.2 * w;
        break;
      case 'membrane':
        s.Tank += 2 * w;
        break;
      case 'regen':
        s.Tank += 1.5 * w;
        s.Toxic += 0.5 * w;
        break;
      case 'mitochondria':
        s.Tank += 0.4 * w;
        s.Speedster += 0.5 * w;
        break;
      case 'cilia':
        s.Speedster += 1 * w;
        break;
      case 'flagellum':
        // Only a rear-mounted flagellum (pushing forward) is a sprint build.
        if (Math.abs(angleDiff(organelleAngle(o) + o.tilt, Math.PI)) <= Math.PI / 3) {
          s.Speedster += 2 * w;
          s.Hunter += 0.6 * w;
        } else s.Speedster += 0.8 * w;
        break;
      case 'toxin':
        s.Toxic += 2.5 * w;
        break;
    }
  }
  return s;
}

/** null for a bare cell; Hybrid when no single strategy clearly leads. */
export function classifyStrategy(organelles: readonly Organelle[]): Strategy | null {
  if (!organelles.length) return null;
  const ranked = (Object.entries(strategyScores(organelles)) as [Strategy, number][]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top[1] < 1.5) return null;
  if (second[1] > 0 && top[1] < second[1] * 1.35) return 'Hybrid';
  return top[0];
}

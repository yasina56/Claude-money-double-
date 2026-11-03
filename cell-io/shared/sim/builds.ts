/**
 * Reference builds for the balance harness (and anything else that wants a
 * known layout). Each is a full level-10 build: 8 capacity, level-II
 * organelles, every placement valid under shared/placement.ts.
 */
import type { Organelle, OrganelleType } from '../organelles';

const o = (type: OrganelleType, slot: number, level = 2, tilt = 0): Organelle => ({ type, slot, level, tilt });

/** Surface slots: 0 front, 4 right, 8 rear, 12 left. Internal: 0 center, 1 front, 4 rear. */
export const BUILDS: Record<string, Organelle[]> = {
  Hunter: [o('spikes', 0), o('spikes', 1), o('stinger', 15), o('venom', 1), o('flagellum', 8), o('cilia', 7)],
  Tank: [o('membrane', 0), o('membrane', 8), o('regen', 0), o('spikes', 2), o('mitochondria', 3)],
  Speedster: [o('cilia', 6), o('cilia', 7), o('cilia', 9), o('cilia', 10), o('flagellum', 8), o('spikes', 0), o('mitochondria', 0)],
  Toxic: [o('toxin', 0), o('toxin', 1), o('membrane', 0), o('regen', 4)],
  Bruiser: [o('spikes', 0), o('membrane', 8), o('toxin', 0), o('cilia', 4), o('cilia', 12), o('mitochondria', 1)],
};

export const BUILD_NAMES = Object.keys(BUILDS);

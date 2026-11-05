/** Player settings, persisted per browser (localStorage is optional; defaults always work). */
export interface Settings {
  mute: boolean;
  music: number; // 0..1
  sfx: number; // 0..1
  showNames: boolean;
  reduceEffects: boolean;
  tutorialDone: boolean;
}

const KEY = 'cellio:settings';
const DEFAULTS: Settings = { mute: false, music: 0.35, sfx: 0.8, showNames: true, reduceEffects: false, tutorialDone: false };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage blocked: use defaults */
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();
const listeners: ((s: Settings) => void)[] = [];

export function onSettings(fn: (s: Settings) => void) {
  listeners.push(fn);
  fn(settings);
}

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn(settings);
}

import Phaser from 'phaser';
import { Sfx } from './audio';
import { EvolutionUI } from './evolutionUI';
import { BackgroundScene, GameScene } from './GameScene';
import { Hud } from './hud';
import { Net } from './net';
import { SPECTATE_SECONDS } from '../../shared/constants';
import { Joystick } from './joystick';
import { onSettings, settings, updateSettings } from './settings';
import { drawThreats } from './threats';
import { Tutorial } from './tutorial';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// VITE_SOLO=1 builds run the authoritative server inside the page (single player, no backend).
// If VITE_SERVER_URL was set at build time, the solo build also offers "Play online" (?online).
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined;
const SOLO_BUILD = import.meta.env.VITE_SOLO === '1';
const ONLINE = !SOLO_BUILD || (!!SERVER_URL && new URLSearchParams(location.search).has('online'));
const localSocket = ONLINE ? undefined : (await import('./solo')).createLocalSocket();
const net = new Net(localSocket, ONLINE ? SERVER_URL : undefined);
const sfx = new Sfx();
const scene = new GameScene(net, sfx);
const hud = new Hud(net);
const evo = new EvolutionUI(net, sfx);
const tutorial = new Tutorial(net);
const joystick = new Joystick($('#game'));
scene.joystick = joystick;
const threatCanvas = $<HTMLCanvasElement>('#threats');

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#06161c',
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  render: { antialias: true },
  scene: [new BackgroundScene(), scene],
});

type Screen = 'menu' | 'playing' | 'dead';
let screen: Screen = 'menu';
let lastQueuedToast = 0;
let lastHud = 0;
let lastThreats = 0;

const menu = $('#menu');
const death = $('#death');
const nameInput = $<HTMLInputElement>('#name-input');
const playBtn = $<HTMLButtonElement>('#play-btn');
const status = $('#conn-status');

try {
  nameInput.value = localStorage.getItem('cellio:name') ?? '';
} catch {
  /* storage unavailable */
}

function setScreen(s: Screen) {
  screen = s;
  menu.classList.toggle('hidden', s !== 'menu');
  death.classList.toggle('hidden', s !== 'dead');
  hud.show(s === 'playing');
}

net.onConnection = (ok) => {
  status.textContent = ok ? (ONLINE ? 'Connected. Ready to evolve.' : 'Solo mode: the arena runs in your browser.') : 'Disconnected from server. Retrying…';
  playBtn.disabled = !ok;
};
playBtn.disabled = true;
if (ONLINE && SERVER_URL) {
  // Free hosting sleeps when idle; the first connection can take a while.
  setTimeout(() => {
    if (!net.connected) status.textContent = 'Waking up the server (free hosting can take ~30-60 s)…';
  }, 3000);
}
// Mode switch links (solo build only).
const modeLink = $<HTMLAnchorElement>('#mode-link');
if (SOLO_BUILD && SERVER_URL) {
  modeLink.classList.remove('hidden');
  modeLink.textContent = ONLINE ? 'Play solo instead' : 'Play online with others';
  modeLink.href = ONLINE ? location.pathname : `${location.pathname}?online`;
}

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!net.connected) return;
  sfx.unlock();
  const name = nameInput.value.trim();
  try {
    localStorage.setItem('cellio:name', name);
  } catch {
    /* ignore */
  }
  // First play: ask the server for the tutorial boost and show the step panel.
  const tut = tutorial.wanted;
  net.join(name, tut);
  if (tut) tutorial.start();
  sfx.startMusic();
  setScreen('playing');
});
tutorial.onDone = () => hud.toast('Tutorial complete!<br><small>Now go and design something nasty</small>', 2600);

$('#again-btn').onclick = () => {
  net.socket.emit('respawn');
  scene.spectateId = null;
  setScreen('playing');
};

net.onEvents = (events) => {
  scene.handleEvents(events);
  tutorial.onEvents(events);
  for (const ev of events) {
    if (ev.e === 'kill') hud.killfeed(ev.killer, ev.victim, ev.how);
    if (ev.e === 'level' && ev.id === net.myId) {
      hud.toast(`Level ${ev.level}!<br><small>New evolution available</small>`);
      evo.dismissed = false;
    }
  }
};
net.onOffer = (o) => {
  if (screen === 'playing') evo.show(o.offers);
};
net.onDied = (d) => {
  evo.close();
  const m = Math.floor(d.survivalTime / 60);
  const s = Math.floor(d.survivalTime % 60);
  $('#d-time').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('#d-level').textContent = String(d.level);
  $('#d-kills').textContent = String(d.kills);
  $('#d-biomass').textContent = String(d.biomassCollected);
  $('#death-by').textContent = d.killedBy ? `Consumed by ${d.killedBy}. Peak biomass ${d.peakBiomass}.` : `Peak biomass ${d.peakBiomass}.`;
  // "Killed by" camera: follow the killer for a few seconds before the death screen.
  const spectate = $('#spectate');
  if (d.killerId) {
    scene.spectateId = d.killerId;
    spectate.textContent = `Killed by ${d.killedBy}`;
    spectate.classList.remove('hidden');
  }
  setTimeout(
    () => {
      spectate.classList.add('hidden');
      if (screen === 'playing') setScreen('dead');
    },
    d.killerId ? SPECTATE_SECONDS * 1000 : 900,
  );
};

function ability(key: 'dash' | 'toxin' | 'venom') {
  if (screen !== 'playing' || evo.isOpen) return;
  if (key === 'dash') net.predictor.predictDash(net.you);
  net.socket.emit('ability', { key });
}

// F3: network debug overlay.
const netdbg = $('#netdbg');
let netdbgOn = false;
let lastNutrientRecords = 0;
let lastDbg = 0;
function updateNetDebug(now: number) {
  if (!netdbgOn || now - lastDbg < 250) return;
  const dtS = (now - lastDbg) / 1000;
  lastDbg = now;
  const st = net.stats;
  const p = net.predictor;
  const nps = (st.nutrientRecords - lastNutrientRecords) / dtS;
  lastNutrientRecords = st.nutrientRecords;
  netdbg.innerHTML = [
    `ping <b>${st.ping.toFixed(0)} ms</b>`,
    `snapshots <b>${st.snapRate}/s</b>`,
    `interp buffer <b>${st.bufferMs.toFixed(0)} ms</b>`,
    `prediction error <b>${p.lastError.toFixed(1)} px</b> (avg ${p.errorAvg.toFixed(1)})`,
    `corrections <b>${p.corrections}</b>`,
    `nutrient deltas <b>${nps.toFixed(0)} rec/s</b> (${net.nutrients.size} known)`,
    `cells in view <b>${net.latestCells.size}</b>`,
  ].join('<br>');
}
function openEvolution() {
  if (screen !== 'playing' || !net.you || net.you.pendingEvolutions <= 0) return;
  if (net.you.combatLock > 0) {
    hud.toast('Evolution queued<br><small>Get out of combat to evolve</small>', 1200);
    return;
  }
  evo.request();
}

$('#ab-dash').onclick = () => ability('dash');
$('#ab-toxin').onclick = () => ability('toxin');
$('#ab-venom').onclick = () => ability('venom');
scene.onOwnBreak = (type) => hud.toast(`Your ${type === 'membrane' ? 'membrane' : type} broke!<br><small>It regrows in 12 s</small>`, 1500);
$('#ab-evolve').onclick = () => openEvolution();
const muteBtn = $('#mute-btn');
const toggleMute = () => updateSettings({ mute: !settings.mute });
muteBtn.onclick = toggleMute;

// Settings panel
const settingsEl = $('#settings');
const setMute = $<HTMLInputElement>('#set-mute');
const setMusic = $<HTMLInputElement>('#set-music');
const setSfx = $<HTMLInputElement>('#set-sfx');
const setNames = $<HTMLInputElement>('#set-names');
const setReduce = $<HTMLInputElement>('#set-reduce');
onSettings((s) => {
  sfx.setMuted(s.mute);
  sfx.setVolumes(s.sfx, s.music);
  muteBtn.innerHTML = s.mute ? '&#128263;' : '&#128266;';
  setMute.checked = s.mute;
  setMusic.value = String(s.music);
  setSfx.value = String(s.sfx);
  setNames.checked = s.showNames;
  setReduce.checked = s.reduceEffects;
});
setMute.onchange = () => updateSettings({ mute: setMute.checked });
setMusic.oninput = () => updateSettings({ music: Number(setMusic.value) });
setSfx.oninput = () => updateSettings({ sfx: Number(setSfx.value) });
setNames.onchange = () => updateSettings({ showNames: setNames.checked });
setReduce.onchange = () => updateSettings({ reduceEffects: setReduce.checked });
$('#set-tutorial').onclick = () => {
  updateSettings({ tutorialDone: false });
  hud.toast('The tutorial will run next time you press Play', 1800);
};
const openSettings = () => settingsEl.classList.remove('hidden');
$('#settings-btn').onclick = openSettings;
$('#menu-settings').onclick = openSettings;
$('#settings-close').onclick = () => settingsEl.classList.add('hidden');

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.classList.contains('hidden')) {
    settingsEl.classList.add('hidden');
    return;
  }
  if (screen === 'menu') return;
  if (evo.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.repeat) return;
  switch (e.code) {
    case 'Space':
      ability('dash');
      e.preventDefault();
      break;
    case 'KeyQ':
      // Q fires the toxin cloud, or the venom surge if you have no toxin gland.
      ability(net.you && !net.you.hasToxin && net.you.hasVenom ? 'venom' : 'toxin');
      break;
    case 'KeyR':
      ability('venom');
      break;
    case 'KeyE':
      openEvolution();
      break;
    case 'KeyM':
      toggleMute();
      break;
    case 'F3':
      netdbgOn = !netdbgOn;
      netdbg.classList.toggle('hidden', !netdbgOn);
      e.preventDefault();
      break;
    case 'Enter':
      if (screen === 'dead') $('#again-btn').click();
      break;
  }
});

// Dev helper: window.cellioDevXp(500) works when the server runs with CELLIO_DEV=1.
(window as unknown as { cellioDevXp: (n: number) => void }).cellioDevXp = (n) => net.socket.emit('devXp', n);
(window as unknown as { cellioDevTp: () => void }).cellioDevTp = () => net.socket.emit('devTp');

function frame() {
  const now = performance.now();
  updateNetDebug(now);
  if (screen === 'playing') {
    // DOM HUD and the threat overlay refresh at 10-15 Hz, not every frame (cheaper on phones).
    if (now - lastHud > 100) {
      lastHud = now;
      hud.update(now);
      tutorial.onFrame();
    }
    if (now - lastThreats > 66) {
      lastThreats = now;
      drawThreats(threatCanvas, net, scene.viewRect(), net.you ? scene.focus : null);
    }
    const pending = net.you?.pendingEvolutions ?? 0;
    // Auto-open the evolution screen when a new evolution becomes available,
    // but only once you have been out of combat for a moment (server enforces this too).
    const locked = (net.you?.combatLock ?? 0) > 0;
    if (pending > 0 && !evo.isOpen && !evo.dismissed && locked && now - lastQueuedToast > 2500) {
      lastQueuedToast = now;
      hud.toast('Evolution queued<br><small>Get out of combat to evolve</small>', 1200);
    }
    if (pending > 0 && !evo.isOpen && !evo.dismissed && !locked) openEvolution();
  }
  scene.inputEnabled = !evo.isOpen;
  requestAnimationFrame(frame);
}
frame();
setScreen('menu');

// Debug handle for automated browser tests and the console.
(window as unknown as { __cellio: unknown }).__cellio = { net, scene, evo };

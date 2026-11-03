import Phaser from 'phaser';
import { Sfx } from './audio';
import { EvolutionUI } from './evolutionUI';
import { BackgroundScene, GameScene } from './GameScene';
import { Hud } from './hud';
import { Net } from './net';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// VITE_SOLO=1 builds run the authoritative server inside the page (single player, no backend).
const localSocket = import.meta.env.VITE_SOLO === '1' ? (await import('./solo')).createLocalSocket() : undefined;
const net = new Net(localSocket);
const sfx = new Sfx();
const scene = new GameScene(net, sfx);
const hud = new Hud(net);
const evo = new EvolutionUI(net, sfx);

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
let lastPending = 0;

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
  status.textContent = ok ? 'Connected. Ready to evolve.' : 'Disconnected from server. Retrying…';
  playBtn.disabled = !ok;
};
playBtn.disabled = true;

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
  net.join(name);
  lastPending = 0;
  setScreen('playing');
});

$('#again-btn').onclick = () => {
  net.socket.emit('respawn');
  lastPending = 0;
  setScreen('playing');
};

net.onEvents = (events) => {
  scene.handleEvents(events);
  for (const ev of events) {
    if (ev.e === 'kill') hud.killfeed(ev.killer, ev.victim);
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
  setTimeout(() => setScreen('dead'), 900);
};

function ability(key: 'dash' | 'toxin') {
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
  if (screen === 'playing' && net.you && net.you.pendingEvolutions > 0) evo.request();
}

$('#ab-dash').onclick = () => ability('dash');
$('#ab-toxin').onclick = () => ability('toxin');
$('#ab-evolve').onclick = () => openEvolution();
const muteBtn = $('#mute-btn');
const toggleMute = () => {
  muteBtn.innerHTML = sfx.toggle() ? '&#128263;' : '&#128266;';
};
muteBtn.onclick = toggleMute;

window.addEventListener('keydown', (e) => {
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
      ability('toxin');
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
    hud.update(now);
    const pending = net.you?.pendingEvolutions ?? 0;
    // Auto-open the evolution screen when a new evolution becomes available.
    if (pending > 0 && !evo.isOpen && !evo.dismissed && pending >= lastPending) openEvolution();
    lastPending = pending;
  }
  scene.inputEnabled = !evo.isOpen;
  requestAnimationFrame(frame);
}
frame();
setScreen('menu');

// Debug handle for automated browser tests and the console.
(window as unknown as { __cellio: unknown }).__cellio = { net, scene, evo };

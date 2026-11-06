/**
 * First-play tutorial (~60 s): eat, level up, place an organelle, dash.
 * Steps tick off from real game events; the server gives the tutorial cell
 * double nutrient XP until level 2 so the first level-up arrives quickly.
 */
import type { GameEvent } from '../../shared/protocol';
import type { Net } from './net';
import { settings, updateSettings } from './settings';

const STEPS = ['eat', 'level', 'place', 'dash'] as const;
type Step = (typeof STEPS)[number];
const EAT_TARGET = 8;

export class Tutorial {
  active = false;
  private step = 0;
  private eaten = 0;
  private root = document.querySelector('#tutorial') as HTMLElement;
  private items = [...document.querySelectorAll('#tut-steps li')] as HTMLElement[];
  private bar = document.querySelector('.tut-bar div') as HTMLElement;
  onDone: () => void = () => {};

  constructor(private net: Net) {
    (document.querySelector('#tut-skip') as HTMLElement).onclick = () => this.finish(true);
  }

  /** Whether the next join should ask for the tutorial. */
  get wanted() {
    return !settings.tutorialDone;
  }

  start() {
    this.active = true;
    this.step = 0;
    this.eaten = 0;
    this.root.classList.remove('hidden');
    this.render();
  }

  private get current(): Step {
    return STEPS[this.step];
  }

  private advance() {
    this.step++;
    if (this.step >= STEPS.length) this.finish(false);
    else this.render();
  }

  onEvents(events: GameEvent[]) {
    if (!this.active) return;
    for (const ev of events) {
      if (this.current === 'eat' && ev.e === 'eat' && ev.id === this.net.myId && ++this.eaten >= EAT_TARGET) this.advance();
      else if (this.current === 'dash' && ev.e === 'dash' && ev.id === this.net.myId) this.advance();
    }
    this.render();
  }

  onFrame() {
    if (!this.active) return;
    const you = this.net.you;
    if (!you) return;
    if (this.current === 'level' && you.level >= 2) this.advance();
    else if (this.current === 'place' && (this.net.infos.get(this.net.myId)?.organelles.length ?? 0) > 0) this.advance();
  }

  private render() {
    this.items.forEach((li, i) => {
      li.classList.toggle('done', i < this.step);
      li.classList.toggle('current', i === this.step);
    });
    const eatPart = this.current === 'eat' ? this.eaten / EAT_TARGET : 0;
    this.bar.style.width = `${((this.step + eatPart) / STEPS.length) * 100}%`;
    const eatLi = this.items[0];
    if (eatLi && this.current === 'eat') eatLi.firstChild!.textContent = `Eat ${EAT_TARGET} nutrients (${this.eaten}/${EAT_TARGET}) `;
  }

  finish(skipped: boolean) {
    if (!this.active) return;
    this.active = false;
    this.root.classList.add('hidden');
    updateSettings({ tutorialDone: true });
    if (!skipped) this.onDone();
  }
}

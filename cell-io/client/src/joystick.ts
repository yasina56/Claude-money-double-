/**
 * Virtual joystick for touch screens: touch anywhere on the left two-thirds
 * of the screen to place the stick, drag to steer (distance = speed).
 * Ability buttons stay tappable because they sit above the game layer.
 */
export class Joystick {
  active = false;
  a = 0;
  t = 0;
  private id: number | null = null;
  private ox = 0;
  private oy = 0;
  private el = document.querySelector('#joystick') as HTMLElement;
  private knob = this.el.querySelector('.knob') as HTMLElement;
  enabled = () => true;

  constructor(target: HTMLElement) {
    const radius = 60;
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.id !== null || !this.enabled()) return;
      if (e.clientX > window.innerWidth * 0.66) return;
      this.id = e.pointerId;
      this.ox = e.clientX;
      this.oy = e.clientY;
      this.active = true;
      this.t = 0;
      this.el.style.left = `${this.ox}px`;
      this.el.style.top = `${this.oy}px`;
      this.el.classList.remove('hidden');
      this.moveKnob(0, 0);
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.id) return;
      const dx = e.clientX - this.ox;
      const dy = e.clientY - this.oy;
      const d = Math.hypot(dx, dy);
      this.a = Math.atan2(dy, dx);
      this.t = Math.min(1, Math.max(0, (d - 8) / radius));
      const k = Math.min(d, radius) / (d || 1);
      this.moveKnob(dx * k, dy * k);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.id) return;
      this.id = null;
      this.active = false;
      this.t = 0;
      this.el.classList.add('hidden');
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  private moveKnob(x: number, y: number) {
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }
}

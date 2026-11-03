/**
 * Soft-body membrane: a ring of point masses, each tied to its rest position
 * by an underdamped spring and coupled to its neighbours. It runs in the
 * cell's local (heading-aligned) frame and is driven by inertial pseudo-forces:
 *
 *  - linear acceleration  -> the membrane lags behind (squash in front, bulge behind)
 *  - angular acceleration -> tangential lag, strongest at the softer rear,
 *                            so the back swings out on a turn and ricochets back
 *  - impacts              -> a local dent that ripples around the ring
 *
 * Offsets are in units of the cell radius, so the effect is size-independent;
 * heavier (bigger) cells see smaller accelerations and therefore deform less.
 */
import { TAU } from '../../shared/math';

const N = 28;
const K = 170; // spring stiffness toward rest (1/s^2)
const ZETA = 0.13; // damping ratio: low = more overshoot / ricochet
const K_NEIGHBOR = 140; // membrane tension between neighbours (smooths into waves)
const MAX_OFFSET = 0.38;
const SUBSTEP = 1 / 120;

export class SoftBody {
  readonly n = N;
  ox = new Float32Array(N);
  oy = new Float32Array(N);
  private vx = new Float32Array(N);
  private vy = new Float32Array(N);
  private cos = new Float32Array(N);
  private sin = new Float32Array(N);
  /** Per-point stiffness: the rear is softer, so it swings more. */
  private k = new Float32Array(N);
  /** Mean offset, used to slosh internal organelles. */
  meanX = 0;
  meanY = 0;

  constructor() {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
      const front = (1 + Math.cos(a)) / 2; // 1 at front, 0 at rear
      this.k[i] = K * (0.45 + 0.55 * front);
    }
  }

  /**
   * Advance the membrane.
   * @param ax,ay  cell acceleration in its local frame, in radii/s^2
   * @param alpha  angular acceleration (rad/s^2)
   * @param omega  angular velocity (rad/s)
   */
  step(dt: number, ax: number, ay: number, alpha: number, omega: number) {
    let t = Math.min(dt, 0.1);
    while (t > 1e-6) {
      const h = Math.min(SUBSTEP, t);
      this.substep(h, ax, ay, alpha, omega);
      t -= h;
    }
    let mx = 0;
    let my = 0;
    for (let i = 0; i < N; i++) {
      mx += this.ox[i];
      my += this.oy[i];
    }
    this.meanX = mx / N;
    this.meanY = my / N;
  }

  private substep(h: number, ax: number, ay: number, alpha: number, omega: number) {
    const { ox, oy, vx, vy, cos, sin, k } = this;
    for (let i = 0; i < N; i++) {
      const prev = (i + N - 1) % N;
      const next = (i + 1) % N;
      const px = cos[i];
      const py = sin[i];
      const rear = Math.max(0, -px); // 0 at front/sides, 1 at the very back
      const floppy = 1 + 1.6 * rear;
      // Inertia: the membrane resists the body's acceleration (pseudo-force -a).
      let fx = -ax * (0.7 + 0.5 * rear);
      let fy = -ay * (0.7 + 0.5 * rear);
      // Rotation: tangential lag from angular acceleration (-alpha z x p),
      // a little centrifugal fling, and a tail that whips the most.
      fx += alpha * py * 0.45 * floppy + omega * omega * px * 0.02;
      fy += -alpha * px * 0.45 * floppy + omega * omega * py * 0.02;
      // Turning also throws the rear sideways, opposite the turn direction.
      fy += -omega * rear * Math.abs(omega) * 0.2;
      // Springs and tension.
      const ki = k[i];
      const c = 2 * ZETA * Math.sqrt(ki);
      fx += -ki * ox[i] - c * vx[i] + K_NEIGHBOR * (ox[prev] + ox[next] - 2 * ox[i]);
      fy += -ki * oy[i] - c * vy[i] + K_NEIGHBOR * (oy[prev] + oy[next] - 2 * oy[i]);
      vx[i] += fx * h;
      vy[i] += fy * h;
    }
    for (let i = 0; i < N; i++) {
      ox[i] += vx[i] * h;
      oy[i] += vy[i] * h;
      const m = Math.hypot(ox[i], oy[i]);
      if (m > MAX_OFFSET) {
        ox[i] *= MAX_OFFSET / m;
        oy[i] *= MAX_OFFSET / m;
        vx[i] *= 0.5;
        vy[i] *= 0.5;
      }
    }
  }

  /** Dent the membrane at a local angle (an impact). Strength in radii/s. */
  poke(localAngle: number, strength: number) {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      let d = a - localAngle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const w = Math.exp(-(d * d) / 0.18);
      this.vx[i] -= this.cos[i] * strength * w;
      this.vy[i] -= this.sin[i] * strength * w;
    }
  }

  /** Interpolated offset at a local angle. */
  sample(th: number): { x: number; y: number } {
    let f = (th / TAU) * N;
    f = ((f % N) + N) % N;
    const i = Math.floor(f);
    const j = (i + 1) % N;
    const t = f - i;
    return { x: this.ox[i] + (this.ox[j] - this.ox[i]) * t, y: this.oy[i] + (this.oy[j] - this.oy[i]) * t };
  }
}

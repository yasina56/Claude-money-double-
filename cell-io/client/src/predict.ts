/**
 * Client-side prediction for the local cell.
 *
 * Every input message gets a sequence number and is kept in a history together
 * with how long the client applied it. Each frame the predicted body advances
 * with the shared `integrateMovement`, so steering responds instantly.
 *
 * When a snapshot arrives, the server reports the last input it applied
 * (`ack`), how long ago it applied it (`ackAge`) and its exact body. The
 * predictor rewinds to that body, drops acknowledged history, and replays the
 * rest: the tail of the acked input plus every newer input. Any difference
 * between where we were drawing the cell and the re-simulated position becomes
 * a visual offset that decays over ~120 ms, so corrections glide instead of snap.
 */
import { DASH_COST } from '../../shared/constants';
import type { Organelle } from '../../shared/organelles';
import type { Hazard, PrivateState } from '../../shared/protocol';
import { dashImpulse, integrateMovement, type Body, type MoveMods } from '../../shared/sim/movement';
import { computeStats, type CellStats } from '../../shared/stats';

interface InputRecord {
  seq: number;
  a: number;
  t: number;
  dur: number;
  /** Time into this record at which a predicted dash happened (or -1). */
  dashAt: number;
}

const STEP = 1 / 40;
const SNAP_DISTANCE = 160;
const CORRECTION_TAU = 0.12;

export class Predictor {
  body: Body | null = null;
  private history: InputRecord[] = [];
  private seq = 0;
  private stats: CellStats | null = null;
  private statsKey = '';
  private mods: MoveMods = { slow: 0, evolving: false };
  private level = 1;
  private offset = { x: 0, y: 0 };
  private localDashCd = 0;
  /** Size of the most recent correction (px) and a smoothed average, for the debug overlay. */
  lastError = 0;
  errorAvg = 0;
  corrections = 0;

  reset() {
    this.body = null;
    this.history = [];
    this.offset = { x: 0, y: 0 };
  }

  /** Stats come from biomass, level, layout and mutations; recompute only when those change. */
  setStats(you: PrivateState, organelles: Organelle[]) {
    const key = `${you.biomass}|${you.level}|${you.mutations.vitality}|${you.mutations.metabolism}|${organelles.map((o) => `${o.type}${o.level}:${o.slot}:${o.tilt}`).join(',')}`;
    if (key !== this.statsKey) {
      this.statsKey = key;
      this.stats = computeStats(you.biomass, you.level, organelles, you.mutations);
    }
    this.mods = { slow: you.slow, evolving: you.evolving };
    this.level = you.level;
  }

  /** Register a new input about to be sent; returns its sequence number. */
  pushInput(a: number, t: number): number {
    const rec: InputRecord = { seq: ++this.seq, a, t, dur: 0, dashAt: -1 };
    this.history.push(rec);
    if (this.history.length > 200) this.history.shift();
    return rec.seq;
  }

  /** Predict a dash locally if the last known state allows it. Returns whether it was predicted. */
  predictDash(you: PrivateState | null): boolean {
    const cur = this.history[this.history.length - 1];
    if (!this.body || !this.stats || !cur || !you) return false;
    if (you.dashCd > 0 || you.energy < DASH_COST || this.localDashCd > 0) return false;
    const imp = dashImpulse(this.body, this.stats, cur, this.level);
    this.body.vx += imp.x;
    this.body.vy += imp.y;
    cur.dashAt = cur.dur;
    this.localDashCd = you.dashMaxCd;
    return true;
  }

  /** Advance the prediction by one rendered frame. */
  tick(dt: number, hazards: readonly Hazard[]) {
    this.localDashCd = Math.max(0, this.localDashCd - dt);
    const k = Math.exp(-dt / CORRECTION_TAU);
    this.offset.x *= k;
    this.offset.y *= k;
    const cur = this.history[this.history.length - 1];
    if (!this.body || !this.stats || !cur) return;
    this.simulate(this.body, cur, dt, hazards);
    cur.dur += dt;
  }

  private simulate(b: Body, input: InputRecord, dt: number, hazards: readonly Hazard[]) {
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(STEP, left);
      integrateMovement(b, this.stats!, input, this.mods, hazards, h);
      left -= h;
    }
  }

  /** Rewind to the authoritative state and replay unacknowledged inputs. */
  reconcile(you: PrivateState, hazards: readonly Hazard[]) {
    const server: Body = { x: you.x, y: you.y, vx: you.vx, vy: you.vy, heading: you.heading };
    if (!this.body || !this.stats) {
      this.body = server;
      return;
    }
    const before = this.render();
    this.history = this.history.filter((r) => r.seq >= you.ack);
    const b = { ...server };
    for (const r of this.history) {
      // The acked input has already run for `ackAge` seconds on the server.
      const start = r.seq === you.ack ? Math.min(r.dur, you.ackAge) : 0;
      const span = r.dur - start;
      if (span <= 0) continue;
      if (r.dashAt >= start) {
        this.simulate(b, r, r.dashAt - start, hazards);
        const imp = dashImpulse(b, this.stats, r, this.level);
        b.vx += imp.x;
        b.vy += imp.y;
        this.simulate(b, r, r.dur - r.dashAt, hazards);
      } else this.simulate(b, r, span, hazards);
    }
    this.body = b;
    const ex = before.x - b.x;
    const ey = before.y - b.y;
    const err = Math.hypot(ex - this.offset.x, ey - this.offset.y);
    this.lastError = err;
    this.errorAvg += (err - this.errorAvg) * 0.1;
    this.corrections++;
    if (Math.hypot(ex, ey) > SNAP_DISTANCE) this.offset = { x: 0, y: 0 };
    else this.offset = { x: ex, y: ey };
  }

  /** Where to draw our cell: predicted body plus the decaying correction offset. */
  render(): { x: number; y: number; vx: number; vy: number; heading: number } {
    const b = this.body!;
    return { x: b.x + this.offset.x, y: b.y + this.offset.y, vx: b.vx, vy: b.vy, heading: b.heading };
  }
}

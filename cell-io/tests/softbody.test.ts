import { describe, expect, it } from 'vitest';
import { SoftBody } from '../client/src/softbody';

const REAR = Math.PI;
const FRONT = 0;

describe('soft-body membrane', () => {
  it('rear swings outward during a left turn, then ricochets past rest and settles', () => {
    const b = new SoftBody();
    const dt = 1 / 60;
    // Turning left (counter-clockwise on screen = negative omega) while moving forward:
    // centripetal acceleration points left (-y), so inertia throws the membrane right (+y).
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      b.step(dt, 0, -12, i < 3 ? -40 : 0, -4);
      peak = Math.max(peak, b.sample(REAR).y);
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(b.sample(REAR).y).toBeGreaterThan(b.sample(FRONT).y); // the tail whips more than the nose
    // Straighten out: the rear overshoots to the other side (ricochet)...
    let minY = Infinity;
    for (let i = 0; i < 40; i++) {
      b.step(dt, 0, 0, i < 3 ? 40 : 0, 0);
      minY = Math.min(minY, b.sample(REAR).y);
    }
    expect(minY).toBeLessThan(0);
    // ...and settles back to rest.
    for (let i = 0; i < 400; i++) b.step(dt, 0, 0, 0, 0);
    expect(Math.abs(b.sample(REAR).y)).toBeLessThan(0.005);
  });

  it('accelerating forward flattens the front and bulges the rear backwards', () => {
    const b = new SoftBody();
    for (let i = 0; i < 12; i++) b.step(1 / 60, 25, 0, 0, 0);
    expect(b.sample(FRONT).x).toBeLessThan(0);
    expect(b.sample(REAR).x).toBeLessThan(b.sample(FRONT).x);
  });

  it('an impact dents the membrane locally and stays bounded', () => {
    const b = new SoftBody();
    b.poke(Math.PI / 2, 4);
    b.step(1 / 30, 0, 0, 0, 0);
    const hit = b.sample(Math.PI / 2);
    expect(hit.y).toBeLessThan(0); // pushed inward
    expect(Math.abs(b.sample(-Math.PI / 2).y)).toBeLessThan(Math.abs(hit.y));
    for (let i = 0; i < 200; i++) b.step(1 / 60, 90, 90, 60, 8);
    for (let k = 0; k < 28; k++) expect(Math.hypot(b.ox[k], b.oy[k])).toBeLessThanOrEqual(0.381);
  });
});

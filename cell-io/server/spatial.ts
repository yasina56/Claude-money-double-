/** Uniform-grid spatial hash for many small static-ish objects (nutrients). */
export interface Positioned {
  id: number;
  x: number;
  y: number;
}

export class SpatialGrid<T extends Positioned> {
  private buckets = new Map<number, Set<T>>();
  private cols: number;

  constructor(
    worldSize: number,
    private cellSize: number,
  ) {
    this.cols = Math.ceil(worldSize / cellSize) + 1;
  }

  private key(x: number, y: number) {
    const gx = Math.max(0, Math.floor(x / this.cellSize));
    const gy = Math.max(0, Math.floor(y / this.cellSize));
    return gx + gy * this.cols;
  }

  insert(item: T) {
    const k = this.key(item.x, item.y);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = new Set()));
    b.add(item);
  }

  remove(item: T) {
    this.buckets.get(this.key(item.x, item.y))?.delete(item);
  }

  /** Calls `fn` for every item in buckets overlapping the rectangle. */
  query(x0: number, y0: number, x1: number, y1: number, fn: (item: T) => void) {
    const gx0 = Math.max(0, Math.floor(x0 / this.cellSize));
    const gy0 = Math.max(0, Math.floor(y0 / this.cellSize));
    const gx1 = Math.min(this.cols - 1, Math.floor(x1 / this.cellSize));
    const gy1 = Math.min(this.cols - 1, Math.floor(y1 / this.cellSize));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const b = this.buckets.get(gx + gy * this.cols);
        if (b) for (const item of b) fn(item);
      }
    }
  }
}

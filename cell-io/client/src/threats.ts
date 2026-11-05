/**
 * Screen-edge arrows pointing at nearby dangerous cells that are off-screen:
 * bigger than you, or armed and at least your level. Bigger threats get
 * bigger, more opaque arrows; nearer ones are brighter.
 */
import type { Net } from './net';

export function drawThreats(canvas: HTMLCanvasElement, net: Net, view: { x: number; y: number; w: number; h: number; zoom: number }, me: { x: number; y: number; r: number } | null) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(canvas.clientWidth * dpr);
  const H = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  if (!me || !net.you) return;
  const myLevel = net.you.level;
  for (const c of net.latestCells.values()) {
    if (c.id === net.myId) continue;
    const info = net.infos.get(c.id);
    const armed = !!info?.organelles.some((o) => o.type === 'spikes' || o.type === 'stinger' || o.type === 'toxin');
    const threat = (c.radius / me.r) * (armed ? 1.3 : 1) * ((info?.level ?? 1) >= myLevel ? 1.1 : 0.85);
    if (threat < 1.15) continue;
    // Only cells outside the visible area.
    if (c.x > view.x && c.x < view.x + view.w && c.y > view.y && c.y < view.y + view.h) continue;
    const dx = c.x - me.x;
    const dy = c.y - me.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1600) continue;
    const a = Math.atan2(dy, dx);
    // Intersect the ray from the screen centre with the screen border (inset).
    const cx = W / 2;
    const cy = H / 2;
    const inset = 28 * dpr;
    const sx = Math.cos(a);
    const sy = Math.sin(a);
    const t = Math.min(Math.abs((cx - inset) / (sx || 1e-6)), Math.abs((cy - inset) / (sy || 1e-6)));
    const px = cx + sx * t;
    const py = cy + sy * t;
    const size = (10 + Math.min(14, (threat - 1) * 10)) * dpr;
    const alpha = Math.max(0.35, 1 - dist / 1600);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.fillStyle = armed ? `rgba(255,93,122,${alpha})` : `rgba(255,214,94,${alpha})`;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, size * 0.7);
    ctx.lineTo(-size * 0.35, 0);
    ctx.lineTo(-size * 0.7, -size * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

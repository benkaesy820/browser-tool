/** Visible cursor motion for headed sessions (ghost-cursor technique).
 *
 * Playwright teleports the pointer; a watching human sees nothing travel.
 * These helpers draw a short eased path through native mouse.move calls,
 * so the cursor visibly glides. Timing is jittered and the click lands
 * slightly off-center with a pre-click pause — the three cheapest
 * human-like tells. Headless sessions skip all of it (no one is watching).
 */

export interface Point {
  x: number;
  y: number;
}

export function glidePath(from: Point, to: Point, steps?: number): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 2) return [to];
  const n = steps ?? Math.max(6, Math.min(24, Math.round(dist / 40)));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(dist, 1);
  // Randomized perpendicular bow keeps repeated moves from looking machined.
  const bend = (Math.random() - 0.5) * 0.4 * len;
  const cx = (from.x + to.x) / 2 - (dy / len) * bend;
  const cy = (from.y + to.y) / 2 + (dx / len) * bend;
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Ease in-out: fast middle, gentle landing.
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const mt = 1 - e;
    points.push({
      x:
        Math.round((mt * mt * from.x + 2 * mt * e * cx + e * e * to.x) * 10) /
        10,
      y:
        Math.round((mt * mt * from.y + 2 * mt * e * cy + e * e * to.y) * 10) /
        10,
    });
  }
  return points;
}

/** Milliseconds between path points: fast with human jitter. */
export function glideDelay(): number {
  return 2 + Math.random() * 8;
}

/** Pre-click pause: the beat of confirming the target. */
export function clickPause(): number {
  return 60 + Math.random() * 80;
}

/**
 * Accelerating then settling wheel deltas. Integer steps sum exactly to the
 * requested movement, keeping natural-looking input precise.
 */
export function wheelPath(deltaX: number, deltaY: number): Point[] {
  const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  if (distance === 0) return [];
  const count = Math.max(1, Math.min(72, Math.ceil(distance / 70)));
  const weights = Array.from({ length: count }, (_, i) =>
    Math.sin((Math.PI * (i + 0.5)) / count),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const points: Point[] = [];
  let sentX = 0;
  let sentY = 0;
  let idealX = 0;
  let idealY = 0;
  for (let i = 0; i < count; i++) {
    idealX += (deltaX * (weights[i] as number)) / total;
    idealY += (deltaY * (weights[i] as number)) / total;
    const nextX = i === count - 1 ? deltaX : Math.round(idealX);
    const nextY = i === count - 1 ? deltaY : Math.round(idealY);
    points.push({ x: nextX - sentX, y: nextY - sentY });
    sentX = nextX;
    sentY = nextY;
  }
  return points;
}

export function wheelDelay(): number {
  return 8 + Math.random() * 18;
}

/** A lived-in click point: middle half of the box, never dead center. */
export function clickPoint(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Point {
  return {
    x: Math.round((box.x + box.width * (0.3 + Math.random() * 0.4)) * 10) / 10,
    y: Math.round((box.y + box.height * (0.3 + Math.random() * 0.4)) * 10) / 10,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

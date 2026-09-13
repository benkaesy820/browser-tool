import { describe, expect, it } from "vitest";
import {
  glidePath,
  glideDelay,
  clickPause,
  clickPoint,
  wheelPath,
  wheelDelay,
} from "@browser-bridge/core";

describe("cursor motion math", () => {
  it("draws paths from start to landing", () => {
    const path = glidePath({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(path.length).toBeGreaterThanOrEqual(7);
    expect(path.length).toBeLessThanOrEqual(25);
    expect(path[0]).toMatchObject({ x: 0, y: 0 });
    const last = path[path.length - 1] as { x: number; y: number };
    expect(last.x).toBeCloseTo(300, 0);
    expect(last.y).toBeCloseTo(0, 0);
  });

  it("collapses tiny moves to a single point", () => {
    expect(glidePath({ x: 5, y: 5 }, { x: 6, y: 5 })).toEqual([{ x: 6, y: 5 }]);
  });

  it("keeps timing human-scale", () => {
    for (let i = 0; i < 20; i++) {
      const d = glideDelay();
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThanOrEqual(10);
      const p = clickPause();
      expect(p).toBeGreaterThanOrEqual(60);
      expect(p).toBeLessThanOrEqual(140);
    }
  });

  it("lands clicks inside the element, off dead center", () => {
    for (let i = 0; i < 20; i++) {
      const p = clickPoint({ x: 100, y: 200, width: 120, height: 40 });
      expect(p.x).toBeGreaterThanOrEqual(100 + 120 * 0.3 - 1);
      expect(p.x).toBeLessThanOrEqual(100 + 120 * 0.7 + 1);
      expect(p.y).toBeGreaterThanOrEqual(200 + 40 * 0.3 - 1);
      expect(p.y).toBeLessThanOrEqual(200 + 40 * 0.7 + 1);
    }
  });

  it("accelerates and settles wheel input without losing distance", () => {
    const path = wheelPath(240, 1000);
    expect(path.length).toBeGreaterThan(4);
    expect(path.reduce((sum, point) => sum + point.x, 0)).toBe(240);
    expect(path.reduce((sum, point) => sum + point.y, 0)).toBe(1000);
    const magnitudes = path.map((point) => Math.hypot(point.x, point.y));
    expect(Math.max(...magnitudes)).toBeGreaterThan(magnitudes[0] as number);
    expect(Math.max(...magnitudes)).toBeGreaterThan(
      magnitudes[magnitudes.length - 1] as number,
    );
    for (let i = 0; i < 20; i++) {
      expect(wheelDelay()).toBeGreaterThanOrEqual(8);
      expect(wheelDelay()).toBeLessThanOrEqual(26);
    }
  });
});

// Grade-distribution math. Pure functions, no network — unit-testable with
// no mocks.

import type { Pyramid, PyramidLevel, Tick } from "./types.js";
import { parseVGrade } from "./types.js";

/**
 * Build a climber's grade pyramid from their ticks.
 *
 * - Only `sent` ticks are tallied.
 * - Levels span the contiguous V-grade range from the lowest to the highest
 *   grade sent, so empty rungs in the middle are visible.
 * - Gap heuristic (deliberately simple): a grade is a gap if the level
 *   immediately below it has 3+ sends while this level has 0 or 1. We also
 *   probe the rung one above the highest sent grade as the natural next step.
 */
export function buildPyramid(ticks: Tick[]): Pyramid {
  const counts = new Map<number, number>();
  for (const tick of ticks) {
    if (tick.status !== "sent") continue;
    const n = parseVGrade(tick.vGrade);
    if (n === null) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return { levels: [], gaps: [] };
  }

  const grades = [...counts.keys()];
  const min = Math.min(...grades);
  const max = Math.max(...grades);

  const levels: PyramidLevel[] = [];
  for (let g = min; g <= max; g++) {
    levels.push({ grade: `V${g}`, sent: counts.get(g) ?? 0 });
  }

  const gaps: string[] = [];
  // Check each rung from one above the floor up to one above the ceiling.
  for (let g = min + 1; g <= max + 1; g++) {
    const below = counts.get(g - 1) ?? 0;
    const here = counts.get(g) ?? 0;
    if (below >= 3 && here <= 1) {
      gaps.push(`V${g}`);
    }
  }

  return { levels, gaps };
}

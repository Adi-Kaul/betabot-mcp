// Grade-distribution math. Pure functions, no network — unit-testable with
// no mocks.

import type { ClimbType, Pyramid, PyramidLevel, Tick } from "./types.js";
import { CLIMB_TYPES, parseVGrade } from "./types.js";

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

/**
 * The highest grade in a built pyramid with a solid base (3+ sends), else the
 * highest grade with any send, else null. Returns the base integer.
 *
 * Levels are emitted in ascending grade order, so the last qualifying rung is
 * the highest. Pure helper shared by the typed-pyramid analysis below.
 */
export function workingGradeNum(pyramid: Pyramid): number | null {
  let solid: number | null = null;
  let anySend: number | null = null;
  for (const level of pyramid.levels) {
    const n = parseVGrade(level.grade);
    if (n === null) continue;
    if (level.sent >= 1) anySend = n;
    if (level.sent >= 3) solid = n;
  }
  return solid ?? anySend;
}

export interface TypedPyramid {
  type: ClimbType;
  pyramid: Pyramid;
  workingGrade: string; // "V<n>" of this type's working grade, "V0" if none
}

/**
 * Build a separate grade pyramid per climb type, from the *typed* sends only.
 *
 * Ticks without a `type` are ignored here (they still feed the overall
 * pyramid via `buildPyramid`). Only types the climber has actually logged
 * appear, in the canonical `CLIMB_TYPES` order. Each type's bucket reuses
 * `buildPyramid` unchanged — this is pure partitioning.
 */
export function buildTypedPyramids(ticks: Tick[]): TypedPyramid[] {
  const byType = new Map<ClimbType, Tick[]>();
  for (const tick of ticks) {
    if (!tick.type) continue;
    const list = byType.get(tick.type) ?? [];
    list.push(tick);
    byType.set(tick.type, list);
  }

  const out: TypedPyramid[] = [];
  for (const type of CLIMB_TYPES) {
    const bucket = byType.get(type);
    if (!bucket) continue;
    const pyramid = buildPyramid(bucket);
    const n = workingGradeNum(pyramid);
    out.push({ type, pyramid, workingGrade: `V${n ?? 0}` });
  }
  return out;
}

export interface TypeWeakness {
  type: ClimbType;
  workingGrade: string;
  lagBelowOverall: number; // grades behind your overall working grade; higher = weaker
}

/**
 * Rank the climber's logged types weakest-first for the "mixed" view: how far
 * each type's working grade lags behind their overall working grade. A large
 * positive lag is a weak spot to train next; 0 means on par with overall.
 *
 * Overall working grade is computed across *all* sent ticks (typed or not).
 * Returns [] if there are no typed sends or no overall base to compare against.
 */
export function weakestTypes(ticks: Tick[]): TypeWeakness[] {
  const overall = workingGradeNum(buildPyramid(ticks));
  if (overall === null) return [];

  const typed = buildTypedPyramids(ticks);
  return typed
    .map((t) => {
      const n = workingGradeNum(t.pyramid) ?? 0;
      return { type: t.type, workingGrade: t.workingGrade, lagBelowOverall: overall - n };
    })
    .sort((a, b) => b.lagBelowOverall - a.lagBelowOverall || a.type.localeCompare(b.type));
}

export interface LevelAssessment {
  level: string; // headline: consolidated grade, else hardest send, else "V0"
  hardestGrade: string | null; // hardest single send
  consolidatedGrade: string | null; // highest grade with a solid 3+ base
  breakdown: PyramidLevel[]; // sends per grade — the distribution for a chart
  totalSends: number;
  sendsAtLevel: number; // sends at the headline level's grade
}

/**
 * Assess the climber's level from their ticks. Pure facts only — no prose, no
 * presentation. The app renders `breakdown` however it likes; the LLM narrates
 * the "why" from these numbers.
 *
 * Three distinct facets so the consumer can choose what to headline:
 * - `hardestGrade`  — their single hardest send (flattering but fragile).
 * - `consolidatedGrade` — highest grade with 3+ sends (what they truly operate at).
 * - `level` — the honest headline: consolidated, else hardest, else "V0".
 */
export function assessLevel(ticks: Tick[]): LevelAssessment {
  const { levels } = buildPyramid(ticks);
  const totalSends = levels.reduce((sum, l) => sum + l.sent, 0);

  if (levels.length === 0) {
    return {
      level: "V0",
      hardestGrade: null,
      consolidatedGrade: null,
      breakdown: [],
      totalSends: 0,
      sendsAtLevel: 0,
    };
  }

  // Levels are ascending: the last with any send is hardest, the last with 3+
  // is the consolidated base.
  let hardestGrade: string | null = null;
  let consolidatedGrade: string | null = null;
  for (const lvl of levels) {
    if (lvl.sent >= 1) hardestGrade = lvl.grade;
    if (lvl.sent >= 3) consolidatedGrade = lvl.grade;
  }

  const level = consolidatedGrade ?? hardestGrade ?? "V0";
  const sendsAtLevel = levels.find((l) => l.grade === level)?.sent ?? 0;

  return { level, hardestGrade, consolidatedGrade, breakdown: levels, totalSends, sendsAtLevel };
}

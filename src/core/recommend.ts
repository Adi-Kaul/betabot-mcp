// Candidate filtering / ranking / grouping. Deterministic logic only — no
// network reasoning, no Claude calls, no prose. The structured facts are the
// output; the narrative is composed on the other side of the tool boundary.

import type { Climb, Coordinates, Tick } from "./types.js";
import { parseVGrade } from "./types.js";
import { buildPyramid } from "./pyramid.js";
import { haversineKm } from "./geo.js";
import { getArea, getAreaProblems } from "./openbeta.js";

export interface Recommendation {
  name: string;
  vGrade: string | null;
  wall: string; // immediate parent area name
  tier: "at-level" | "project";
  leftRightIndex?: number;
  distanceKm?: number; // from the anchor area center, when both have coords
  description: string; // verbatim, "" if none
}

export interface RecommendationSet {
  area: string;
  workingGrade: string;
  groups: { wall: string; climbs: Recommendation[]; distanceKm?: number }[];
}

export interface RecommendOptions {
  // The proximity center. When the app knows the climber's GPS position it
  // passes it here; otherwise we fall back to the anchor area's own center.
  userLocation?: Coordinates;
  // Drop crags whose nearest climb is farther than this from the center.
  // Climbs with no coordinates are never dropped (we can't confirm they're out
  // of range). Omit for ranking-only (no hard cap).
  maxDistanceKm?: number;
}

/** Normalize a climb name for matching against ticks. */
function normName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The climber's working grade: the highest grade with a solid base (3+ sends).
 * Falls back to the highest grade with any send, then "V0" if they have none.
 */
export function workingGrade(ticks: Tick[]): string {
  const { levels } = buildPyramid(ticks);
  if (levels.length === 0) return "V0";

  let solid: string | null = null;
  let anySend: string | null = null;
  for (const level of levels) {
    if (level.sent >= 1) anySend = level.grade;
    if (level.sent >= 3) solid = level.grade;
  }
  return solid ?? anySend ?? "V0";
}

/**
 * Rank unclimbed boulders at an area by grade fit and group them by wall.
 *
 *  1. Pull all boulders under `areaUuid` (traversing sub-areas).
 *  2. Drop ones the climber has already sent (matched by name + grade).
 *  3. Determine the working grade from their pyramid.
 *  4. Rank by grade proximity: at-level first, one above as projects,
 *     far-easier / far-harder de-prioritized.
 *  5. Group by immediate parent wall; order within a group by leftRightIndex.
 */
export async function recommendNext(
  ticks: Tick[],
  areaUuid: string,
  options: RecommendOptions = {},
): Promise<RecommendationSet> {
  const [area, problems] = await Promise.all([getArea(areaUuid), getAreaProblems(areaUuid)]);

  // Proximity center: the climber's GPS position if the app supplied it, else
  // the anchor area's own coordinates. Absent both -> location ranking is
  // skipped and grade-fit decides ordering.
  const center: Coordinates | undefined = options.userLocation ?? area.coordinates;
  const distanceOf = (climb: Climb): number | undefined =>
    center && climb.coordinates ? haversineKm(center, climb.coordinates) : undefined;

  // Sends to exclude, keyed by name + normalized grade.
  const sent = new Set<string>();
  for (const tick of ticks) {
    if (tick.status !== "sent") continue;
    const n = parseVGrade(tick.vGrade);
    sent.add(`${normName(tick.climbName)}|${n ?? "?"}`);
  }

  const wg = workingGrade(ticks);
  const wn = parseVGrade(wg) ?? 0;

  // Score lower = better fit. Used for ranking within and across walls.
  function score(climb: Climb): number {
    const gn = parseVGrade(climb.vGrade);
    if (gn === null) return 1000; // ungraded boulders sort last
    const diff = gn - wn;
    if (diff === 0) return 0; // at level
    if (diff === 1) return 1; // natural project
    if (diff === -1) return 2; // warmup / easier
    return 10 + Math.abs(diff); // far harder / far easier, de-prioritized
  }

  const candidates = problems
    .filter((c) => {
      const gn = parseVGrade(c.vGrade);
      return !sent.has(`${normName(c.name)}|${gn ?? "?"}`);
    })
    .filter((c) => {
      // Hard cap: drop climbs beyond the radius. Unknown-distance climbs stay.
      if (options.maxDistanceKm === undefined) return true;
      const d = distanceOf(c);
      return d === undefined || d <= options.maxDistanceKm;
    })
    .map((climb) => {
      const gn = parseVGrade(climb.vGrade);
      const tier: Recommendation["tier"] = gn !== null && gn > wn ? "project" : "at-level";
      const rec: Recommendation = {
        name: climb.name,
        vGrade: climb.vGrade,
        wall: climb.areaPath.length > 0 ? climb.areaPath[climb.areaPath.length - 1] : area.name,
        tier,
        description: climb.description,
      };
      if (climb.leftRightIndex !== undefined) rec.leftRightIndex = climb.leftRightIndex;
      const d = distanceOf(climb);
      if (d !== undefined) rec.distanceKm = Math.round(d * 10) / 10;
      return { rec, score: score(climb) };
    });

  // Group by immediate parent wall.
  const byWall = new Map<string, { rec: Recommendation; score: number }[]>();
  for (const c of candidates) {
    const list = byWall.get(c.rec.wall) ?? [];
    list.push(c);
    byWall.set(c.rec.wall, list);
  }

  const groups = [...byWall.entries()]
    .map(([wall, items]) => {
      items.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        const la = a.rec.leftRightIndex;
        const lb = b.rec.leftRightIndex;
        if (la !== undefined && lb !== undefined && la !== lb) return la - lb;
        if (la !== undefined && lb === undefined) return -1;
        if (la === undefined && lb !== undefined) return 1;
        return a.rec.name.localeCompare(b.rec.name);
      });
      // A crag's distance is that of its nearest climb to the center.
      const dists = items.map((i) => i.rec.distanceKm).filter((d): d is number => d !== undefined);
      const distanceKm = dists.length > 0 ? Math.min(...dists) : undefined;
      return {
        wall,
        climbs: items.map((i) => i.rec),
        distanceKm,
        bestScore: items.length > 0 ? items[0].score : Number.MAX_SAFE_INTEGER,
      };
    })
    // With a center, nearest crag first (unknown distance sorts last); grade-fit
    // breaks ties. Without a center, fall back to grade-fit ordering.
    .sort((a, b) => {
      if (center) {
        const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
        const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
      }
      return a.bestScore - b.bestScore || a.wall.localeCompare(b.wall);
    })
    .map(({ wall, climbs, distanceKm }) => ({ wall, climbs, distanceKm }));

  return { area: area.name, workingGrade: wg, groups };
}

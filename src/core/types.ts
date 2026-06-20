// Shared data shapes for BetaBot-MCP. Built first; everything else depends on these.

export type Discipline = "bouldering" | "sport" | "trad" | "tr" | "aid";

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Area {
  name: string;
  uuid: string;
  totalClimbs: number;
  path: string[]; // from pathTokens
  coordinates?: Coordinates;
  children: { name: string; uuid: string; totalClimbs: number }[];
}

export interface Climb {
  name: string;
  uuid: string;
  vGrade: string | null; // from grades.vscale, e.g. "V5"
  isBoulder: boolean;
  coordinates?: Coordinates;
  leftRightIndex?: number;
  description: string; // verbatim; "" when absent
  areaPath: string[]; // hierarchy this climb sits under
}

export type TickStatus = "sent" | "attempt" | "project";

export interface Tick {
  climbName: string; // matched by name (+ area) since users may import
  vGrade: string; // e.g. "V4"
  status: TickStatus;
  attempts?: number;
  date?: string;
}

export interface PyramidLevel {
  grade: string;
  sent: number;
}

export interface Pyramid {
  levels: PyramidLevel[];
  gaps: string[];
}

// --- V-grade ordering ---------------------------------------------------
// A local ordering is sufficient; we deliberately avoid an external grade
// library. V0..V17 covers the bouldering scale used by OpenBeta's `vscale`.

export const V_GRADES: string[] = Array.from({ length: 18 }, (_, i) => `V${i}`);

/**
 * Parse a vscale grade string to its base integer, or null if it can't be
 * read as a V-grade. Handles plain ("V5"), open-ended ("V5+"), and ranges
 * ("V4-6", "V4-5") by taking the lower bound. Anything non-numeric (e.g.
 * "VB", null) returns null.
 */
export function parseVGrade(grade: string | null | undefined): number | null {
  if (!grade) return null;
  const match = grade.match(/V\s*(\d+)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/** Normalize a grade to its canonical "V<n>" label, or null if unparseable. */
export function normalizeVGrade(grade: string | null | undefined): string | null {
  const n = parseVGrade(grade);
  return n === null ? null : `V${n}`;
}

/**
 * Compare two V-grades by their base integer. Unparseable grades sort last.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareGrades(a: string | null | undefined, b: string | null | undefined): number {
  const na = parseVGrade(a);
  const nb = parseVGrade(b);
  if (na === null && nb === null) return 0;
  if (na === null) return 1;
  if (nb === null) return -1;
  return na - nb;
}

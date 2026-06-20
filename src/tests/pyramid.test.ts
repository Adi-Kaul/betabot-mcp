import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPyramid, buildTypedPyramids, weakestTypes } from "../core/pyramid.js";
import type { ClimbType, Tick } from "../core/types.js";

function sent(climbName: string, vGrade: string): Tick {
  return { climbName, vGrade, status: "sent" };
}

function sentType(climbName: string, vGrade: string, type: ClimbType): Tick {
  return { climbName, vGrade, status: "sent", type };
}

test("buildPyramid tallies sent ticks into ordered, contiguous levels", () => {
  const ticks: Tick[] = [
    sent("a", "V2"),
    sent("b", "V2"),
    sent("c", "V2"),
    sent("d", "V3"),
    sent("e", "V3"),
    sent("f", "V3"),
    sent("g", "V4"),
    // gap at V5: V4 has only 1 send so it does NOT trigger a V5 gap,
    // but V3->V4 (3 below, 1 here) makes V4 a gap.
  ];

  const { levels, gaps } = buildPyramid(ticks);

  assert.deepEqual(levels, [
    { grade: "V2", sent: 3 },
    { grade: "V3", sent: 3 },
    { grade: "V4", sent: 1 },
  ]);
  assert.deepEqual(gaps, ["V4"]);
});

test("buildPyramid includes empty middle rungs and probes one above the ceiling", () => {
  const ticks: Tick[] = [sent("a", "V1"), sent("b", "V1"), sent("c", "V1")];
  const { levels, gaps } = buildPyramid(ticks);

  assert.deepEqual(levels, [{ grade: "V1", sent: 3 }]);
  // V1 has 3 sends, V2 has 0 -> V2 is a gap (the natural next step).
  assert.deepEqual(gaps, ["V2"]);
});

test("buildPyramid ignores non-sent ticks and unparseable grades", () => {
  const ticks: Tick[] = [
    sent("a", "V2"),
    { climbName: "b", vGrade: "V3", status: "project" },
    { climbName: "c", vGrade: "VB", status: "sent" },
  ];
  const { levels, gaps } = buildPyramid(ticks);
  assert.deepEqual(levels, [{ grade: "V2", sent: 1 }]);
  assert.deepEqual(gaps, []);
});

test("buildPyramid on empty input returns empty pyramid", () => {
  const { levels, gaps } = buildPyramid([]);
  assert.deepEqual(levels, []);
  assert.deepEqual(gaps, []);
});

test("buildTypedPyramids partitions by type and only lists logged types", () => {
  const ticks: Tick[] = [
    sentType("a", "V2", "slab"),
    sentType("b", "V2", "slab"),
    sentType("c", "V2", "slab"),
    sentType("d", "V3", "slab"),
    sentType("e", "V4", "overhang"),
    sent("f", "V5"), // untyped: ignored by typed pyramids
  ];

  const typed = buildTypedPyramids(ticks);
  const types = typed.map((t) => t.type);
  // Only slab + overhang appear, in canonical CLIMB_TYPES order (slab before overhang).
  assert.deepEqual(types, ["slab", "overhang"]);

  const slab = typed.find((t) => t.type === "slab")!;
  assert.deepEqual(slab.pyramid.levels, [
    { grade: "V2", sent: 3 },
    { grade: "V3", sent: 1 },
  ]);
  // 3 solid at V2, only 1 at V3 -> slab working grade is V2, next slab target V3.
  assert.equal(slab.workingGrade, "V2");
  assert.deepEqual(slab.pyramid.gaps, ["V3"]);

  // Overhang has a single V4 send: any-send fallback makes V4 the working grade.
  const over = typed.find((t) => t.type === "overhang")!;
  assert.equal(over.workingGrade, "V4");
});

test("weakestTypes ranks logged types by lag below overall working grade", () => {
  const ticks: Tick[] = [
    // Overall: a solid V4 base (3 sends) -> overall working grade V4.
    sent("x", "V4"),
    sent("y", "V4"),
    sentType("a", "V4", "overhang"),
    // Slab tops out at a solid V2 -> lags overall (V4) by 2.
    sentType("b", "V2", "slab"),
    sentType("c", "V2", "slab"),
    sentType("d", "V2", "slab"),
  ];

  const weak = weakestTypes(ticks);
  assert.deepEqual(weak, [
    { type: "slab", workingGrade: "V2", lagBelowOverall: 2 },
    { type: "overhang", workingGrade: "V4", lagBelowOverall: 0 },
  ]);
});

test("weakestTypes returns empty when there are no typed or no sent ticks", () => {
  assert.deepEqual(weakestTypes([]), []);
  // Sends exist but none are typed -> nothing to rank.
  assert.deepEqual(weakestTypes([sent("a", "V3")]), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPyramid } from "../core/pyramid.js";
import type { Tick } from "../core/types.js";

function sent(climbName: string, vGrade: string): Tick {
  return { climbName, vGrade, status: "sent" };
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

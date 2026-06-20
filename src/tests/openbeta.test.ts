import { test } from "node:test";
import assert from "node:assert/strict";
import { getAreaProblems } from "../core/openbeta.js";

// Integration test: hits the live OpenBeta API. Skipped unless RUN_INTEGRATION=1
// so the suite passes offline / in CI without network.
const RUN = process.env.RUN_INTEGRATION === "1";

// The Chief (container) — from the spec's validated fixtures.
const CHIEF_UUID = "8f267065-fc1a-59ce-bcf1-6e9335548363";

test(
  "getAreaProblems traverses The Chief and returns boulder climbs",
  { skip: RUN ? false : "set RUN_INTEGRATION=1 to run network tests" },
  async () => {
    const climbs = await getAreaProblems(CHIEF_UUID);
    assert.ok(climbs.length > 0, "expected a non-empty list of climbs");

    for (const c of climbs) {
      assert.equal(c.isBoulder, true, `${c.name} should be a boulder`);
      assert.ok(typeof c.name === "string" && c.name.length > 0, "climb should have a name");
    }

    const graded = climbs.filter((c) => c.vGrade !== null);
    assert.ok(graded.length / climbs.length > 0.5, "most climbs should have a vGrade");
  },
);

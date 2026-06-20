# BetaBot-MCP — Build Report & Next Steps

A single-document record of what was built, how it works, what's verified, and what to do next.

---

## 1. What this project is

BetaBot-MCP is a standalone, open-source **Model Context Protocol (MCP) server** written in TypeScript. It exposes the public **OpenBeta** climbing database to Claude as five bouldering-progression tools. A climber logs what they've sent; Claude uses the tools to reason about what to try next at a given crag — grounded entirely in **grade, area hierarchy, and location**, never in guessed climbing style.

It talks to the OpenBeta GraphQL API (`https://api.openbeta.io`, no auth) and speaks to Claude over **stdio**.

**Core principle:** facts in, facts out — Claude does the talking. The server fetches and ranks deterministically; it never writes prose, never calls an LLM, and never invents a climb's style.

---

## 2. Architecture

```
Claude  <--stdio-->  mcp/index.ts  -->  mcp/tools.ts  -->  core/*  -->  OpenBeta API
         (talks)      (the server)      (5 wrappers)     (the brains)   (the data)
```

The defining decision is **thin tools over a fat core**:
- All real logic lives in `src/core/` and has **zero MCP-specific imports**, so it can later lift into a mobile-app backend untouched.
- The MCP tools in `src/mcp/` are dumb adapters: validate input → call a core function → format output.

---

## 3. File-by-file: what each does and how

### `src/core/types.ts` — the vocabulary
Defines the shared data shapes (`Area`, `Climb`, `Tick`, `Pyramid`, `Coordinates`, etc.) as TypeScript interfaces, plus the grade math:
- `V_GRADES` — a local `V0..V17` ordering (no external grade library).
- `parseVGrade()` — regex `/V\s*(\d+)/i` pulls the base integer out of a grade string. Handles ranges (`"V4-6"` → `4`), lowercase (`"v4"` → `4`), and returns `null` for non-numeric grades (`"VB"`).
- `normalizeVGrade()` / `compareGrades()` — canonical label and numeric comparison built on top.

Pattern: **normalize messy input into clean types at the boundary**, so the rest of the code works with clean values.

### `src/core/openbeta.ts` — the data layer (the meatiest file)
Everything that touches the network.
- **`gql()`** — one helper that POSTs a GraphQL query + variables and returns parsed `data`. Includes:
  - an **in-memory cache** (`Map` keyed by query+variables) so repeated calls in a session don't re-hit the API;
  - a **retry loop** (3 attempts, growing backoff) for transient 5xx/network failures — OpenBeta's gateway intermittently returns `502` and a deep traversal makes many requests. 4xx errors throw immediately (retrying wouldn't help).
- **Three query strings** (`SEARCH_AREAS_QUERY`, `GET_AREA_QUERY`, `GET_CLIMB_QUERY`) using GraphQL **variables**, not string interpolation (injection-safe).
- **Mappers** (`toArea`, `toClimb`, `coords`) — translate OpenBeta's raw shape (`area_name`, nested `grades.vscale`, nulls everywhere) into our clean types, filling holes with `??` defaults and forcing `isBoulder` to a real boolean.
- **`getAreaProblems()`** — the centerpiece. A recursive `walk()` descends the area tree to the leaves, collecting boulders. Safeguards: depth cap (6), a `Set` to de-dupe by climb UUID, and a **`totalClimbs === 0` prune** that skips empty branches (the key speedup that also avoids hammering the API).
- **`searchAreas` / `getArea` / `getProblemDetails`** — thin public functions composing the above.

### `src/core/pyramid.ts` — pure grade math
`buildPyramid(ticks)` tallies **only `sent` ticks** by grade into a contiguous ladder from lowest to highest grade, then flags **gaps** with one documented heuristic: a grade is a gap if the rung below has 3+ sends while this rung has 0–1. Pure function — no network, unit-testable with no mocks.

### `src/core/recommend.ts` — the showpiece logic
`recommendNext(ticks, areaUuid)`:
1. Fetch all boulders under the area + the area name (in parallel via `Promise.all`).
2. Drop climbs already sent (matched by normalized name + base grade).
3. Compute the **working grade** (highest grade with a solid 3+ base; reuses `buildPyramid`).
4. **Score** each remaining climb by distance from the working grade (at-level best, one above = "project", far easier/harder de-prioritized).
5. **Group by wall** (immediate parent area), sort within a wall by score then `leftRightIndex`.

Returns only factual fields. No prose, no style words — the tool boundary is sacred.

### `src/mcp/tools.ts` — the five thin wrappers
Each tool: a `zod` `inputSchema` (runtime validation of Claude's arguments) → call the matching core function → wrap in MCP's `{ content: [{ type: "text", text: ... }] }` envelope via `asText()`. The `description` strings are deliberately written to tell Claude these are **grade/location-based with no style judgments**, so it doesn't over-claim when narrating.

### `src/mcp/index.ts` — bootstrap
Instantiates `McpServer`, registers all five tools in a loop, connects over `StdioServerTransport`. Logs only to **stderr** (stdout is the protocol channel — a stray `console.log` would corrupt it).

### Tests
- `src/tests/pyramid.test.ts` — unit tests for level tallying, contiguous rungs, gap detection, non-sent/unparseable filtering, empty input.
- `src/tests/openbeta.test.ts` — live integration test against The Chief; skipped unless `RUN_INTEGRATION=1` so CI/offline runs stay green.

---

## 4. The five tools

| Tool | Input | Core call | Purpose |
|---|---|---|---|
| `search_areas` | `{ name }` | `searchAreas` | Find areas/crags by name; returns UUIDs, location, sub-areas. |
| `get_area_problems` | `{ areaUuid }` | `getAreaProblems` | List all boulders under an area, traversing sub-areas. |
| `get_problem_details` | `{ climbUuid }` | `getProblemDetails` | Full detail on one problem incl. verbatim description. |
| `get_pyramid` | `{ ticks }` | `buildPyramid` | Build the climber's grade pyramid and show gaps. |
| `recommend_next` | `{ ticks, areaUuid }` | `recommendNext` | Rank unclimbed problems by grade fit, grouped by wall. The showpiece. |

---

## 5. Hard rules — all honored
- **No guessing / no style inference** anywhere; descriptions surfaced **verbatim**.
- **Reliable fields only** — grades (`vscale`), hierarchy (`pathTokens`), location (`lat`/`lng`). Nothing depends on descriptions, photos, or style tags.
- **No Claude/Anthropic calls inside any tool.**
- **Thin tools over a fat core**; `core/` has zero MCP imports.
- **Strict typing** throughout; no unflagged `any`.

---

## 6. Deviations from the spec (necessary, none change the design)
1. **`tsconfig.json` needs `"types": ["node"]`** — the installed toolchain (TypeScript 6, `@types/node` 26) doesn't auto-load node globals without it; the spec's tsconfig alone failed to compile.
2. **Test script uses a glob** (`node --test "build/tests/*.test.js"`) — this Node (v22) doesn't accept a bare directory argument.
3. **Two robustness additions** in `openbeta.ts`: retry on 5xx/network errors, and skip child areas with `totalClimbs === 0`. Without these, the Chief traversal failed on a transient 502.

---

## 7. Verification performed
- ✅ `tsc` builds clean; all 5 tools register; full MCP stdio round-trip confirmed.
- ✅ `get_pyramid` correctly flags a V4 gap from a V2×3 / V3×3 tick list.
- ✅ `recommend_next` against The Chief → working grade V3, 21 walls grouped and ranked.
- ✅ `getAreaProblems` traverses (Chief: full tree; Thighmaster leaf: 24 problems).
- ✅ `getProblemDetails` works live and returns populated `pathTokens` (**previously untested; now confirmed**).
- ✅ `searchAreas` returns populated `pathTokens`.
- ✅ Unit tests (pyramid) + integration test (openbeta) green.

---

## 8. 🐞 Faults found

### P1 — fix soon
1. **`recommend.ts` has no tests and is untestable as written.** The showpiece holds the most logic yet calls the network directly, so it can't be unit-tested. **Fix:** extract a pure `rankAndGroup(climbs, ticks, areaName): RecommendationSet`; `recommendNext` just fetches then calls it. Highest-value change.
2. **OpenBeta returns mixed-case grades** — a live probe came back `"v4"` while the pyramid emits `"V4"`. Parsing is unaffected (case-insensitive regex), but Claude sees inconsistent casing. **Fix:** `raw.grades?.vscale?.toUpperCase()` in `toClimb` (use `.toUpperCase()`, not `normalizeVGrade`, so ranges like `"V4-6"` survive).
3. **No request timeout.** A hung connection blocks forever and never triggers the retry loop (a hang isn't a throw). **Fix:** add an `AbortController` ~10s timeout per attempt, counted as a retryable failure.

### P2 — design smells / latent risk
4. **`recommend_next` has no result cap** — a big crag dumps every candidate into Claude's context. **Fix:** optional `limit` (top N per wall).
5. **Depth cap (6) truncates silently.** **Fix:** stderr warning when hit.
6. **`totalClimbs === 0` pruning trusts the count** — fast and effective, but an unstated assumption. Comment it; watch it.
7. **Ungraded climbs are labeled `"at-level"`** in recommendations — misleading. **Fix:** separate treatment or drop them.
8. **Cache is unbounded and never invalidated** — fine for a session-scoped server; a problem only if this becomes a long-lived backend.

---

## 9. 🧪 Things to test
- **Manual acceptance in Claude Desktop** (spec §10, not yet done): search Squamish → list Chief problems → build pyramid → "what next?" — and **confirm Claude invents no style labels**. The real end-to-end proof.
- **`rankAndGroup` unit tests** (after refactor): exclusion, working-grade selection, tiering, within-wall ordering, ungraded handling.
- **Grade-parsing edge cases**: `"V4-6"`, `"v4"`, `"V10"`, `"VB"`, `null`.
- **`getProblemDetails` integration test** — lock in the now-confirmed behavior.
- **`gql` error paths** — 4xx throws immediately; 5xx retries then throws.

---

## 10. 🧭 Next steps, in order
1. Extract `rankAndGroup` + add its unit tests (fault #1).
2. Fix grade casing (#2) and add the fetch timeout (#3).
3. Run the manual Claude Desktop acceptance pass (§9).
4. Add `limit` to `recommend_next` (#4) and the depth-cap warning (#5).
5. Backfill remaining tests.

None are blockers — what's pushed is a working, spec-compliant one-shot. #1 and #2 are the two to do before showing it off: one is about trust (tests on the showpiece), the other is visible polish.

---

## 11. Out of scope (per spec — do not build here)
Style/movement tagging, photo/media handling, community tick aggregation, any database/auth/web server, any Anthropic API calls. These belong to the future app.

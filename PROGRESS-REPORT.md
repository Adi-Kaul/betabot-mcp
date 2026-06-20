# BetaBot-MCP — Progress Report & Next Steps

A single-document record of what was built, how it works, what's verified, and what to do next.

---

## 1. What this project is

BetaBot-MCP is a standalone, open-source **Model Context Protocol (MCP) server** written in TypeScript. It exposes the public **OpenBeta** climbing database to Claude as a set of bouldering-progression tools. A climber logs what they've sent; Claude uses the tools to reason about what to try next at a given area, how strong the climber is, and where their weaknesses lie — grounded entirely in **grade, area hierarchy, and location**, never in guessed climbing style.

It talks to the OpenBeta GraphQL API (`https://api.openbeta.io`, no auth) and speaks to Claude over **stdio**.

**Core principle:** facts in, facts out — Claude does the talking. The server fetches, ranks, and analyses deterministically; it never writes prose, never calls an LLM, and never invents a climb's style. Every tool returns structured facts; the *interpretation, evidence, and coaching narrative* are the model's job on the other side of the tool boundary.

---

## 2. Architecture

```
Claude  <--stdio-->  mcp/index.ts  -->  mcp/tools.ts  -->  core/*  -->  OpenBeta API
         (talks)      (the server)      (the wrappers)   (the brains)   (the data)
```

The defining decision is **thin tools over a fat core**:
- All real logic lives in `src/core/` and has **zero MCP-specific imports**, so it can later lift into a mobile-app backend untouched.
- The MCP tools in `src/mcp/` are dumb adapters: validate input → call a core function → format output.

This split is also what makes the product vision (a part-conversational app where the LLM reasons over climbing data) viable: the **core supplies deterministic facts**, the **app renders them** (charts, profile screens), and the **LLM narrates the why**. Each layer owns exactly one thing.

---

## 3. File-by-file: what each does and how

### `src/core/types.ts` — the vocabulary
Defines the shared data shapes (`Area`, `Climb`, `Tick`, `Pyramid`, `Coordinates`, etc.) as TypeScript interfaces, plus the grade math:
- `V_GRADES` — a local `V0..V17` ordering (no external grade library).
- `parseVGrade()` — regex `/V\s*(\d+)/i` pulls the base integer out of a grade string. Handles ranges (`"V4-6"` → `4`), lowercase (`"v4"` → `4`), and returns `null` for non-numeric grades (`"VB"`).
- `normalizeVGrade()` / `compareGrades()` — canonical label and numeric comparison built on top.
- **`ClimbType` + `CLIMB_TYPES`** — a fixed wall-angle enum (`slab`, `vertical`, `overhang`, `roof`, `arete`, `dihedral`, `compression`). A `Tick` now carries an **optional `type`** — a *fact the climber supplies*, never inferred by us.

Pattern: **normalize messy input into clean types at the boundary**, so the rest of the code works with clean values.

### `src/core/geo.ts` — proximity math
`haversineKm(a, b)` — great-circle distance in kilometres between two lat/lng points. Pure, no network, unit-tested. Used to rank crags by distance from a center point.

### `src/core/openbeta.ts` — the data layer (the meatiest file)
Everything that touches the network.
- **`gql()`** — one helper that POSTs a GraphQL query + variables and returns parsed `data`. Includes an **in-memory cache** (keyed by query+variables) and a **retry loop** (3 attempts, growing backoff) for transient 5xx/network failures. 4xx errors throw immediately.
- **Three query strings** (`SEARCH_AREAS_QUERY`, `GET_AREA_QUERY`, `GET_CLIMB_QUERY`) using GraphQL **variables**, not string interpolation (injection-safe). Areas and climbs request `metadata { lat lng }`.
- **Mappers** (`toArea`, `toClimb`, `coords`) — translate OpenBeta's raw shape into our clean types, filling holes with `??` defaults and forcing `isBoulder` to a real boolean.
- **`getAreaProblems()`** — the centerpiece traversal. A recursive `walk()` descends the area tree to the leaves, collecting boulders. Safeguards: depth cap (6), a `Set` to de-dupe by climb UUID, and a `totalClimbs === 0` prune that skips empty branches. **New:** when a boulder has no `lat`/`lng` of its own (most don't), it falls back to the **leaf crag's** coordinates so proximity ranking has data to work with.
- **`searchAreas` / `getArea` / `getProblemDetails`** — thin public functions composing the above.

### `src/core/pyramid.ts` — pure grade math & analysis
Pure functions, no network, unit-testable with no mocks.
- **`buildPyramid(ticks)`** — tallies **only `sent` ticks** by grade into a contiguous ladder, then flags **gaps** (a grade is a gap if the rung below has 3+ sends while this rung has 0–1).
- **`workingGradeNum(pyramid)`** — shared helper: highest grade with a solid 3+ base, else highest with any send.
- **`buildTypedPyramids(ticks)`** — partitions *typed* sends by wall angle and builds one pyramid per logged type (reuses `buildPyramid`). Untyped ticks are ignored here.
- **`weakestTypes(ticks)`** — the "mixed" view: ranks the climber's logged types **weakest-first** by how far each type's working grade lags their overall working grade. The training-priority signal.
- **`assessLevel(ticks)`** — the climber-level assessment. Returns the headline `level` (consolidated grade, else hardest send, else `V0`), distinct facets (`hardestGrade`, `consolidatedGrade`), the per-grade `breakdown` (chart data), and supporting counts (`totalSends`, `sendsAtLevel`). Pure facts — no prose, no presentation.

### `src/core/recommend.ts` — the showpiece logic
`recommendNext(ticks, areaUuid, options?)`:
1. Fetch all boulders under the area + the area itself (in parallel via `Promise.all`).
2. Drop climbs already sent (matched by normalized name + base grade).
3. Compute the **working grade** (reuses `buildPyramid`).
4. **Score** each remaining climb by distance from the working grade (at-level best, one above = "project", far easier/harder de-prioritized).
5. **Location:** establish a proximity **center** — the app-supplied `userLocation` (true "near me") if present, else the anchor area's own coordinates. Compute each climb's `distanceKm` from it; optionally drop climbs beyond `maxDistanceKm`.
6. **Group by wall/crag** (immediate parent area). When a center exists, groups are ordered **nearest-first** (grade-fit breaks ties); otherwise by grade-fit. Within a crag, climbs sort by grade-fit then `leftRightIndex`.

`options`: `{ userLocation?: Coordinates; maxDistanceKm?: number }`. Returns only factual fields (incl. per-climb and per-crag `distanceKm`). No prose, no style words.

### `src/mcp/tools.ts` — the tool wrappers
Each tool: a `zod` `inputSchema` (runtime validation of Claude's arguments) → call the matching core function → wrap in MCP's `{ content: [{ type: "text", text }] }` envelope via `asText()`. The shared `tickSchema` now accepts an **optional `type`** (the wall-angle enum) so typed ticks flow through without affecting untyped flows. Descriptions tell Claude these are grade/location-based with no style judgments.

### `src/mcp/index.ts` — bootstrap
Instantiates `McpServer`, registers the active tools in a loop, connects over `StdioServerTransport`. Logs only to **stderr** (stdout is the protocol channel).

### Tests
- `src/tests/pyramid.test.ts` — unit tests for level tallying, gaps, typed pyramids, weakest-type ranking, and `assessLevel` (facets, fallback, empty).
- `src/tests/geo.test.ts` — unit tests for `haversineKm` (zero, known distance, symmetry).
- `src/tests/openbeta.test.ts` — live integration test against The Chief; skipped unless `RUN_INTEGRATION=1`.

---

## 4. The tools

Six tools are always registered; one more is opt-in behind a flag.

| Tool | Input | Core call | Purpose |
|---|---|---|---|
| `search_areas` | `{ name }` | `searchAreas` | Find areas/crags by name; returns UUIDs, location, sub-areas. |
| `get_area_problems` | `{ areaUuid }` | `getAreaProblems` | List all boulders under an area, traversing sub-areas. |
| `get_problem_details` | `{ climbUuid }` | `getProblemDetails` | Full detail on one problem incl. verbatim description. |
| `get_pyramid` | `{ ticks }` | `buildPyramid` | Build the climber's grade pyramid and show gaps. |
| `get_climber_level` | `{ ticks }` | `assessLevel` | Assess level: headline + facets + send breakdown (chart data) + counts. |
| `recommend_next` | `{ ticks, areaUuid, userLocation?, maxDistanceKm? }` | `recommendNext` | Rank unclimbed problems by grade fit, grouped by crag, ordered by proximity. The showpiece. |
| `get_typed_pyramid` *(opt-in)* | `{ ticks }` | `buildTypedPyramids` + `weakestTypes` | Per-type grade pyramids + weakest-type ranking. **Gated behind `BETABOT_TYPED_PYRAMID=1`.** |

**Scope vs. proximity in `recommend_next`:** the `areaUuid` sets *how wide to search* (crag → region → country); `userLocation` sets *where the climber is* for nearest-first ranking; `maxDistanceKm` is an optional hard radius. All three are independent and degrade gracefully when absent.

---

## 5. The typed-pyramid feature (opt-in, dormant by default)

Per-type ("slab pyramid") and mixed ("what's my weakest type") analysis is **built and tested but off by default**, because the type data isn't available yet:
- **`type` is accepted but optional** on every tick — untyped flows are unchanged.
- **`get_typed_pyramid` is only registered when `BETABOT_TYPED_PYRAMID=1`.** Off by default, Claude never sees it. With no typed data it returns empty rather than guessing.
- **Climb types are facts from the climber's own ticks**, never inferred from names/descriptions. Typing *candidate* climbs for type-specific recommendations is deferred to a **future curated type DB** — doing it from descriptions would violate the no-style-inference rule.

To go live later: the consuming app starts logging wall-angle types on ticks, then the server sets `BETABOT_TYPED_PYRAMID=1`. No code change required.

---

## 6. Hard rules — all honored
- **No guessing / no style inference** anywhere; descriptions surfaced **verbatim**. Climb *type* is used only when the climber supplied it as a fact.
- **Reliable fields only** — grades (`vscale`), hierarchy (`pathTokens`), location (`lat`/`lng`).
- **No Claude/Anthropic calls inside any tool.** Tools emit facts; the model narrates.
- **Thin tools over a fat core**; `core/` has zero MCP imports.
- **Strict typing** throughout; no unflagged `any`.

---

## 7. Verification performed
- ✅ `tsc` builds clean; all tools register (6 default; 7 with `BETABOT_TYPED_PYRAMID=1`).
- ✅ Unit tests green: `pyramid.test.ts` (10 — pyramid, typed pyramids, weakest types, `assessLevel`) and `geo.test.ts` (3 — haversine).
- ✅ Tool-list verified in both flag states (`get_typed_pyramid` appears only when enabled).
- ✅ `get_pyramid` correctly flags a V4 gap from a V2×3 / V3×3 tick list.
- ✅ `recommend_next` against The Chief → working grade V3, walls grouped and ranked; location ranking is additive and falls back cleanly when coords are absent.
- ✅ Live integration (`openbeta.test.ts`) traverses The Chief and returns populated `pathTokens`.

---

## 8. 🐞 Faults & open risks

### P1 — fix soon
1. **`recommend.ts` is still untested and untestable as written.** It now holds grade-fit *and* location logic but calls the network directly, so none of it is unit-covered (only the pure `haversineKm` is). **Fix:** extract a pure `rankAndGroup(climbs, ticks, area, options)`; `recommendNext` just fetches then calls it. Highest-value change — and the natural home for location/ranking tests.
2. **OpenBeta returns mixed-case grades** (`"v4"` vs our `"V4"`). Parsing is unaffected (case-insensitive), but Claude sees inconsistent casing. **Fix:** `raw.grades?.vscale?.toUpperCase()` in `toClimb`.
3. **No request timeout.** A hung connection blocks forever and never triggers the retry loop. **Fix:** `AbortController` ~10s per attempt, counted as retryable.

### P2 — design smells / latent risk
4. **`recommend_next` has no result cap.** A big crag (or country scope) dumps every candidate into context. **Fix:** optional `limit` (top N per crag). Location capping (`maxDistanceKm`) helps but isn't a count cap.
5. **Proximity center is the area centroid by default.** Without `userLocation`, a country-scope search ranks crags by distance from the country's geographic center — only a rough proxy for "near the climber." Real "near me" requires the app to pass `userLocation`.
6. **Leaf-crag coordinate fallback** means a climb's `distanceKm` may reflect its crag, not the exact boulder. Fine for ranking; document it.
7. **Depth cap (6) truncates silently.** **Fix:** stderr warning when hit.
8. **Cache is unbounded and never invalidated** — fine for a session-scoped server; revisit if this becomes a long-lived backend.

---

## 9. 🧪 Things to test
- **Manual acceptance in Claude Desktop** (still not done): search → list problems → pyramid → level → "what next?" with a real tick list and a `userLocation`, and **confirm Claude invents no style labels**. The real end-to-end proof.
- **`rankAndGroup` unit tests** (after refactor): exclusion, working-grade selection, tiering, proximity ordering, `maxDistanceKm` capping, no-center fallback.
- **Grade-parsing edge cases**: `"V4-6"`, `"v4"`, `"V10"`, `"VB"`, `null`.
- **Typed pyramid with real typed ticks** (once a data source exists): partitioning, weakest-type ordering, empty/untyped behavior.
- **`gql` error paths** — 4xx throws immediately; 5xx retries then throws.

---

## 10. 🧭 Next steps, in order
1. Extract `rankAndGroup` + add its unit tests, now covering grade-fit *and* location (fault #1).
2. Make tool outputs **self-explaining** — surface the rationale (working grade, gap filled, grade delta, proximity rank) as structured facts so the LLM's "why" is grounded, not invented. This directly unlocks the evidence/coaching half of the product vision.
3. Fix grade casing (#2) and add the fetch timeout (#3).
4. Run the manual Claude Desktop acceptance pass (§9).
5. Add `limit` to `recommend_next` (#4) and the depth-cap warning (#7).
6. When a type data source exists, flip on `BETABOT_TYPED_PYRAMID` and add typed-pyramid tests.

---

## 11. Out of scope (per spec — do not build here)
Inferring style/movement from descriptions or photos, photo/media handling, community tick aggregation, any database/auth/web server, any Anthropic API calls. Climb *type* is in scope **only** as a climber-supplied fact, and typing *candidate* climbs waits on a future curated DB. Persistence (logbook, auth, GPS capture) and rendering (charts, profile UI) belong to the consuming app.

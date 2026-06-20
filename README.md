# BetaBot-MCP

An MCP server that exposes the [OpenBeta](https://openbeta.io) climbing database to Claude as a set of bouldering-progression tools.

## What it does

You tell Claude what boulders you've sent; BetaBot-MCP fetches real route data from OpenBeta and lets Claude reason about how strong you are, where your weaknesses lie, and what to try next at a given area — grounded entirely in **grade, location, and area hierarchy**. It never guesses or labels a climb's style.

The server talks to the public OpenBeta GraphQL API (`https://api.openbeta.io`, no auth) and speaks to Claude over stdio. All real logic lives in `src/core/` (network, grade math, analysis, ranking) with thin tool wrappers in `src/mcp/`, so the data/logic layer can later lift into a mobile-app backend untouched. Every tool returns **structured facts only** — the app renders them (charts, profile screens) and the model narrates the why.

## Tools

| Tool | What it does |
|---|---|
| `search_areas` | Find climbing areas/crags by name; returns UUIDs, location, and sub-areas. |
| `get_area_problems` | List all boulder problems under an area, traversing sub-areas down to leaf crags. |
| `get_problem_details` | Full detail on one problem, including its verbatim description. |
| `get_pyramid` | Build the climber's grade pyramid from their ticks and show where grade gaps are. |
| `get_climber_level` | Assess the climber's level: headline grade, facets (hardest send, consolidated grade), and a per-grade send breakdown for charting. |
| `recommend_next` | Rank unclimbed problems under an area by grade fit, grouped by crag and ordered by proximity. The showpiece. |
| `get_typed_pyramid` *(opt-in)* | Per-type grade pyramids and weakest-type ranking. Disabled unless `BETABOT_TYPED_PYRAMID=1` (see below). |

### Location & scope in `recommend_next`

`recommend_next` takes optional location inputs:
- **`areaUuid`** sets *how wide to search* — a single crag, a region, or a whole country.
- **`userLocation`** (`{ lat, lng }`) sets *where the climber is*; crags are ordered nearest-first to it. Omit it and the anchor area's own center is used.
- **`maxDistanceKm`** optionally caps how far out to include.

All three are independent and degrade gracefully — with no coordinates at all it simply ranks by grade fit.

### Optional: per-type ("slab") pyramids

`get_typed_pyramid` builds a separate grade pyramid per wall-angle type (slab, overhang, etc.) and ranks your weakest types. It's **off by default** because it needs per-tick `type` data the consuming app must supply. Types are taken only from the climber's own ticks — never inferred from names or descriptions. Enable it by setting `BETABOT_TYPED_PYRAMID=1` in the server environment; until then it isn't registered.

## Install

Requires Node.js 20+.

```bash
npm install
npm run build
```

Run the test suite (unit tests only; the network integration test is skipped by default):

```bash
npm test
# include the live OpenBeta integration test:
npm run test:integration
```

## Claude Desktop config

Add to your Claude Desktop config, pointing at the built entry point:

```json
{
  "mcpServers": {
    "betabot": {
      "command": "node",
      "args": ["/absolute/path/to/betabot-mcp/build/mcp/index.js"]
    }
  }
}
```

Config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after editing.

## Example

> **You:** Search for Squamish's Stawamus Chief.
>
> **Claude** *(calls `search_areas`)*: Found **Stawamus Chief** (`8f267065-…`), 368 climbs, in Squamish, BC.
>
> **You:** Here are my recent sends — three V2s and three V3s. What should I try next at the Chief?
>
> **Claude** *(calls `recommend_next`)*: Your working grade is **V3** (you have a solid base there, with a gap at V4). Here are unclimbed boulders at the Chief, grouped by wall and ranked by grade fit:
>
> - **Grand Wall Boulders** — *The Egg* (V3, at-level), *Easy in an Easy Chair* (V4, project)…
> - **Apron Boulders** — …
>
> These are ranked purely by grade and location — I don't have movement/style data, so I can't tell you which are slabs or overhangs, only how they fit your grade and where they are.

## Data & honesty

BetaBot-MCP uses only the three consistently-populated OpenBeta field groups: **grades** (`vscale`), **hierarchy** (`pathTokens`), and **location** (`lat`/`lng`). It never infers or asserts a climb's *style* (slab, compression, slopers, etc.). When a climb has a text description, it is surfaced **verbatim** — never paraphrased into a style claim.

Every tool returns **only factual fields** — grades, counts, distributions, distances — and never prose or presentation. The app renders the data (e.g. a level breakdown as a pie chart); the model composes the coaching narrative from the facts without over-claiming. Climb *type* is honored only when the climber supplied it as a fact on a tick; typing routes you haven't logged is deliberately out of scope.

## License

MIT

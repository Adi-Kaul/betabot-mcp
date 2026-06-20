# BetaBot-MCP

An MCP server that exposes the [OpenBeta](https://openbeta.io) climbing database to Claude as a set of bouldering-progression tools.

## What it does

You tell Claude what boulders you've sent; BetaBot-MCP fetches real route data from OpenBeta and lets Claude reason about what you should try next at a given crag — grounded entirely in **grade, location, and area hierarchy**. It never guesses or labels a climb's style.

The server talks to the public OpenBeta GraphQL API (`https://api.openbeta.io`, no auth) and speaks to Claude over stdio. All real logic lives in `src/core/` (network, grade math, ranking) with thin tool wrappers in `src/mcp/`, so the data/logic layer can later lift into a mobile-app backend untouched.

## Tools

| Tool | What it does |
|---|---|
| `search_areas` | Find climbing areas/crags by name; returns UUIDs, location, and sub-areas. |
| `get_area_problems` | List all boulder problems under an area, traversing sub-areas down to leaf crags. |
| `get_problem_details` | Full detail on one problem, including its verbatim description. |
| `get_pyramid` | Build the climber's grade pyramid from their ticks and show where grade gaps are. |
| `recommend_next` | Rank unclimbed problems at a crag by grade fit and group them by wall. The showpiece. |

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

BetaBot-MCP uses only the three consistently-populated OpenBeta field groups: **grades** (`vscale`), **hierarchy** (`pathTokens`), and **location** (`lat`/`lng`). It never infers or asserts a climb's *style* (slab, compression, slopers, etc.). When a climb has a text description, it is surfaced **verbatim** — never paraphrased into a style claim. Recommendations contain only factual fields, leaving Claude to compose the coaching narrative without over-claiming.

## License

MIT

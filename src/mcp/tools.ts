// Five thin tool wrappers: validate input with zod, call the matching core
// function, return the result as pretty JSON text. No logic lives here.

import { z, type ZodRawShape } from "zod";
import {
  searchAreas,
  getAreaProblems,
  getProblemDetails,
} from "../core/openbeta.js";
import { buildPyramid, buildTypedPyramids, weakestTypes } from "../core/pyramid.js";
import { recommendNext } from "../core/recommend.js";
import { CLIMB_TYPES, type ClimbType, type Tick } from "../core/types.js";

const tickSchema = z.object({
  climbName: z.string(),
  vGrade: z.string(),
  status: z.enum(["sent", "attempt", "project"]),
  // Wall-angle type as recorded by the climber on this tick. Optional: untyped
  // ticks work everywhere; typing is purely additive. Never inferred by us.
  type: z.enum(CLIMB_TYPES as [ClimbType, ...ClimbType[]]).optional(),
  attempts: z.number().optional(),
  date: z.string().optional(),
});

// Typed-pyramid analysis is dormant until a deployment opts in by setting
// BETABOT_TYPED_PYRAMID=1. Off by default: the tool isn't registered, so
// Claude never sees it. Flip it on once ticks start carrying types.
const TYPED_PYRAMID_ENABLED = process.env.BETABOT_TYPED_PYRAMID === "1";

const NO_STYLE_NOTE =
  "Recommendations are based only on grade, location, and area hierarchy — never on climbing style or movement. Do not invent style labels (slab, slopers, compression, etc.) when narrating.";

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export interface ToolDef {
  name: string;
  config: { title: string; description: string; inputSchema: ZodRawShape };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler args are validated by the SDK against inputSchema
  handler: (args: any) => Promise<ReturnType<typeof asText>>;
}

export const tools: ToolDef[] = [
  {
    name: "search_areas",
    config: {
      title: "Search climbing areas",
      description:
        "Find climbing areas/crags by name; returns UUIDs, location (lat/lng), and sub-areas. Use the returned UUID with the other tools.",
      inputSchema: { name: z.string() },
    },
    handler: async ({ name }: { name: string }) => asText(await searchAreas(name)),
  },
  {
    name: "get_area_problems",
    config: {
      title: "List boulder problems in an area",
      description:
        "List all boulder problems under an area, traversing sub-areas down to leaf crags. Returns name, grade, location, and verbatim description only.",
      inputSchema: { areaUuid: z.string() },
    },
    handler: async ({ areaUuid }: { areaUuid: string }) => asText(await getAreaProblems(areaUuid)),
  },
  {
    name: "get_problem_details",
    config: {
      title: "Get one problem's details",
      description:
        "Full detail on one boulder problem including its verbatim description. The description is surfaced as-is and never interpreted into a style claim.",
      inputSchema: { climbUuid: z.string() },
    },
    handler: async ({ climbUuid }: { climbUuid: string }) => asText(await getProblemDetails(climbUuid)),
  },
  {
    name: "get_pyramid",
    config: {
      title: "Build grade pyramid",
      description:
        "Build the climber's grade pyramid from their ticks and show where grade gaps are. Tallies only sent ticks by V-grade; purely numerical, no style judgments.",
      inputSchema: { ticks: z.array(tickSchema) },
    },
    handler: async ({ ticks }: { ticks: Tick[] }) => asText(buildPyramid(ticks)),
  },
  {
    name: "recommend_next",
    config: {
      title: "Recommend next problems",
      description:
        `Rank unclimbed boulder problems at a crag by grade fit and group them by wall. The showpiece tool. ${NO_STYLE_NOTE}`,
      inputSchema: { ticks: z.array(tickSchema), areaUuid: z.string() },
    },
    handler: async ({ ticks, areaUuid }: { ticks: Tick[]; areaUuid: string }) =>
      asText(await recommendNext(ticks, areaUuid)),
  },
];

// Optional, flag-gated. Groups the climber's logged sends by the wall-angle
// type they recorded on each tick, building a separate grade pyramid per type
// and ranking types weakest-first. Types are taken verbatim from the ticks,
// never inferred. Returns empty when no ticks carry a type.
const typedPyramidTool: ToolDef = {
  name: "get_typed_pyramid",
  config: {
    title: "Build per-type grade pyramids",
    description:
      `Build a separate grade pyramid for each wall-angle type the climber has logged (slab, overhang, etc.), and rank those types weakest-first by how far each lags their overall working grade — to surface what to train next. Types come only from the climber's own ticks; ${NO_STYLE_NOTE}`,
    inputSchema: { ticks: z.array(tickSchema) },
  },
  handler: async ({ ticks }: { ticks: Tick[] }) =>
    asText({ typed: buildTypedPyramids(ticks), weakest: weakestTypes(ticks) }),
};

if (TYPED_PYRAMID_ENABLED) {
  tools.push(typedPyramidTool);
}

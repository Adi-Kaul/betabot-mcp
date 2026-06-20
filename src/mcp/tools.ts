// Five thin tool wrappers: validate input with zod, call the matching core
// function, return the result as pretty JSON text. No logic lives here.

import { z, type ZodRawShape } from "zod";
import {
  searchAreas,
  getAreaProblems,
  getProblemDetails,
} from "../core/openbeta.js";
import { buildPyramid } from "../core/pyramid.js";
import { recommendNext } from "../core/recommend.js";
import type { Tick } from "../core/types.js";

const tickSchema = z.object({
  climbName: z.string(),
  vGrade: z.string(),
  status: z.enum(["sent", "attempt", "project"]),
  attempts: z.number().optional(),
  date: z.string().optional(),
});

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

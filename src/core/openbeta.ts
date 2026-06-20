// All OpenBeta GraphQL access: a single gql() helper, the validated queries,
// typed mappers, and recursive leaf-climb collection. No MCP imports here.

import type { Area, Climb, Coordinates } from "./types.js";

const OPENBETA_ENDPOINT = "https://api.openbeta.io";

// --- Raw GraphQL shapes (only the fields we request) --------------------

interface RawCoords {
  lat: number | null;
  lng: number | null;
}

interface RawChild {
  area_name: string;
  uuid: string;
  totalClimbs: number | null;
}

interface RawClimb {
  name: string;
  uuid: string;
  grades?: { vscale?: string | null } | null;
  type?: { bouldering?: boolean | null } | null;
  metadata?: (RawCoords & { leftRightIndex?: number | null }) | null;
  content?: { description?: string | null } | null;
  pathTokens?: string[] | null;
}

interface RawArea {
  area_name: string;
  uuid: string;
  totalClimbs: number | null;
  pathTokens?: string[] | null;
  metadata?: RawCoords | null;
  children?: RawChild[] | null;
  climbs?: RawClimb[] | null;
}

// --- gql helper + cache -------------------------------------------------

const cache = new Map<string, unknown>();

/**
 * POST a GraphQL query to OpenBeta and return the parsed `data` object.
 * Throws a clear error on network failure or GraphQL errors. Results are
 * memoized per (query + variables) for the lifetime of the process.
 */
export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify({ query, variables });
  const cached = cache.get(key);
  if (cached !== undefined) return cached as T;

  // Retry transient network/5xx failures with a short backoff; the OpenBeta
  // gateway occasionally returns 502 under load and a deep traversal makes
  // many requests.
  const maxAttempts = 3;
  let res: Response | undefined;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch(OPENBETA_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      lastErr = new Error(`OpenBeta request failed (network): ${(err as Error).message}`);
      res = undefined;
    }

    if (res && res.ok) break;
    if (res && res.status < 500) {
      throw new Error(`OpenBeta request failed: HTTP ${res.status} ${res.statusText}`);
    }
    if (res) lastErr = new Error(`OpenBeta request failed: HTTP ${res.status} ${res.statusText}`);
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  if (!res || !res.ok) {
    throw lastErr ?? new Error("OpenBeta request failed");
  }

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors && body.errors.length > 0) {
    throw new Error(`OpenBeta GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined || body.data === null) {
    throw new Error("OpenBeta returned no data");
  }

  cache.set(key, body.data);
  return body.data;
}

/** Clear the in-memory query cache (used by tests). */
export function clearCache(): void {
  cache.clear();
}

// --- Queries ------------------------------------------------------------

const SEARCH_AREAS_QUERY = `
query($name: String!) {
  areas(filter: { area_name: { match: $name } }) {
    area_name
    uuid
    totalClimbs
    pathTokens
    metadata { lat lng }
    children { area_name uuid totalClimbs }
  }
}`;

const GET_AREA_QUERY = `
query($uuid: ID!) {
  area(uuid: $uuid) {
    area_name
    uuid
    pathTokens
    metadata { lat lng }
    totalClimbs
    children { area_name uuid totalClimbs }
    climbs {
      name
      uuid
      grades { vscale }
      type { bouldering }
      metadata { lat lng leftRightIndex }
      content { description }
    }
  }
}`;

const GET_CLIMB_QUERY = `
query($uuid: ID!) {
  climb(uuid: $uuid) {
    name
    uuid
    pathTokens
    grades { vscale }
    type { bouldering }
    metadata { lat lng leftRightIndex }
    content { description }
  }
}`;

// --- Mappers ------------------------------------------------------------

function coords(meta: RawCoords | null | undefined): Coordinates | undefined {
  if (!meta || meta.lat === null || meta.lat === undefined || meta.lng === null || meta.lng === undefined) {
    return undefined;
  }
  return { lat: meta.lat, lng: meta.lng };
}

function toArea(raw: RawArea): Area {
  return {
    name: raw.area_name,
    uuid: raw.uuid,
    totalClimbs: raw.totalClimbs ?? 0,
    path: raw.pathTokens ?? [],
    coordinates: coords(raw.metadata),
    children: (raw.children ?? []).map((c) => ({
      name: c.area_name,
      uuid: c.uuid,
      totalClimbs: c.totalClimbs ?? 0,
    })),
  };
}

function toClimb(raw: RawClimb, areaPath: string[]): Climb {
  const lri = raw.metadata?.leftRightIndex;
  return {
    name: raw.name,
    uuid: raw.uuid,
    vGrade: raw.grades?.vscale ?? null,
    isBoulder: raw.type?.bouldering === true,
    coordinates: coords(raw.metadata),
    leftRightIndex: lri === null || lri === undefined ? undefined : lri,
    description: raw.content?.description ?? "",
    areaPath,
  };
}

// --- Public API ---------------------------------------------------------

export async function searchAreas(name: string): Promise<Area[]> {
  const data = await gql<{ areas: RawArea[] }>(SEARCH_AREAS_QUERY, { name });
  return (data.areas ?? []).map(toArea);
}

async function fetchAreaRaw(uuid: string): Promise<RawArea> {
  const data = await gql<{ area: RawArea | null }>(GET_AREA_QUERY, { uuid });
  if (!data.area) throw new Error(`No area found for uuid ${uuid}`);
  return data.area;
}

export async function getArea(uuid: string): Promise<Area> {
  return toArea(await fetchAreaRaw(uuid));
}

/**
 * Collect every boulder problem beneath `uuid`, traversing container areas
 * down to their leaves. Caps recursion depth and de-duplicates by climb uuid.
 */
export async function getAreaProblems(uuid: string, maxDepth = 6): Promise<Climb[]> {
  const seen = new Set<string>();
  const out: Climb[] = [];

  async function walk(areaUuid: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const raw = await fetchAreaRaw(areaUuid);
    const path = raw.pathTokens ?? [];

    for (const rc of raw.climbs ?? []) {
      const climb = toClimb(rc, path);
      if (!climb.isBoulder) continue;
      if (seen.has(climb.uuid)) continue;
      seen.add(climb.uuid);
      out.push(climb);
    }

    // Container: recurse into children to reach leaf climbs. Skip branches
    // with no climbs beneath them to avoid needless requests.
    for (const child of raw.children ?? []) {
      if ((child.totalClimbs ?? 0) === 0) continue;
      await walk(child.uuid, depth + 1);
    }
  }

  await walk(uuid, 0);
  return out;
}

export async function getProblemDetails(uuid: string): Promise<Climb> {
  const data = await gql<{ climb: RawClimb | null }>(GET_CLIMB_QUERY, { uuid });
  if (!data.climb) throw new Error(`No climb found for uuid ${uuid}`);
  return toClimb(data.climb, data.climb.pathTokens ?? []);
}

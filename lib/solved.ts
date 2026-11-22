import {
  SOLVED_TAG_CACHE_TTL_MS,
  SOLVED_V3_API_URL,
  SOLVED_V4_PROXY_URL,
} from "./constants.ts";
import type { BojProblemStats } from "./boj-parser.ts";

export interface SolvedTag {
  key: string;
  isMeta: boolean;
  bojTagId: number;
  problemCount: number;
  displayNames: {
    language: string;
    name: string;
    short: string;
  }[];
  aliases: string[];
}

export interface SolvedProblem {
  problemId: number;
  titleKo: string;
  titles: {
    language: string;
    languageDisplayName: string;
    title: string;
    isOriginal: boolean;
  }[];
  isSolvable: boolean;
  isPartial: boolean;
  acceptedUserCount: number | null;
  level: number;
  votedUserCount: number;
  sprout: boolean;
  givesNoRating: boolean;
  isLevelLocked: boolean;
  averageTries: number | null;
  official: boolean;
  tags: SolvedTag[];
  metadata: Record<string, unknown>;
}

export interface SolvedV4Problem {
  problemId: number;
  level?: number;
  solvedUserCount?: number;
  votedUserCount?: number;
  givesNoRating?: boolean;
  noRatingReasons?: string[];
  isStandard?: boolean;
  titles?: {
    language: string;
    title: string;
    isOriginal?: boolean;
  }[];
  tags?: {
    id?: number;
    key: string;
    isMeta?: boolean;
  }[];
}

export interface SolvedV4TagItem {
  id?: number;
  key: string;
  names?: Record<string, string>;
}

export interface SolvedTagCache {
  fetchedAt: number;
  names: Record<string, string>;
}

export interface SolvedFetchResponse {
  ok: boolean;
  data?: SolvedProblem;
  error?: string;
}

export function normalizeV4Problem(
  v4: SolvedV4Problem,
  tagNames: Record<string, string> = {}
): SolvedProblem {
  const rawTitles = Array.isArray(v4.titles) ? v4.titles : [];
  const preferredTitle =
    rawTitles.find((t) => t.language === "ko") ??
    rawTitles.find((t) => t.isOriginal) ??
    rawTitles[0];

  const givesNoRating = Boolean(v4.givesNoRating);
  const level = typeof v4.level === "number" ? v4.level : 0;

  return {
    problemId: v4.problemId,
    titleKo: preferredTitle?.title ?? "",
    titles: rawTitles.map((t) => ({
      language: t.language,
      languageDisplayName: t.language,
      title: t.title,
      isOriginal: Boolean(t.isOriginal),
    })),
    isSolvable: true,
    isPartial: false,
    acceptedUserCount:
      typeof v4.solvedUserCount === "number" ? v4.solvedUserCount : null,
    level,
    votedUserCount:
      typeof v4.votedUserCount === "number" ? v4.votedUserCount : 0,
    sprout: false,
    givesNoRating,
    isLevelLocked: givesNoRating,
    averageTries: null,
    official: true,
    tags: (Array.isArray(v4.tags) ? v4.tags : []).map((tag) => {
      const displayName = tagNames[tag.key] || tag.key;
      return {
        key: tag.key,
        isMeta: Boolean(tag.isMeta),
        bojTagId: typeof tag.id === "number" ? tag.id : 0,
        problemCount: 0,
        displayNames: [
          {
            language: "ko",
            name: displayName,
            short: displayName,
          },
        ],
        aliases: [],
      };
    }),
    metadata: {},
  };
}

export function normalizeV3Problem(v3: any): SolvedProblem {
  return {
    problemId: Number(v3.problemId),
    titleKo: typeof v3.titleKo === "string" ? v3.titleKo : "",
    titles: Array.isArray(v3.titles) ? v3.titles : [],
    isSolvable: Boolean(v3.isSolvable ?? true),
    isPartial: Boolean(v3.isPartial ?? false),
    acceptedUserCount:
      typeof v3.acceptedUserCount === "number" ? v3.acceptedUserCount : null,
    level: typeof v3.level === "number" ? v3.level : 0,
    votedUserCount:
      typeof v3.votedUserCount === "number" ? v3.votedUserCount : 0,
    sprout: Boolean(v3.sprout ?? false),
    givesNoRating: Boolean(v3.givesNoRating ?? false),
    isLevelLocked: Boolean(v3.isLevelLocked ?? v3.givesNoRating ?? false),
    averageTries:
      typeof v3.averageTries === "number" ? v3.averageTries : null,
    official: Boolean(v3.official ?? true),
    tags: Array.isArray(v3.tags) ? v3.tags : [],
    metadata: v3.metadata && typeof v3.metadata === "object" ? v3.metadata : {},
  };
}

export function buildFallbackProblem(
  problemId: string,
  bojStats?: BojProblemStats | null,
  fallbackTitle?: string
): SolvedProblem {
  const title = bojStats?.title || fallbackTitle || `${problemId}번 문제`;

  return {
    problemId: Number(problemId) || 0,
    titleKo: title,
    titles: [
      {
        language: "ko",
        languageDisplayName: "ko",
        title,
        isOriginal: true,
      },
    ],
    isSolvable: true,
    isPartial: false,
    acceptedUserCount: bojStats?.acceptedUserCount ?? null,
    level: 0,
    votedUserCount: 0,
    sprout: false,
    givesNoRating: false,
    isLevelLocked: false,
    averageTries: bojStats?.averageTries ?? null,
    official: true,
    tags: [],
    metadata: {},
  };
}

async function fetchJsonWithRetry(
  url: string,
  fetchFn: typeof fetch,
  maxRetries = 2
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: {
          Accept: "application/json",
        },
      });

      if (res.ok) {
        return await res.json();
      }

      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status !== 429 && res.status < 500) {
        break;
      }

      if (attempt < maxRetries) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 3000)
            : 500 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1))
        );
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

export async function fetchProblemFromSolvedAc(
  problemId: string,
  options: {
    fetchFn?: typeof fetch;
    getTagCache?: () => Promise<SolvedTagCache | null>;
    setTagCache?: (cache: SolvedTagCache) => Promise<void>;
    v4BaseUrl?: string;
    v3BaseUrl?: string;
    nowMs?: number;
  } = {}
): Promise<SolvedProblem> {
  const fetchFn = options.fetchFn ?? fetch;
  const v4BaseUrl = options.v4BaseUrl ?? SOLVED_V4_PROXY_URL;
  const v3BaseUrl = options.v3BaseUrl ?? SOLVED_V3_API_URL;
  const nowMs = options.nowMs ?? Date.now();
  const encodedId = encodeURIComponent(problemId.trim());

  // 1. Primary: solved.ac API v4 (cached proxy)
  try {
    const cached = options.getTagCache ? await options.getTagCache() : null;
    const isCacheFresh =
      Boolean(cached) && nowMs - cached!.fetchedAt < SOLVED_TAG_CACHE_TTL_MS;

    const [v4Problem, tagPayload] = await Promise.all([
      fetchJsonWithRetry(`${v4BaseUrl}/problems/${encodedId}`, fetchFn) as Promise<SolvedV4Problem>,
      isCacheFresh
        ? Promise.resolve(null)
        : fetchJsonWithRetry(`${v4BaseUrl}/tags`, fetchFn, 1).catch(() => null),
    ]);

    let tagNames: Record<string, string> = cached?.names ?? {};
    if (Array.isArray(tagPayload?.tags)) {
      const freshNames: Record<string, string> = {};
      for (const tag of tagPayload.tags as SolvedV4TagItem[]) {
        const koName = tag.names?.ko ?? tag.names?.en;
        if (tag.key && koName) {
          freshNames[tag.key] = koName;
        }
      }
      tagNames = freshNames;
      if (options.setTagCache) {
        await options
          .setTagCache({ fetchedAt: nowMs, names: freshNames })
          .catch(() => {});
      }
    }

    if (v4Problem && typeof v4Problem.problemId === "number") {
      return normalizeV4Problem(v4Problem, tagNames);
    }
  } catch {
    // Fall through to v3 fallback
  }

  // 2. Fallback: legacy solved.ac API v3 (in case v4 proxy is temporarily unavailable)
  const v3Problem = await fetchJsonWithRetry(
    `${v3BaseUrl}/problem/show?problemId=${encodedId}`,
    fetchFn,
    1
  );

  if (!v3Problem || typeof v3Problem.problemId !== "number") {
    throw new Error("Invalid solved.ac response");
  }

  return normalizeV3Problem(v3Problem);
}

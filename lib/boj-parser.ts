import {
  BOJ_RESULT_COLORS,
  HEADER_CODE_LENGTH,
  HEADER_JUDGE_SERVER,
  HEADER_LANGUAGE,
  HEADER_LEVEL,
  HEADER_MEMORY,
  HEADER_PROBLEM_DESCRIPTION,
  HEADER_PROBLEM_ID,
  HEADER_RESULT,
  HEADER_RUNTIME,
  HEADER_SUBMISSION_ID,
  HEADER_SUBMISSION_TIME,
  HEADER_USERNAME,
  PENDING_RESULT_CATEGORIES,
} from "./constants.ts";

export interface ResultTableRow {
  codeLength: string;
  elementId: string;
  judgeServer?: string;
  language: string;
  memory: string;
  problemId: string;
  problemTitle: string;
  result: string;
  resultCategory: string;
  runtime: string;
  submissionId: string;
  submissionTime: string;
  submissionTimestamp: number | null;
  username: string;
}

export interface BojProblemStats {
  title: string | null;
  acceptedUserCount: number | null;
  averageTries: number | null;
}

export interface BojAjaxStatusResponse {
  solution_id?: string | number;
  result?: string | number;
  result_color?: string;
  result_name?: string;
  memory?: string | number;
  time?: string | number;
  progress?: string | number;
  partial_score?: string | number;
  subtask_score?: string | number;
  custom_result?: string;
  feedback?: string;
  rte_reason?: string;
  remain?: string | number;
  ac?: number;
  tot?: number;
  error?: unknown;
}

const PENDING_CATEGORY_SET = new Set<string>(PENDING_RESULT_CATEGORIES);

/**
 * 현재 URL이 로그인한 유저의 특정 문제 제출 현황(from_mine=1) 페이지인지 확인합니다.
 */
export function isMyProblemStatusPage(url: string, handle: string): boolean {
  if (!handle) return false;

  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    if (normalizedPath !== "/status") return false;

    const params = parsed.searchParams;
    const fromMine = params.get("from_mine");
    const problemId = params.get("problem_id");
    const userId = params.get("user_id");

    return (
      fromMine === "1" &&
      Boolean(problemId && problemId.trim().length > 0) &&
      Boolean(userId && userId.toLowerCase() === handle.toLowerCase())
    );
  } catch {
    return ["status", `user_id=${handle}`, "problem_id", "from_mine=1"].every(
      (key) => url.includes(key)
    );
  }
}

export function isPendingResultCategory(category: string): boolean {
  return PENDING_CATEGORY_SET.has(category.replace("-eng", "").trim());
}

export function resolveAjaxResultColor(
  data: BojAjaxStatusResponse
): string | null {
  if (typeof data.result_color === "string" && data.result_color.trim()) {
    return data.result_color.replace("-eng", "").trim();
  }

  const code = Number(data.result);
  if (Number.isInteger(code) && code >= 0 && code < BOJ_RESULT_COLORS.length) {
    return BOJ_RESULT_COLORS[code];
  }

  return null;
}

export function mapTableHeader(header: string): string {
  switch (header.trim().toLowerCase()) {
    case "문제번호":
    case "문제":
    case "problem":
      return HEADER_PROBLEM_ID;
    case "난이도":
      return HEADER_LEVEL;
    case "결과":
    case "result":
      return HEADER_RESULT;
    case "문제내용":
      return HEADER_PROBLEM_DESCRIPTION;
    case "언어":
    case "language":
      return HEADER_LANGUAGE;
    case "제출 번호":
    case "solution":
      return HEADER_SUBMISSION_ID;
    case "아이디":
    case "user":
      return HEADER_USERNAME;
    case "제출시간":
    case "제출한 시간":
    case "submission time":
      return HEADER_SUBMISSION_TIME;
    case "시간":
    case "time":
      return HEADER_RUNTIME;
    case "메모리":
    case "memory":
      return HEADER_MEMORY;
    case "코드 길이":
    case "length":
      return HEADER_CODE_LENGTH;
    case "채점 서버":
    case "judge server":
      return HEADER_JUDGE_SERVER;
    default:
      return "unknown";
  }
}

export function unescapeHtml(text: string): string {
  const unescaped: Record<string, string> = {
    "&amp;": "&",
    "&#38;": "&",
    "&lt;": "<",
    "&#60;": "<",
    "&gt;": ">",
    "&#62;": ">",
    "&apos;": "'",
    "&#39;": "'",
    "&quot;": '"',
    "&#34;": '"',
    "&nbsp;": " ",
    "&#160;": " ",
  };

  return text.replace(
    /&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34|nbsp|#160);/g,
    (m) => unescaped[m]!
  );
}

export function parseSubmissionTimestamp(
  rawTimestamp: string | null | undefined
): number | null {
  if (!rawTimestamp) return null;
  const parsed = Number(rawTimestamp.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function formatSubmissionTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  return `${year}년 ${month}월 ${day}일 ${hh}:${mm}:${ss}`;
}

/**
 * 제출 시각으로부터 경과한 시간(초)을 반환합니다.
 * data-timestamp(Unix epoch 초)가 있으면 우선 사용하고,
 * 없으면 한국어/영어/ISO 형식 문자열을 안전하게 파싱합니다.
 */
export function getTimeDifference(
  timestamp: string | null | undefined,
  unixTimestamp?: number | null,
  nowMs: number = Date.now()
): number {
  if (
    typeof unixTimestamp === "number" &&
    Number.isFinite(unixTimestamp) &&
    unixTimestamp > 0
  ) {
    return Math.floor(nowMs / 1000 - unixTimestamp);
  }

  if (!timestamp) return Number.POSITIVE_INFINITY;

  const trimmed = timestamp.trim();

  // ISO-like format from raw BOJ title attribute: "2026-11-22 20:19:35"
  const isoMatch = trimmed.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/
  );
  if (isoMatch) {
    const [, y, m, d, hh, mm, ss] = isoMatch;
    const date = new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss)
    );
    return Math.floor((nowMs - date.getTime()) / 1000);
  }

  // Korean moment LL HH:mm:ss format: "2026년 11월 22일 20:19:35"
  const koMatch = trimmed.match(
    /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+(\d{1,2}):(\d{2}):(\d{2})$/
  );
  if (koMatch) {
    const [, y, m, d, hh, mm, ss] = koMatch;
    const date = new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss)
    );
    return Math.floor((nowMs - date.getTime()) / 1000);
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((nowMs - parsedMs) / 1000);
}

/**
 * BOJ 문제 페이지 HTML에서 문제 제목, 맞힌 사람 수, 평균 시도(100 / 정답 비율)를 추출합니다.
 */
export function parseBojProblemHtml(html: string): BojProblemStats {
  const titleMatch = html.match(
    /<span[^>]*id=["']problem_title["'][^>]*>([\s\S]*?)<\/span>/i
  );
  const title = titleMatch
    ? unescapeHtml(titleMatch[1].replace(/<[^>]+>/g, "")).trim() || null
    : null;

  let acceptedUserCount: number | null = null;
  let averageTries: number | null = null;

  const tableMatch = html.match(
    /<table[^>]*id=["']problem-info["'][^>]*>([\s\S]*?)<\/table>/i
  );
  if (tableMatch) {
    const tableHtml = tableMatch[1];
    const headerMatches = Array.from(
      tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi),
      (m) => unescapeHtml(m[1].replace(/<[^>]+>/g, "")).trim().toLowerCase()
    );
    const cellMatches = Array.from(
      tableHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
      (m) => unescapeHtml(m[1].replace(/<[^>]+>/g, "")).trim()
    );

    for (let i = 0; i < Math.min(headerMatches.length, cellMatches.length); i++) {
      const header = headerMatches[i];
      const cell = cellMatches[i];

      if (header === "맞힌 사람" || header === "맞은 사람" || header === "solved") {
        const count = Number(cell.replace(/[^0-9]/g, ""));
        if (Number.isFinite(count) && cell.replace(/[^0-9]/g, "").length > 0) {
          acceptedUserCount = count;
        }
      } else if (
        header === "정답 비율" ||
        header === "정답률" ||
        header === "ratio"
      ) {
        const ratio = Number.parseFloat(cell.replace("%", "").trim());
        if (Number.isFinite(ratio) && ratio > 0) {
          averageTries = 100 / ratio;
        }
      }
    }
  }

  return {
    title,
    acceptedUserCount,
    averageTries,
  };
}

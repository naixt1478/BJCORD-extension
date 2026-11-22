import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatSubmissionTimestamp,
  getTimeDifference,
  isMyProblemStatusPage,
  isPendingResultCategory,
  mapTableHeader,
  parseBojProblemHtml,
  parseSubmissionTimestamp,
  resolveAjaxResultColor,
} from "../lib/boj-parser.ts";
import {
  buildFallbackProblem,
  fetchProblemFromSolvedAc,
  normalizeV4Problem,
  type SolvedTagCache,
} from "../lib/solved.ts";
import {
  HEADER_CODE_LENGTH,
  HEADER_JUDGE_SERVER,
  HEADER_LANGUAGE,
  HEADER_MEMORY,
  HEADER_PROBLEM_ID,
  HEADER_RESULT,
  HEADER_RUNTIME,
  HEADER_SUBMISSION_ID,
  HEADER_SUBMISSION_TIME,
  HEADER_USERNAME,
} from "../lib/constants.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

describe("BOJ domain & URL compatibility", () => {
  it("matches reopened apex domain acmicpc.net and legacy www.acmicpc.net", () => {
    assert.equal(
      isMyProblemStatusPage(
        "https://acmicpc.net/status?from_mine=1&problem_id=1000&user_id=naixt1478",
        "naixt1478"
      ),
      true
    );
    assert.equal(
      isMyProblemStatusPage(
        "https://www.acmicpc.net/status?problem_id=1000&user_id=Naixt1478&from_mine=1",
        "naixt1478"
      ),
      true
    );
    assert.equal(
      isMyProblemStatusPage(
        "https://acmicpc.net/status?problem_id=1000&user_id=naixt1478",
        "naixt1478"
      ),
      false
    );
    assert.equal(
      isMyProblemStatusPage(
        "https://acmicpc.net/status?from_mine=1&problem_id=1000&user_id=other",
        "naixt1478"
      ),
      false
    );
    assert.equal(
      isMyProblemStatusPage("https://acmicpc.net/problem/1000", "naixt1478"),
      false
    );
  });

  it("maps all 2026 BOJ status table headers (Korean & English, including Judge Server)", () => {
    const koHeaders = [
      ["제출 번호", HEADER_SUBMISSION_ID],
      ["아이디", HEADER_USERNAME],
      ["문제", HEADER_PROBLEM_ID],
      ["결과", HEADER_RESULT],
      ["메모리", HEADER_MEMORY],
      ["시간", HEADER_RUNTIME],
      ["채점 서버", HEADER_JUDGE_SERVER],
      ["언어", HEADER_LANGUAGE],
      ["코드 길이", HEADER_CODE_LENGTH],
      ["제출한 시간", HEADER_SUBMISSION_TIME],
    ];
    for (const [label, expected] of koHeaders) {
      assert.equal(mapTableHeader(label), expected, `Korean header: ${label}`);
    }

    const enHeaders = [
      ["Solution", HEADER_SUBMISSION_ID],
      ["User", HEADER_USERNAME],
      ["Problem", HEADER_PROBLEM_ID],
      ["Result", HEADER_RESULT],
      ["Memory", HEADER_MEMORY],
      ["Time", HEADER_RUNTIME],
      ["Judge Server", HEADER_JUDGE_SERVER],
      ["Language", HEADER_LANGUAGE],
      ["Length", HEADER_CODE_LENGTH],
      ["Submission Time", HEADER_SUBMISSION_TIME],
    ];
    for (const [label, expected] of enHeaders) {
      assert.equal(mapTableHeader(label), expected, `English header: ${label}`);
    }
  });
});

describe("Submission timestamp & November/December date-parse regression", () => {
  it("uses data-timestamp directly when available", () => {
    const ts = parseSubmissionTimestamp("1795346375");
    assert.equal(ts, 1795346375);
    assert.equal(getTimeDifference(null, ts, 1795346380 * 1000), 5);
    assert.ok(formatSubmissionTimestamp(1795346375).includes("2026"));
  });

  it("parses Korean November (11월) and December (12월) timestamps accurately", () => {
    const novDate = new Date(2026, 10, 22, 20, 19, 35); // Nov 22, 2026 20:19:35 local
    const diffNov = getTimeDifference(
      "2026년 11월 22일 20:19:35",
      null,
      novDate.getTime() + 4000
    );
    assert.equal(diffNov, 4);

    const decDate = new Date(2026, 11, 31, 23, 59, 55); // Dec 31, 2026 23:59:55 local
    const diffDec = getTimeDifference(
      "2026년 12월 31일 23:59:55",
      null,
      decDate.getTime() + 3000
    );
    assert.equal(diffDec, 3);
  });

  it("parses raw BOJ title attribute ISO-like timestamp before tooltip init", () => {
    const dt = new Date(2026, 10, 22, 20, 19, 35);
    const diff = getTimeDifference(
      "2026-11-22 20:19:35",
      null,
      dt.getTime() + 7000
    );
    assert.equal(diff, 7);
  });
});

describe("BOJ pending states & /status/ajax status resolution", () => {
  it("identifies all BOJ pending states including rejudge-wait", () => {
    for (const c of ["wait", "rejudge-wait", "compile", "judging", "judging-eng"]) {
      assert.equal(isPendingResultCategory(c), true, c);
    }
    for (const c of ["ac", "wa", "tle", "mle", "ole", "rte", "ce", "pac"]) {
      assert.equal(isPendingResultCategory(c), false, c);
    }
  });

  it("resolves color from live /status/ajax payload", () => {
    assert.equal(
      resolveAjaxResultColor({
        solution_id: "105239777",
        time: "581",
        memory: "13728",
        result: "4",
        result_color: "ac",
        result_name: "맞았습니다!!",
      }),
      "ac"
    );
    assert.equal(resolveAjaxResultColor({ result: 1 }), "rejudge-wait");
    assert.equal(resolveAjaxResultColor({ result: "14" }), "compile");
  });
});

describe("BOJ problem page stats parser (KO & EN live HTML)", () => {
  it("parses Korean #problem_title and #problem-info", () => {
    const html = `
      <span id="problem_title">A+B</span>
      <table class="table" id="problem-info">
        <thead><tr><th>시간 제한</th><th>메모리 제한</th><th>제출</th><th>정답</th><th>맞힌 사람</th><th>정답 비율</th></tr></thead>
        <tbody><tr><td>2 초 </td><td>128 MB</td><td>1413713</td><td>551905</td><td>371059</td><td>38.374%</td></tr></tbody>
      </table>
    `;
    const stats = parseBojProblemHtml(html);
    assert.equal(stats.title, "A+B");
    assert.equal(stats.acceptedUserCount, 371059);
    assert.ok(stats.averageTries !== null);
    assert.equal(Math.round(stats.averageTries! * 1000) / 1000, 2.606);
  });

  it("parses English #problem-info", () => {
    const html = `
      <span id="problem_title">A+B</span>
      <table class="table" id="problem-info">
        <thead><tr><th>Time Limit</th><th>Memory Limit</th><th>Submissions</th><th>Accepted</th><th>Solved</th><th>Ratio</th></tr></thead>
        <tbody><tr><td>2 seconds </td><td>128 MB</td><td>1413713</td><td>551905</td><td>371059</td><td>38.374%</td></tr></tbody>
      </table>
    `;
    const stats = parseBojProblemHtml(html);
    assert.equal(stats.acceptedUserCount, 371059);
    assert.equal(Math.round(stats.averageTries! * 1000) / 1000, 2.606);
  });
});

describe("solved.ac API v4 normalization & fallback", () => {
  it("normalizes live solved.ac v4 problem 1000 with tag names", () => {
    const normalized = normalizeV4Problem(
      {
        problemId: 1000,
        level: 1,
        solvedUserCount: 174309,
        givesNoRating: false,
        titles: [
          { language: "en", title: "A+B", isOriginal: true },
          { language: "ko", title: "A+B", isOriginal: true },
        ],
        tags: [
          { id: 14, key: "arithmetic", isMeta: false },
          { id: 7, key: "impl", isMeta: false },
          { id: 1, key: "math", isMeta: false },
        ],
      },
      { arithmetic: "사칙연산", impl: "구현", math: "수학" }
    );

    assert.equal(normalized.problemId, 1000);
    assert.equal(normalized.titleKo, "A+B");
    assert.equal(normalized.level, 1);
    assert.equal(normalized.isLevelLocked, false);
    assert.equal(normalized.acceptedUserCount, 174309);
    assert.equal(normalized.averageTries, null);
    assert.deepEqual(
      normalized.tags.map((t) => t.displayNames[0].name),
      ["사칙연산", "구현", "수학"]
    );
  });

  it("identifies Not Ratable problems from v4 givesNoRating", () => {
    const normalized = normalizeV4Problem({
      problemId: 1237,
      level: 0,
      solvedUserCount: 3747,
      givesNoRating: true,
      titles: [{ language: "ko", title: "정ㅋ벅ㅋ", isOriginal: true }],
      tags: [],
    });

    assert.equal(normalized.level, 0);
    assert.equal(normalized.isLevelLocked, true);
    assert.equal(normalized.titleKo, "정ㅋ벅ㅋ");
  });

  it("caches /tags in storage and falls back to v3 if v4 proxy fails", async () => {
    const requestedUrls: string[] = [];
    let tagCache: SolvedTagCache | null = null;

    const mockFetch = (async (url: string) => {
      requestedUrls.push(url);
      if (url.endsWith("/problems/1000")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            problemId: 1000,
            level: 1,
            solvedUserCount: 174309,
            givesNoRating: false,
            titles: [{ language: "ko", title: "A+B", isOriginal: true }],
            tags: [{ id: 1, key: "math", isMeta: false }],
          }),
        };
      }
      if (url.endsWith("/tags")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            tags: [{ key: "math", names: { ko: "수학", en: "math" } }],
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
    }) as unknown as typeof fetch;

    const first = await fetchProblemFromSolvedAc("1000", {
      fetchFn: mockFetch,
      getTagCache: async () => tagCache,
      setTagCache: async (c) => {
        tagCache = c;
      },
      nowMs: 1_000_000,
    });
    assert.equal(first.tags[0].displayNames[0].name, "수학");
    assert.ok(tagCache !== null);

    // Second call within TTL should NOT re-fetch /tags
    await fetchProblemFromSolvedAc("1000", {
      fetchFn: mockFetch,
      getTagCache: async () => tagCache,
      setTagCache: async (c) => {
        tagCache = c;
      },
      nowMs: 1_005_000,
    });
    assert.equal(
      requestedUrls.filter((u) => u.endsWith("/tags")).length,
      1
    );

    // If v4 fails, falls back to v3
    const fallbackFetch = (async (url: string) => {
      if (url.includes("/api/v4/")) {
        return { ok: false, status: 503, headers: new Headers(), json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          problemId: 1000,
          titleKo: "A+B",
          level: 1,
          acceptedUserCount: 371059,
          averageTries: 2.606,
          isLevelLocked: false,
          tags: [],
        }),
      };
    }) as unknown as typeof fetch;

    const v3Result = await fetchProblemFromSolvedAc("1000", {
      fetchFn: fallbackFetch,
    });
    assert.equal(v3Result.titleKo, "A+B");
    assert.equal(v3Result.averageTries, 2.606);
  });

  it("builds safe fallback problem when all solved.ac calls fail", () => {
    const fb = buildFallbackProblem(
      "2798",
      { title: "블랙잭", acceptedUserCount: 95000, averageTries: 2.1 },
      "블랙잭"
    );
    assert.equal(fb.titleKo, "블랙잭");
    assert.equal(fb.level, 0);
    assert.equal(fb.acceptedUserCount, 95000);
    assert.equal(fb.averageTries, 2.1);
  });
});

describe("Built Chrome MV3 manifest verification", () => {
  it("contains acmicpc.net, www.acmicpc.net, and solved.ac v4 host permissions", () => {
    const manifestPath = path.join(ROOT, ".output", "chrome-mv3", "manifest.json");
    assert.ok(fs.existsSync(manifestPath), "Run pnpm build before running tests");

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.host_permissions.includes("https://acmicpc.net/*"));
    assert.ok(manifest.host_permissions.includes("https://www.acmicpc.net/*"));
    assert.ok(
      manifest.host_permissions.includes("https://solvedac.ssafy.today/api/v4/*")
    );
    assert.ok(
      manifest.content_scripts[0].matches.includes("https://acmicpc.net/*")
    );
    assert.ok(
      manifest.content_scripts[0].matches.includes("https://www.acmicpc.net/*")
    );
  });
});

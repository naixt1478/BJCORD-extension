import { ContentScriptContext } from "#imports";
import {
  type BojAjaxStatusResponse,
  type BojProblemStats,
  formatSubmissionTimestamp,
  getTimeDifference,
  isPendingResultCategory,
  mapTableHeader,
  parseBojProblemHtml,
  parseSubmissionTimestamp,
  resolveAjaxResultColor,
  type ResultTableRow,
  unescapeHtml,
} from "./boj-parser";
import { getSendFirstAcOnly, getShowEmoji, getWebhooks } from "./browser";
import {
  AC_TITLE_TOOLTIP_QUERY,
  BOJ_ORIGIN,
  DEFAULT_TIER_SELECTION_END,
  DEFAULT_TIER_SELECTION_START,
  HANDLE_META_QUERY,
  HANDLE_QUERY,
  HEADER_LANGUAGE,
  HEADER_PROBLEM_ID,
  HEADER_RESULT,
  HEADER_SUBMISSION_TIME,
  PROBLEM_ID_QUERY,
  RESULT_TABLE_ID,
  SUBMISSION_TIME_QUERY,
  TIER_NAME,
  WATCH_JUDGEMENT_INTERVAL,
} from "./constants";
import { Logger } from "./logger";
import {
  buildFallbackProblem,
  type SolvedFetchResponse,
  type SolvedProblem,
  type SolvedTag,
} from "./solved";

export { unescapeHtml };
export type { SolvedProblem, SolvedTag, ResultTableRow, BojProblemStats };

const AJAX_INITIAL_DELAY_MS = 6000;
const AJAX_MIN_DELAY_MS = 3000;
const AJAX_MAX_DELAY_MS = 15000;
const AJAX_BACKOFF_FACTOR = 1.5;
const AJAX_JITTER = 0.2;
const AJAX_ERROR_BASE_MS = 5000;
const AJAX_ERROR_MAX_MS = 60000;
const AJAX_MAX_WATCH_MS = 10 * 60 * 1000;

function withJitter(ms: number): number {
  return ms * (1 - AJAX_JITTER + Math.random() * 2 * AJAX_JITTER);
}

function getSentStorageKey(submissionId: string): string {
  return `bjcord:sent:${submissionId}`;
}

function hasSentSubmission(submissionId: string): boolean {
  try {
    return sessionStorage.getItem(getSentStorageKey(submissionId)) === "1";
  } catch {
    return false;
  }
}

function markSubmissionSent(submissionId: string): void {
  try {
    sessionStorage.setItem(getSentStorageKey(submissionId), "1");
  } catch {
    // Ignore storage quota/privacy restrictions
  }
}

/**
 * 유저의 핸들을 가져옵니다.
 * BOJ 최상단의 element(`a.username`) 또는 `<meta name="username">`에서 핸들을 추출합니다.
 * 로그인되지 않은 상태인 경우 null을 반환합니다.
 *
 * @returns 유저의 핸들. 없으면 null
 */
export function getHandle(): string | null {
  const element = document.querySelector(HANDLE_QUERY);
  const textHandle = element?.textContent?.trim();
  if (textHandle) {
    return textHandle;
  }

  const meta = document.querySelector(HANDLE_META_QUERY);
  const metaHandle = meta?.getAttribute("content")?.trim();
  if (metaHandle) {
    return metaHandle;
  }

  return null;
}

/**
 * 유저가 이미 맞은 문제인지 여부를 반환합니다.
 * status 페이지에서 AC된 문제의 제목에 `result-ac` 클래스가 붙습니다.
 * 이 클래스를 통해 이미 맞은 문제인지 확인합니다.
 * 이미 맞은 문제인 경우 설정에 따라서 웹훅을 보내지 않아야 할 수 있습니다.
 *
 * @returns 유저가 이미 맞은 문제인지 여부
 * @see getSendFirstAcOnly
 */
export function isUserAlreadyAccepted(): boolean {
  const acceptedProblemTitleTooltip = document.querySelector(
    AC_TITLE_TOOLTIP_QUERY
  );

  return !!acceptedProblemTitleTooltip;
}

export function getResultTable(): ResultTableRow[] | null {
  const table = document.getElementById(
    RESULT_TABLE_ID
  ) as HTMLTableElement | null;
  if (!table || table.rows.length === 0) return null;

  const headers = Array.from(table.rows[0].cells)
    .map((x) => (x.innerText || x.textContent || "").trim())
    .map(mapTableHeader);

  const list: ResultTableRow[] = [];
  for (let i = 1; i < table.rows.length; i++) {
    const row = table.rows[i];
    const cells = Array.from(row.cells, (x, idx) => {
      switch (headers[idx]) {
        case HEADER_RESULT: {
          const resultEl =
            x.querySelector("span.result-text") ?? x.firstElementChild;
          const color =
            resultEl
              ?.getAttribute("data-color")
              ?.replace("-eng", "")
              .trim() ?? "";
          return {
            result: (x.innerText || x.textContent || "").trim(),
            resultCategory: color,
          };
        }
        case HEADER_LANGUAGE:
          return unescapeHtml(x.innerText || x.textContent || "")
            .replace(/\/.*$/g, "")
            .trim();
        case HEADER_SUBMISSION_TIME: {
          const time = x.querySelector(SUBMISSION_TIME_QUERY);
          if (!time) {
            return {
              submissionTime: "",
              submissionTimestamp: null,
            };
          }
          const submissionTimestamp = parseSubmissionTimestamp(
            time.getAttribute("data-timestamp")
          );
          const displayTime =
            time.getAttribute("data-original-title")?.trim() ||
            time.getAttribute("title")?.trim() ||
            (submissionTimestamp !== null
              ? formatSubmissionTimestamp(submissionTimestamp)
              : "") ||
            (time.textContent || "").trim();

          return {
            submissionTime: displayTime,
            submissionTimestamp,
          };
        }
        case HEADER_PROBLEM_ID: {
          const idElement = x.querySelector(PROBLEM_ID_QUERY);
          if (!idElement) {
            return {
              problemId: "",
              problemTitle: "",
            };
          }
          const href = idElement.getAttribute("href") ?? "";
          const problemId =
            href.replace(/^.*\/([0-9]+)$/, "$1") ||
            (idElement.textContent || "").trim();
          const problemTitle =
            idElement.getAttribute("data-original-title")?.trim() ||
            idElement.getAttribute("title")?.trim() ||
            "";
          return {
            problemId,
            problemTitle,
          };
        }
        default:
          return (x.innerText || x.textContent || "").trim();
      }
    });

    let obj: Record<string, any> = { elementId: row.id };
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cells[j];
    }

    const resultObj =
      obj.result && typeof obj.result === "object" ? obj.result : {};
    const problemObj =
      obj.problemId && typeof obj.problemId === "object" ? obj.problemId : {};
    const timeObj =
      obj.submissionTime && typeof obj.submissionTime === "object"
        ? obj.submissionTime
        : {};

    obj = {
      ...obj,
      ...resultObj,
      ...problemObj,
      ...timeObj,
    };
    list.push(obj as ResultTableRow);
  }

  return list;
}

/**
 * BOJ의 실시간 채점(Pusher)이 지연되거나 이벤트를 놓쳤을 때
 * 단일 제출 상태를 /status/ajax로 조회합니다.
 */
async function fetchSubmissionStatusAjax(
  submissionId: string
): Promise<BojAjaxStatusResponse | null> {
  const res = await fetch("/status/ajax", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({ solution_id: submissionId }),
  });

  if (!res.ok) {
    throw new Error(`BOJ /status/ajax HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!contentType.includes("json") && !text.trim().startsWith("{")) {
    throw new Error("BOJ /status/ajax returned non-JSON response");
  }

  const data = JSON.parse(text) as BojAjaxStatusResponse;
  if (!data || data.error || data.result === undefined) {
    return null;
  }

  return data;
}

/**
 * /status/ajax 응답을 현재 테이블 행 DOM에 안전하게 반영합니다.
 * 이미 화면에 최종 결과가 표시된 경우에는 덮어쓰지 않습니다.
 */
export function applyAjaxStatusToRow(
  elementId: string,
  data: BojAjaxStatusResponse
): boolean {
  if (!elementId) return false;
  const row = document.getElementById(elementId);
  if (!row) return false;

  const resultSpan = row.querySelector("td.result span.result-text");
  if (!resultSpan) return false;

  const currentColor =
    resultSpan.getAttribute("data-color")?.replace("-eng", "").trim() ?? "";
  if (currentColor && !isPendingResultCategory(currentColor)) {
    return false;
  }

  const nextColor = resolveAjaxResultColor(data);
  if (!nextColor) return false;

  let displayText = "";
  if (data.partial_score !== undefined && data.partial_score !== null) {
    const score = Math.round(Number(data.partial_score) * 100) / 100;
    displayText = `${score}점`;
    if (data.custom_result) displayText += ` (${data.custom_result})`;
  } else if (data.subtask_score !== undefined && data.subtask_score !== null) {
    displayText = `${data.subtask_score}점`;
    if (data.custom_result) displayText += ` (${data.custom_result})`;
  } else if (data.custom_result) {
    displayText = data.custom_result;
  } else if (data.result_name) {
    displayText = data.result_name;
    if (Number(data.result) === 14) {
      displayText = displayText.replace("%(remain)", String(data.remain ?? 0));
    }
    if (
      data.progress !== undefined &&
      data.progress !== null &&
      String(data.progress).trim() !== "" &&
      !displayText.includes("%")
    ) {
      displayText += ` (${data.progress}%)`;
    }
    if (Number(data.result) === 6 && data.feedback) {
      displayText += ` [${data.feedback}]`;
    }
    if (Number(data.result) === 10 && data.rte_reason) {
      displayText += ` (${data.rte_reason})`;
    }
    if (data.ac && data.tot && data.ac > 0 && data.tot > 0) {
      displayText += ` (${data.ac}/${data.tot})`;
    }
  }

  if (displayText) {
    resultSpan.textContent = displayText;
  }

  const rawPrevColor = resultSpan.getAttribute("data-color");
  if (rawPrevColor && rawPrevColor !== nextColor) {
    resultSpan.classList.remove(`result-${rawPrevColor}`);
  }
  resultSpan.classList.add(`result-${nextColor}`);
  resultSpan.setAttribute("data-color", nextColor);

  const memoryCell = row.querySelector("td.memory");
  if (memoryCell && data.memory !== undefined && data.memory !== null) {
    memoryCell.textContent = String(data.memory);
    const kbSpan = document.createElement("span");
    kbSpan.className = "kb-text";
    memoryCell.appendChild(kbSpan);
  }

  const timeCell = row.querySelector("td.time");
  if (timeCell && data.time !== undefined && data.time !== null) {
    timeCell.textContent = String(data.time);
    const msSpan = document.createElement("span");
    msSpan.className = "ms-text";
    timeCell.appendChild(msSpan);
  }

  return true;
}

/**
 * 같은 출처의 BOJ 문제 페이지(/problem/{id})에서 제목, 맞힌 사람 수, 평균 시도 횟수를 조회합니다.
 * solved.ac API v4에 없는 averageTries를 보완하고, solved.ac 장애 시 fallback으로도 사용합니다.
 */
async function fetchBojProblemStats(
  problemId: string
): Promise<BojProblemStats | null> {
  try {
    const res = await fetch(`/problem/${encodeURIComponent(problemId)}`, {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseBojProblemHtml(html);
  } catch {
    return null;
  }
}

export async function getProblemData(
  problemId: string
): Promise<SolvedProblem | null> {
  try {
    const response = (await browser.runtime.sendMessage({
      sender: "boj",
      task: "solvedProblemFetch",
      problemId,
    })) as SolvedFetchResponse | SolvedProblem | undefined;

    if (!response) return null;

    if ("ok" in response) {
      return response.ok && response.data ? response.data : null;
    }

    return typeof response.problemId === "number" ? response : null;
  } catch {
    return null;
  }
}

export function getProblemTier(problemData: SolvedProblem): string {
  const { level, isLevelLocked } = problemData;

  if (level === 0 && isLevelLocked) {
    return "Not Ratable";
  }

  return TIER_NAME[level] ?? "Unrated";
}

export const getColor = (tier: string) => {
  switch (tier) {
    case "bronze":
      return 0xcd7f32;
    case "silver":
      return 0xc0c0c0;
    case "gold":
      return 0xffd700;
    case "platinum":
      return 0x61fa9e;
    case "diamond":
      return 0x4db8fa;
    case "ruby":
      return 0xff125d;
    default:
      return 0x000000;
  }
};

function getLevelImg(level: string): string {
  const tier = level.split(" ")[0];
  const CDN = `https://cdn.jsdelivr.net/gh/5tarlight/vlog-image@main/bjcord/solved-tier`;
  if (tier === "Unrated") {
    return `${CDN}/unrated.png`;
  }

  if (level === "Not Ratable") {
    return `${CDN}/not-ratable.png`;
  }

  const step = level.split(" ")[1];

  let stepNum = 0;
  switch (step) {
    case "I":
      stepNum = 1;
      break;
    case "II":
      stepNum = 2;
      break;
    case "III":
      stepNum = 3;
      break;
    case "IV":
      stepNum = 4;
      break;
    case "V":
      stepNum = 5;
      break;
    default:
      stepNum = 0;
  }

  return `${CDN}/${tier.toLowerCase()}${stepNum}.png`;
}

async function sendMessage(message: any, url: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error("Failed to send webhook: " + response.statusText);
  }
}

export async function getWebhookMessage(
  handle: string,
  submissionId: string,
  problemId: string,
  language: string,
  memory: string,
  result: string,
  runtime: string,
  length: string,
  resultText: string,
  timestamp: string,
  attempts: number,
  fallbackTitle?: string
) {
  const [solvedData, bojStats] = await Promise.all([
    getProblemData(problemId),
    fetchBojProblemStats(problemId),
  ]);

  const solved =
    solvedData ?? buildFallbackProblem(problemId, bojStats, fallbackTitle);

  const title =
    solved.titleKo || bojStats?.title || fallbackTitle || `${problemId}번 문제`;
  const averageTries = solved.averageTries ?? bojStats?.averageTries ?? null;
  const acceptedUserCount =
    bojStats?.acceptedUserCount ?? solved.acceptedUserCount ?? null;

  const getTagName = (tag: SolvedTag) => {
    const key = tag.key;
    const display = (tag.displayNames ?? []).filter((x) => x.language === "ko");

    if (display.length === 0) return key;

    return display[0].name || key;
  };

  const tier = getProblemTier(solved);

  return {
    level: solved.level,
    buildMessage: (displayName: string | undefined) => ({
      content: null,
      embeds: [
        {
          title: `[${tier}] ${problemId}번: ${title}`,
          url: `${BOJ_ORIGIN}/problem/${problemId}`,
          description: `[코드 보기](${BOJ_ORIGIN}/source/${submissionId})\n${
            solved.tags.length > 0
              ? `태그: ||${solved.tags.map(getTagName).join(", ")}||`
              : ""
          }`,
          color: getColor(tier.split(" ")[0].toLowerCase()),
          fields: [
            {
              name: "성능",
              value: `${memory || "?"} KB / ${runtime || "?"} ms`,
              inline: true,
            },
            {
              name: "언어",
              value: language || "?",
              inline: true,
            },
            {
              name: "시도한 횟수",
              value: `${attempts} 회`,
              inline: true,
            },
            {
              name: "제출 일자",
              value: `${timestamp || "?"}`,
              inline: true,
            },
            {
              name: "코드 길이",
              value: length ? `${length} B` : "?",
              inline: true,
            },
            {
              name: "평균 시도",
              value:
                typeof averageTries === "number" &&
                Number.isFinite(averageTries)
                  ? `${Math.round(averageTries * 1000) / 1000} 회`
                  : "?",
              inline: true,
            },
            {
              name: "맞은 사람",
              value:
                typeof acceptedUserCount === "number" &&
                Number.isFinite(acceptedUserCount)
                  ? `${acceptedUserCount} 명`
                  : "?",
              inline: true,
            },
          ],
          author: {
            name: `${displayName || handle}`,
            url: `https://solved.ac/profile/${handle}`,
          },
          thumbnail: {
            url: getLevelImg(tier),
          },
        },
      ],
      username: "BJCORD",
      avatar_url:
        "https://cdn.jsdelivr.net/gh/5tarlight/vlog-image@main/bjcord/thumbnail.png",
      attachments: [],
    }),
  };
}

/**
 * BJCORD의 메인 로직입니다.
 * 유저의 채점 결과 변화를 감시하고, 새로운 AC가 감지되면
 * 설정에 따라서 디스코드 웹훅을 보냅니다.
 *
 * BOJ 실시간 채점(Pusher) 이벤트가 누락되는 경우를 대비해,
 * 일정 시간 동안 상태 변화가 없으면 단일 제출에 대해서만
 * 백오프 방식으로 /status/ajax를 보조 조회합니다.
 *
 * @param ctx ContentScriptContext
 * @param logger Logger
 */
export async function watchJudgementChange(
  ctx: ContentScriptContext,
  logger: Logger
) {
  if (isUserAlreadyAccepted()) {
    if (await getSendFirstAcOnly()) {
      logger.log("Already accepted, aborted.");
      return;
    }
  }

  logger.log("Watching judgement change...");

  let isJudging = false;
  let judgeStartTime = 0;

  let lastObservedKey = "";
  let lastStateChangeAt = 0;
  let ajaxDelay = AJAX_INITIAL_DELAY_MS;
  let nextAjaxAllowedAt = 0;
  let ajaxInFlight = false;
  let ajaxErrorDelay = 0;
  let ajaxTimedOutLogged = false;

  /*
    많은 브라우저들은 확장이 "invalidated" 되었을 때
    (ex. 업데이트되거나 사용자가 확장을 비활성화하거나 제거하는 경우)
    모든 content script를 중지시키지 않습니다. Invalidated된 상태에서
    interval이 계속 동작하는 것을 막아주기 위해 ctx.setInterval을 사용합니다.
    참고 : https://wxt.dev/guide/essentials/content-scripts.html
  */
  const interval = ctx.setInterval(() => {
    const table = getResultTable();

    if (!table || table.length === 0) return;
    const latest = table[0];

    if (isPendingResultCategory(latest.resultCategory)) {
      const now = Date.now();
      if (!isJudging) {
        isJudging = true;
        judgeStartTime = now;
        lastStateChangeAt = now;
        nextAjaxAllowedAt = now + withJitter(AJAX_INITIAL_DELAY_MS);
        logger.log("Waiting for judgement...");
      }

      const stateKey = `${latest.submissionId}:${latest.resultCategory}:${latest.result}`;
      if (stateKey !== lastObservedKey) {
        lastObservedKey = stateKey;
        lastStateChangeAt = now;
        ajaxDelay = AJAX_INITIAL_DELAY_MS;
        nextAjaxAllowedAt = now + withJitter(ajaxDelay);
      }

      if (now - judgeStartTime > AJAX_MAX_WATCH_MS) {
        if (!ajaxTimedOutLogged) {
          ajaxTimedOutLogged = true;
          logger.log("Ajax fallback timed out after 10 minutes.");
        }
        return;
      }

      if (
        !document.hidden &&
        !ajaxInFlight &&
        latest.submissionId &&
        now - lastStateChangeAt >= ajaxDelay &&
        now >= nextAjaxAllowedAt
      ) {
        ajaxInFlight = true;
        const targetSubmissionId = latest.submissionId;
        const targetElementId = latest.elementId;
        const prevStateKey = stateKey;

        (async () => {
          try {
            const ajaxData = await fetchSubmissionStatusAjax(targetSubmissionId);
            ajaxErrorDelay = 0;

            if (ajaxData) {
              applyAjaxStatusToRow(targetElementId, ajaxData);
              const updatedColor = resolveAjaxResultColor(ajaxData) ?? "";
              const updatedKey = `${targetSubmissionId}:${updatedColor}:${ajaxData.result_name ?? ""}`;
              if (updatedKey !== prevStateKey) {
                ajaxDelay = AJAX_MIN_DELAY_MS;
              } else {
                ajaxDelay = Math.min(
                  ajaxDelay * AJAX_BACKOFF_FACTOR,
                  AJAX_MAX_DELAY_MS
                );
              }
            } else {
              ajaxDelay = Math.min(
                ajaxDelay * AJAX_BACKOFF_FACTOR,
                AJAX_MAX_DELAY_MS
              );
            }

            nextAjaxAllowedAt = Date.now() + withJitter(ajaxDelay);
          } catch (err) {
            logger.error("Failed to poll /status/ajax:", err);
            ajaxErrorDelay =
              ajaxErrorDelay === 0
                ? AJAX_ERROR_BASE_MS
                : Math.min(ajaxErrorDelay * 2, AJAX_ERROR_MAX_MS);
            nextAjaxAllowedAt = Date.now() + withJitter(ajaxErrorDelay);
          } finally {
            ajaxInFlight = false;
          }
        })();
      }

      return;
    }

    if (latest.resultCategory !== "ac") {
      logger.log("Latest submission is not AC, aborted.");
      clearInterval(interval);
      return;
    }

    if (latest.submissionId && hasSentSubmission(latest.submissionId)) {
      logger.log("Submission already sent, aborted.");
      clearInterval(interval);
      return;
    }

    // 마지막 제출로부터 지난 시간
    const time = getTimeDifference(
      latest.submissionTime,
      latest.submissionTimestamp
    );
    if (time > 10) {
      // 10초 이상 지났으면 무시 (직접 채점을 지켜본 경우는 전송)
      if (!isJudging) {
        logger.log(`Submission is ${time}s old and not watched, aborted.`);
        clearInterval(interval);
        return;
      }

      const duration = (Date.now() - judgeStartTime) / 1000;
      logger.log(`AC! Took ${duration} seconds.`);
    }

    clearInterval(interval);
    if (latest.submissionId) {
      markSubmissionSent(latest.submissionId);
    }

    // 시도 횟수 계산
    let attempts = 1;
    for (let i = 1; i < table.length; i++) {
      if (table[i].resultCategory !== "ac") attempts++;
      else break;
    }

    logger.log(`Attempts: ${attempts}`);
    logger.log(`Sending webhook...`);

    const processStartTime = judgeStartTime || Date.now();

    (async () => {
      let success = 0;
      let failure = 0;

      try {
        const webhookData = await getWebhookMessage(
          latest.username,
          latest.submissionId,
          latest.problemId,
          latest.language,
          latest.memory,
          latest.result,
          latest.runtime,
          latest.codeLength,
          latest.resultCategory,
          latest.submissionTime,
          attempts,
          latest.problemTitle
        );

        const webhooks = (await getWebhooks()).filter((wh) => {
          if (!wh.active) return false;
          const level = webhookData.level;
          const includeUnrated = wh.includeUnrated ?? wh.tierMin === 0;
          const min = wh.tierMin ?? DEFAULT_TIER_SELECTION_START;
          const max = wh.tierMax ?? DEFAULT_TIER_SELECTION_END;

          if (level === 0) return includeUnrated;
          return level >= min && level <= max;
        });

        for (const webhook of webhooks) {
          try {
            await sendMessage(
              webhookData.buildMessage(webhook.displayName),
              webhook.url
            );
            success++;
          } catch (e) {
            logger.error(e);
            failure++;
          }
        }

        logger.log(`Webhook sent! (Success: ${success}, Failed: ${failure})`);
      } catch (e) {
        logger.error("Failed while building/sending webhook:", e);
        failure++;
      }

      // Show Emoji
      const shouldShowEmoji = await getShowEmoji();
      if (shouldShowEmoji) {
        const statusCell =
          (latest.elementId
            ? document.querySelector(
                `#${CSS.escape(latest.elementId)} span.result-text.result-ac`
              )
            : null) ?? document.querySelector("span.result-text.result-ac");

        if (statusCell) {
          if (success > 0 && failure === 0) {
            const badge = document.createElement("span");
            badge.title =
              "[BJCORD] 결과를 디스코드에 성공적으로 전달했습니다.";
            badge.textContent = " ✔️";
            statusCell.appendChild(badge);
          } else if (failure !== 0) {
            const badge = document.createElement("span");
            badge.title =
              "[BJCORD] 결과를 디스코드에 전달하는데 실패했습니다. 자세한 내용은 로그를 참고해주세요.";
            badge.textContent = " ❌";
            statusCell.appendChild(badge);
          }
        } else {
          logger.error("Status cell not found. Cannot append status.");
        }
      }

      const elapsed = Date.now() - processStartTime;
      logger.log(`Elapsed time: ${elapsed} ms`);
    })();
  }, WATCH_JUDGEMENT_INTERVAL);
}

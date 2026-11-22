import { SOLVED_TAG_CACHE_KEY } from "@/lib/constants";
import {
  fetchProblemFromSolvedAc,
  type SolvedFetchResponse,
  type SolvedTagCache,
} from "@/lib/solved";

export default defineBackground(() => {
  async function getTagCache(): Promise<SolvedTagCache | null> {
    try {
      const storage = await browser.storage.local.get(SOLVED_TAG_CACHE_KEY);
      const cached = storage[SOLVED_TAG_CACHE_KEY] as SolvedTagCache | undefined;
      if (
        cached &&
        typeof cached.fetchedAt === "number" &&
        cached.names &&
        typeof cached.names === "object"
      ) {
        return cached;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function setTagCache(cache: SolvedTagCache): Promise<void> {
    await browser.storage.local.set({ [SOLVED_TAG_CACHE_KEY]: cache });
  }

  function handleMessage(
    request: any,
    _: Browser.runtime.MessageSender,
    sendResponse: (response?: SolvedFetchResponse) => void
  ) {
    if (request?.task === "solvedProblemFetch") {
      (async () => {
        try {
          const data = await fetchProblemFromSolvedAc(String(request.problemId), {
            getTagCache,
            setTagCache,
          });
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    return false;
  }

  browser.runtime.onMessage.addListener(handleMessage);
});

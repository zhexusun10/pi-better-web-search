import { TextDecoder } from "node:util";
import { markAttemptOutput } from "../attempt-timeout.ts";
import { createRequestErrorRedactor } from "./http.ts";

/** Bound a single untrusted frame, not the total streamed response. */
export const MAX_SSE_FRAME_CHARS = 4 * 1024 * 1024;

export type SseEvent = {
  event: string;
  data: any;
};

/**
 * Read JSON server-sent events. Malformed/keepalive frames are skipped;
 * `[DONE]` and a true callback result both stop and cancel the stream.
 */
export async function readSseEvents(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (event: SseEvent) => boolean | void | Promise<boolean | void>,
  requestHeaders?: RequestInit["headers"],
): Promise<void> {
  const redactError = createRequestErrorRedactor(requestHeaders);
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineParts: string[] = [];
  let lineChars = 0;
  let frameChars = 0;
  const checkFrameSize = (size: number): void => {
    if (size > MAX_SSE_FRAME_CHARS) throw new Error(`SSE frame exceeds the ${MAX_SSE_FRAME_CHARS}-character limit`);
  };
  let currentEventData: string[] = [];
  let currentEventName = "";
  let skipLf = false;
  let stopRequested = false;
  let reachedEof = false;

  const checkAbort = (): void => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Request was aborted", "AbortError");
    }
  };
  // Cancelling the reader also releases a pending read when a custom response
  // does not wire the request's signal to its stream. Do not await an arbitrary
  // underlying source's cancellation promise.
  const cancelReader = (): void => { void reader.cancel(signal?.reason).catch(() => {}); };

  const flushEvent = async (): Promise<boolean> => {
    const raw = currentEventData.join("\n").trim();
    const event = currentEventName;
    currentEventData = [];
    currentEventName = "";
    frameChars = 0;
    if (raw === "[DONE]") return true;
    if (!raw) return false;

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
    markAttemptOutput(signal);
    return (await onEvent({ event, data })) === true;
  };

  const consumeLine = async (line: string): Promise<boolean> => {
    if (!line) return flushEvent();
    frameChars += line.length + 1;
    checkFrameSize(frameChars);
    if (line.startsWith(":")) return false;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") currentEventData.push(value);
    else if (field === "event") currentEventName = value;
    return false;
  };

  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!stopRequested) {
      checkAbort();
      const { done, value } = await reader.read();
      checkAbort();
      reachedEof = done;
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });

      let start = 0;
      // Scan only new text and join fragments once a line is complete. Repeated
      // concatenation/rescanning makes small-chunk, long-line streams quadratic.
      for (let index = 0; index < chunk.length; index += 1) {
        const char = chunk[index];
        if (skipLf) {
          skipLf = false;
          if (char === "\n") {
            start = index + 1;
            continue;
          }
        }
        if (char !== "\r" && char !== "\n") continue;
        const fragment = chunk.slice(start, index);
        if (lineChars || fragment) checkFrameSize(frameChars + lineChars + fragment.length + 1);
        const line = lineParts.length ? lineParts.join("") + fragment : fragment;
        lineParts = [];
        lineChars = 0;
        start = index + 1;
        skipLf = char === "\r";
        checkAbort();
        if (await consumeLine(line)) {
          stopRequested = true;
          break;
        }
      }
      if (!stopRequested) {
        const tail = chunk.slice(start);
        lineChars += tail.length;
        checkFrameSize(frameChars + lineChars);
        if (tail) lineParts.push(tail);
      }
      if (done) break;
    }

    if (!stopRequested) {
      checkAbort();
      if (lineChars) stopRequested = await consumeLine(lineParts.join(""));
      if (!stopRequested) await flushEvent();
    }
    checkAbort();
  } catch (error) {
    throw redactError(error, signal);
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (!reachedEof) cancelReader();
    reader.releaseLock();
  }
}

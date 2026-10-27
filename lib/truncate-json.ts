type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ChangeTracker {
  paths: string[];
  seen: Set<string>;
  more: boolean;
}

interface TruncationInfo {
  truncated: true;
  originalChars: number;
  affectedPaths: string[];
  moreAffectedPaths: boolean;
}

interface Slot {
  index: number;
  key?: string;
  value: JsonValue;
  minimum: number;
  full: number;
  allocation: number;
}

const MAX_RECORDED_PATHS = 64;
const MAX_PATH_LENGTH = 160;
const MAX_PATH_BUDGET = 2_048;
const STRING_MARKER = "…[truncated]";
const IDENTITY_KEYS = ["url", "uri", "title", "name", "id", "error", "status", "query", "answer", "content", "text"];
const IMPORTANT_KEYS = [...IDENTITY_KEYS, "search", "fetched", "results", "data"];
const KEY_PRIORITY = new Map(IMPORTANT_KEYS.map((key, index) => [key, index]));

/** Count Unicode code points, rather than UTF-16 code units. */
function charCount(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

function recordChange(tracker: ChangeTracker, path: string): void {
  if (tracker.seen.has(path)) return;
  if (tracker.paths.length >= MAX_RECORDED_PATHS) {
    tracker.more = true;
    return;
  }
  tracker.seen.add(path);
  tracker.paths.push(path);
}

function propertyPath(parent: string, key: string): string {
  // A very long or unusual provider field name is represented by its parent,
  // rather than allowing an unbounded field name to consume the path budget.
  if (parent.length + key.length > MAX_PATH_LENGTH) return parent;
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}

function indexPath(parent: string, index: number): string {
  const path = `${parent}[${index}]`;
  return path.length <= MAX_PATH_LENGTH ? path : parent;
}

/** Encoded length of one code point inside a JSON string (without quotes). */
function encodedCharacterLength(character: string): number {
  if (character.length === 2) return 1; // a surrogate pair is one code point
  const code = character.charCodeAt(0);
  if (character === '"' || character === "\\") return 2;
  if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) return 2;
  if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) return 6;
  return 1;
}

function fitString(value: string, budget: number): string {
  // A JSON string needs two quotes. Include a marker whenever it fits; paths in
  // _truncation also identify shortened strings when the budget is very small.
  const marker = budget >= charCount(STRING_MARKER) + 2 ? STRING_MARKER : budget >= 3 ? "…" : "";
  let remaining = budget - 2 - charCount(marker);
  const prefix: string[] = [];
  for (const character of value) {
    const size = encodedCharacterLength(character);
    if (size > remaining) break;
    prefix.push(character);
    remaining -= size;
  }
  return prefix.join("") + marker;
}

/** Distribute the available space fairly, giving unused space to larger values. */
function allocate(slots: Slot[], available: number): void {
  let remaining = available;
  for (const slot of slots) {
    slot.allocation = slot.minimum;
    remaining -= slot.minimum;
  }

  const pending = slots
    .filter((slot) => slot.full > slot.minimum)
    .sort((a, b) => (a.full - a.minimum) - (b.full - b.minimum) || a.index - b.index);

  for (let i = 0; i < pending.length && remaining > 0; i += 1) {
    const slot = pending[i];
    const count = pending.length - i;
    const share = Math.floor(remaining / count);
    const demand = slot.full - slot.minimum;
    if (demand <= share) {
      slot.allocation += demand;
      remaining -= demand;
      continue;
    }

    const remainder = remaining % count;
    for (let j = i; j < pending.length; j += 1) {
      pending[j].allocation += share + (j - i < remainder ? 1 : 0);
    }
    break;
  }
}

function createFitter(tracker: ChangeTracker) {
  const sizes = new WeakMap<object, number>();

  const sizeOf = (value: JsonValue): number => {
    if (value !== null && typeof value === "object") {
      const cached = sizes.get(value);
      if (cached !== undefined) return cached;
      const size = charCount(JSON.stringify(value));
      sizes.set(value, size);
      return size;
    }
    return charCount(JSON.stringify(value));
  };

  const minimumSize = (value: JsonValue): number => {
    if (typeof value === "string" || Array.isArray(value)) return 2; // "" or []
    if (value !== null && typeof value === "object") {
      // An array of hundreds of empty objects is not useful. Reserve enough
      // for one identifying or text field when the item has one; if the
      // budget cannot accommodate all entries, report an omitted suffix.
      for (const key of IDENTITY_KEYS) {
        if (!Object.hasOwn(value, key)) continue;
        const child = value[key];
        if (child !== null && typeof child === "object") continue;
        const childMinimum = typeof child === "string" ? Math.min(sizeOf(child), 128) : sizeOf(child);
        return 2 + charCount(JSON.stringify(key)) + 1 + childMinimum;
      }
      return 2;
    }
    return sizeOf(value);
  };

  const fit = (value: JsonValue, budget: number, path: string): JsonValue => {
    if (sizeOf(value) <= budget) return value;

    if (typeof value === "string") {
      recordChange(tracker, path);
      return fitString(value, budget);
    }

    if (Array.isArray(value)) {
      const slots: Slot[] = [];
      let fixed = 2; // brackets and commas
      let minimums = 0;
      for (let index = 0; index < value.length; index += 1) {
        const child = value[index];
        const minimum = minimumSize(child);
        const punctuation = slots.length > 0 ? 1 : 0;
        if (fixed + punctuation + minimums + minimum > budget) {
          // Preserve array order and report that one or more entries were omitted.
          recordChange(tracker, path);
          break;
        }
        fixed += punctuation;
        minimums += minimum;
        slots.push({ index, value: child, minimum, full: sizeOf(child), allocation: minimum });
      }
      allocate(slots, budget - fixed);
      return slots.map((slot) => fit(slot.value, slot.allocation, indexPath(path, slot.index)));
    }

    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      // Prefer identifiers and the search/fetch containers when even the
      // structural overhead does not fit. Restore the original field order in
      // the result; no provider data is re-ranked.
      const candidates = entries.map(([key, child], index) => ({ key, child, index }));
      candidates.sort((a, b) =>
        (KEY_PRIORITY.get(a.key) ?? IMPORTANT_KEYS.length) - (KEY_PRIORITY.get(b.key) ?? IMPORTANT_KEYS.length)
        || a.index - b.index,
      );
      const slots: Slot[] = [];
      let fixed = 2; // braces, keys, colons and commas
      let minimums = 0;
      for (const { key, child, index } of candidates) {
        const minimum = minimumSize(child);
        const punctuation = (slots.length > 0 ? 1 : 0) + charCount(JSON.stringify(key)) + 1;
        if (fixed + punctuation + minimums + minimum > budget) {
          recordChange(tracker, propertyPath(path, key));
          continue;
        }
        fixed += punctuation;
        minimums += minimum;
        slots.push({ index, key, value: child, minimum, full: sizeOf(child), allocation: minimum });
      }
      slots.sort((a, b) => a.index - b.index);
      allocate(slots, budget - fixed);
      const result: { [key: string]: JsonValue } = Object.create(null);
      for (const slot of slots) {
        const key = slot.key!;
        result[key] = fit(slot.value, slot.allocation, propertyPath(path, key));
      }
      return result;
    }

    // Parents reserve the complete serialized size for non-string scalars.
    throw new Error("Insufficient JSON budget for scalar value");
  };

  return fit;
}

function minimalTruncatedJson(limit: number): string {
  for (const text of ['{"_truncation":{"truncated":true}}', '{"_truncated":true}', "{}", "0"]) {
    if (text.length <= limit) return text;
  }
  throw new RangeError("The JSON output limit must be at least one character");
}

/**
 * Preserve ordinary output exactly. If compact JSON still exceeds the limit,
 * fit its fields and array entries independently and report affected paths.
 * The returned text is valid JSON and never exceeds `maxChars` code points.
 */
export function formatJsonWithinLimit(
  output: object,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new RangeError("The JSON output limit must be at least one character");
  }
  const limit = Math.floor(maxChars);
  const pretty = JSON.stringify(output, null, 2);
  const originalChars = charCount(pretty);
  if (originalChars <= limit) return { text: pretty, truncated: false };

  // Work from the already serialized value, so JSON's handling of undefined,
  // dates and toJSON is identical even if an input object is not plain data.
  const parsed = JSON.parse(pretty) as { [key: string]: JsonValue };
  const compact = JSON.stringify(parsed);
  if (charCount(compact) <= limit) return { text: compact, truncated: false };

  const info: TruncationInfo = {
    truncated: true,
    originalChars,
    affectedPaths: [],
    moreAffectedPaths: false,
  };
  // Account for the metadata entry and a comma joining it to the root object.
  const overhead = charCount(JSON.stringify({ _truncation: info })) - 2 + 1;
  if (limit - overhead < 2) return { text: minimalTruncatedJson(limit), truncated: true };

  const build = (reservedPaths: number) => {
    const tracker: ChangeTracker = { paths: [], seen: new Set(), more: false };
    const fit = createFitter(tracker);
    const fitted = fit(parsed, limit - overhead - reservedPaths, "$") as { [key: string]: JsonValue };
    return { fitted, tracker };
  };

  let result = build(0);
  // Reserve just enough room for the first pass's affected paths, capped so
  // reporting never consumes a disproportionate share of the result budget.
  const desiredPathSpace = Math.min(
    MAX_PATH_BUDGET,
    Math.max(64, Math.floor(limit * 0.05)),
    charCount(JSON.stringify(result.tracker.paths)) - 2,
  );
  if (desiredPathSpace > 0 && limit - overhead - desiredPathSpace >= 2) {
    result = build(desiredPathSpace);
  }

  const combined: { [key: string]: unknown } = Object.create(null);
  combined._truncation = info;
  for (const [key, value] of Object.entries(result.fitted)) {
    if (key !== "_truncation") combined[key] = value;
  }

  let remaining = limit - charCount(JSON.stringify(combined));
  for (const path of result.tracker.paths) {
    const cost = charCount(JSON.stringify(path)) + (info.affectedPaths.length > 0 ? 1 : 0);
    if (cost > remaining) {
      info.moreAffectedPaths = true;
      break;
    }
    info.affectedPaths.push(path);
    remaining -= cost;
  }
  if (result.tracker.more) info.moreAffectedPaths = true;

  return { text: JSON.stringify(combined), truncated: true };
}

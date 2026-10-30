type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Slot {
  index: number;
  key?: string;
  value: JsonValue;
  minimum: number;
  full: number;
  allocation: number;
}

const TRUNCATION_MARKER = "[truncated]";
const IDENTITY_KEYS = ["url", "uri", "href", "link", "title", "name", "id", "error", "status", "query", "answer", "content", "text"];
const IMPORTANT_KEYS = [...IDENTITY_KEYS, "search", "fetched", "results", "data"];
const KEY_PRIORITY = new Map(IMPORTANT_KEYS.map((key, index) => [key, index]));

/** Link and identity fields are kept intact or their containing entry is omitted. */
function isProtectedKey(key: string): boolean {
  return /^(?:url|uri|href|link|permalink|website|title|name|id)$/i.test(key)
    || /[_-](?:url|uri|href|link|permalink|website|title|name|id)$/i.test(key)
    || /(?:URL|URI|HREF|LINK|TITLE|NAME|Url|Uri|Href|Link|Title|Name|Id|ID)$/.test(key);
}

function isLinkCollectionKey(key: string): boolean {
  return /^(?:urls?|uris?|hrefs?|links?|permalinks?|websites?|titles?|names?|ids?|sources?|citations?)$/i.test(key)
    || /[_-](?:urls|uris|hrefs|links|titles|names|ids)$/i.test(key)
    || /(?:URLs|URIs|Urls|Uris|Hrefs|Links|Titles|Names|Ids|IDs)$/.test(key);
}

function isStandaloneUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]{0,31}:\/\/|mailto:|urn:|doi:|tel:|www\.)\S+$/i.test(value);
}

/** Count Unicode code points, rather than UTF-16 code units. */
function charCount(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
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
  // Reserve the quotes; the single truncation marker is added after the JSON.
  let remaining = budget - 2;
  const prefix: string[] = [];
  for (const character of value) {
    const size = encodedCharacterLength(character);
    if (size > remaining) break;
    prefix.push(character);
    remaining -= size;
  }
  const visible = prefix.join("");
  if (visible.length === value.length) return visible;

  // A cut inside a URL embedded in prose must not leave a plausible but broken
  // link. Drop the incomplete URL token instead of changing its address.
  const urlStart = /\b(?:[a-z][a-z0-9+.-]{0,31}:\/\/|mailto:|urn:|doi:|tel:|www\.)/gi;
  for (let match = urlStart.exec(value); match && match.index < visible.length; match = urlStart.exec(value)) {
    let end = match.index + match[0].length;
    while (end < value.length && !/\s/.test(value[end])) end += 1;
    if (end > visible.length) return visible.slice(0, match.index);
    urlStart.lastIndex = end;
  }
  return visible;
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

function createFitter() {
  const sizes = new WeakMap<object, number>();
  const requiredSizes = new WeakMap<object, number>();

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

  function requiredPropertySize(key: string, value: JsonValue): number | undefined {
    if (isProtectedKey(key) && !Array.isArray(value)) return sizeOf(value);
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) return undefined;
      const nested = requiredSize(value);
      return nested > 0 ? nested : undefined;
    }
    if (typeof value === "string" && isStandaloneUrl(value)) return sizeOf(value);
    return undefined;
  }

  // Reserve every direct or nested identity field before allocating space to
  // optional content. Arrays can still omit a suffix of complete entries.
  function requiredSize(value: { [key: string]: JsonValue }): number {
    const cached = requiredSizes.get(value);
    if (cached !== undefined) return cached;
    let size = 2;
    let count = 0;
    for (const [key, child] of Object.entries(value)) {
      const required = requiredPropertySize(key, child);
      if (required === undefined) continue;
      size += (count > 0 ? 1 : 0) + charCount(JSON.stringify(key)) + 1 + required;
      count += 1;
    }
    const result = count > 0 ? size : 0;
    requiredSizes.set(value, result);
    return result;
  }

  const minimumSize = (value: JsonValue, key = "", linkCollection = false): number => {
    if (Array.isArray(value)) return 2; // []
    if (isProtectedKey(key)) return sizeOf(value);
    if (typeof value === "string") {
      return linkCollection || isStandaloneUrl(value) ? sizeOf(value) : 2;
    }
    if (value !== null && typeof value === "object") {
      const required = requiredSize(value);
      if (required > 0) return required;
      // Avoid arrays of empty objects when a useful text field is available.
      for (const identity of IDENTITY_KEYS) {
        if (!Object.hasOwn(value, identity)) continue;
        const child = value[identity];
        if (child !== null && typeof child === "object") continue;
        const childMinimum = typeof child === "string" ? Math.min(sizeOf(child), 128) : sizeOf(child);
        return 2 + charCount(JSON.stringify(identity)) + 1 + childMinimum;
      }
      return 2;
    }
    return sizeOf(value);
  };

  const fit = (value: JsonValue, budget: number, linkCollection = false, root = false): JsonValue => {
    if (sizeOf(value) <= budget) return value;

    if (typeof value === "string") return fitString(value, budget);

    if (Array.isArray(value)) {
      const slots: Slot[] = [];
      let fixed = 2; // brackets and commas
      let minimums = 0;
      for (let index = 0; index < value.length; index += 1) {
        const child = value[index];
        const minimum = minimumSize(child, "", linkCollection);
        const punctuation = slots.length > 0 ? 1 : 0;
        if (fixed + punctuation + minimums + minimum > budget) {
          // Preserve array order when some entries must be omitted.
          break;
        }
        fixed += punctuation;
        minimums += minimum;
        slots.push({ index, value: child, minimum, full: sizeOf(child), allocation: minimum });
      }
      allocate(slots, budget - fixed);
      return slots.map((slot) => fit(slot.value, slot.allocation, linkCollection));
    }

    if (value !== null && typeof value === "object") {
      // An object cannot be shown with only a fragment of a required identity.
      if (!root && requiredSize(value) > budget) return Object.create(null) as JsonValue;
      const entries = Object.entries(value);
      // Reserve required identifiers first, but restore the original field
      // order in the result; no provider data or array entry is re-ranked.
      const candidates = entries.map(([key, child], index) => ({
        key, child, index, required: requiredPropertySize(key, child) !== undefined,
      }));
      candidates.sort((a, b) =>
        Number(b.required) - Number(a.required)
        || (KEY_PRIORITY.get(a.key) ?? IMPORTANT_KEYS.length) - (KEY_PRIORITY.get(b.key) ?? IMPORTANT_KEYS.length)
        || a.index - b.index,
      );
      const slots: Slot[] = [];
      let fixed = 2; // braces, keys, colons and commas
      let minimums = 0;
      for (const { key, child, index } of candidates) {
        const minimum = minimumSize(child, key);
        const punctuation = (slots.length > 0 ? 1 : 0) + charCount(JSON.stringify(key)) + 1;
        if (fixed + punctuation + minimums + minimum > budget) continue;
        fixed += punctuation;
        minimums += minimum;
        slots.push({ index, key, value: child, minimum, full: sizeOf(child), allocation: minimum });
      }
      slots.sort((a, b) => a.index - b.index);
      allocate(slots, budget - fixed);
      const result: { [key: string]: JsonValue } = Object.create(null);
      for (const slot of slots) {
        const key = slot.key!;
        result[key] = fit(slot.value, slot.allocation, isLinkCollectionKey(key));
      }
      return result;
    }

    // Parents reserve the complete serialized size for non-string scalars.
    throw new Error("Insufficient JSON budget for scalar value");
  };

  return fit;
}

/**
 * Preserve ordinary output exactly. If compact JSON still exceeds the limit,
 * fit its fields and array entries independently and append one marker line.
 * The JSON portion stays valid and the entire text fits within `maxChars` code
 * points. Tiny limits may only fit the marker or a minimal JSON value.
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
  if (charCount(pretty) <= limit) return { text: pretty, truncated: false };

  // Work from the already serialized value, so JSON's handling of undefined,
  // dates and toJSON is identical even if an input object is not plain data.
  const parsed = JSON.parse(pretty) as JsonValue;
  const compact = JSON.stringify(parsed);
  if (charCount(compact) <= limit) return { text: compact, truncated: false };

  // Below 14 characters there is not enough room for both an empty JSON object
  // and the marker on a new line. Prefer a complete marker whenever it fits.
  if (limit < TRUNCATION_MARKER.length + 3) {
    const text = limit >= TRUNCATION_MARKER.length ? TRUNCATION_MARKER : limit >= 2 ? "{}" : "0";
    return { text, truncated: true };
  }

  const budget = limit - TRUNCATION_MARKER.length - 1; // newline + marker
  const fit = createFitter();
  // A toJSON method can return a scalar that cannot be shortened to fit.
  const fitted = parsed === null || typeof parsed === "boolean" || typeof parsed === "number"
    ? {}
    : fit(parsed, budget, false, true);
  return { text: `${JSON.stringify(fitted)}\n${TRUNCATION_MARKER}`, truncated: true };
}

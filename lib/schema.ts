import { Type, type TSchema } from "typebox";

export type { TSchema } from "typebox";

export const WEB_SEARCH_TOOL_NAME = "web_search";
const SEARCH_INTRO = "Search the live web and return the most relevant URLs and content.";
const SEARCH_PURPOSE = "Use for current information, fact-checking, and documentation lookup.";
const SEARCH_REFINEMENT = "If the evidence is insufficient or conflicting, refine the query and search again.";
export const WEB_SEARCH_DESCRIPTION = [
  SEARCH_INTRO,
  SEARCH_PURPOSE,
  "Search excerpts may lack context; fetch relevant pages when needed to verify important details and cite the source URLs used.",
  SEARCH_REFINEMENT,
].join(" ");
export const WEB_SEARCH_QUERY_ONLY_DESCRIPTION = [
  SEARCH_INTRO,
  SEARCH_PURPOSE,
  "Search excerpts may lack context; verify important details against original sources when possible and cite the source URLs used.",
  SEARCH_REFINEMENT,
].join(" ");
export const MAX_URLS = 20;
export const MAX_URL_LENGTH = 8192;

const QUERY_STYLE = "Web search query. Prefer natural language describing the needed information; include relevant time scope and source preferences.";
const QUERY_DESCRIPTION = `${QUERY_STYLE} Providing query triggers a web search.`;
const QUERY_WITH_URLS_DESCRIPTION =
  `${QUERY_STYLE} Providing query triggers a separate web search, even when urls are supplied. Omit it when only fetching the supplied URLs.`;
const URLS_DESCRIPTION =
  "HTTP/HTTPS URLs to fetch (1-20). Can be used alone without query to read known pages or verify search results. Providing query as well also triggers a separate web search.";

export interface WebSearchSchemaOptions {
  allowUrls: boolean;
}

/**
 * Build the model-facing schema. URL-capable providers get optional query and
 * urls fields; query-only providers get a required query. "At least one of
 * query/urls" is enforced at runtime because a top-level anyOf is not
 * compatible with all providers.
 */
export function buildWebSearchSchema({ allowUrls }: WebSearchSchemaOptions): TSchema {
  if (!allowUrls) {
    return Type.Object({
      query: Type.String({ minLength: 1, description: QUERY_DESCRIPTION }),
    }, { additionalProperties: false });
  }

  return Type.Object({
    query: Type.Optional(Type.String({ minLength: 1, description: QUERY_WITH_URLS_DESCRIPTION })),
    urls: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: MAX_URL_LENGTH }), {
        minItems: 1,
        maxItems: MAX_URLS,
        description: URLS_DESCRIPTION,
      }),
    ),
  }, { additionalProperties: false });
}

/** Keep usage guidance aligned with the capabilities exposed in the schema. */
export function buildWebSearchToolDescription({ allowUrls }: WebSearchSchemaOptions): string {
  return allowUrls ? WEB_SEARCH_DESCRIPTION : WEB_SEARCH_QUERY_ONLY_DESCRIPTION;
}

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
export const MAX_PARALLEL_SEARCH_QUERIES = 3;

export const PARALLEL_SEARCH_DESCRIPTION =
  "Search the web and return result titles, URLs, and excerpts.";
export const PARALLEL_EXTRACT_DESCRIPTION =
  "Fetches content from the given URL, returning the content of the page, or if objective is provided, returns the content of the page that is most relevant to the objective. Use this to fetch content from any specific page on the web.";
export const PARALLEL_WEB_SEARCH_DESCRIPTION = [
  PARALLEL_SEARCH_DESCRIPTION,
  PARALLEL_EXTRACT_DESCRIPTION,
].join(" ");
export const PARALLEL_SEARCH_OBJECTIVE_DESCRIPTION =
  "Describe the search goal in a concise, standalone sentence. Name the key entity or topic.";
export const PARALLEL_EXTRACT_OBJECTIVE_DESCRIPTION =
  "Natural-language description of what to extract from the page. For example, information about a certain method or a class in a page. If not provided, the entire page is fetched.";
export const PARALLEL_OBJECTIVE_DESCRIPTION = [
  PARALLEL_SEARCH_OBJECTIVE_DESCRIPTION,
  PARALLEL_EXTRACT_OBJECTIVE_DESCRIPTION,
].join(" ");
export const PARALLEL_SEARCH_QUERIES_DESCRIPTION =
  "Provide 1-3 keyword queries of 3-6 words each. Include the key entity or topic in every query. For multiple queries, vary names, synonyms, or angles. Do not use sentences, instructions, or site: operators.";
export const PARALLEL_URLS_DESCRIPTION =
  "The URLs to fetch content from.";

const QUERY_STYLE = "Web search query. Prefer natural language describing the needed information; include relevant time scope and source preferences.";
const QUERY_DESCRIPTION = `${QUERY_STYLE} Providing query triggers a web search.`;
const QUERY_WITH_URLS_DESCRIPTION =
  `${QUERY_STYLE} Providing query triggers a separate web search, even when urls are supplied. Omit it when only fetching the supplied URLs.`;
const URLS_DESCRIPTION =
  "HTTP/HTTPS URLs to fetch (1-20). Can be used alone without query to read known pages or verify search results. Providing query as well also triggers a separate web search.";

export interface WebSearchSchemaOptions {
  allowUrls: boolean;
  parallel?: boolean;
}

/**
 * Build the model-facing schema. URL-capable providers get optional query and
 * urls fields; query-only providers get a required query. When Parallel is
 * active, the schema switches to Parallel's official objective, search_queries,
 * and urls fields. "At least one operation" is enforced at runtime because a
 * top-level anyOf is not compatible with all providers.
 */
export function buildWebSearchSchema({ allowUrls, parallel = false }: WebSearchSchemaOptions): TSchema {
  if (parallel) {
    return Type.Object({
      objective: Type.Optional(Type.String({ minLength: 1, description: PARALLEL_OBJECTIVE_DESCRIPTION })),
      search_queries: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: MAX_PARALLEL_SEARCH_QUERIES,
          description: PARALLEL_SEARCH_QUERIES_DESCRIPTION,
        }),
      ),
      urls: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: MAX_URL_LENGTH }), {
          minItems: 1,
          maxItems: MAX_URLS,
          description: PARALLEL_URLS_DESCRIPTION,
        }),
      ),
    }, { additionalProperties: false });
  }

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
export function buildWebSearchToolDescription({ allowUrls, parallel = false }: WebSearchSchemaOptions): string {
  if (parallel) return PARALLEL_WEB_SEARCH_DESCRIPTION;
  return allowUrls ? WEB_SEARCH_DESCRIPTION : WEB_SEARCH_QUERY_ONLY_DESCRIPTION;
}

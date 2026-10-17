import { Type, type TSchema } from "typebox";

export type { TSchema } from "typebox";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_DESCRIPTION = "Search the web or analyze specified URLs.";
export const MAX_URLS = 20;

const QUERY_DESCRIPTION = "The search query or question.";
const QUERY_WITH_URLS_DESCRIPTION =
  "The search query or question. Use query alone to search the web, or combine it with urls to search and analyze those URLs.";
const URLS_DESCRIPTION =
  "URLs to analyze. Can be used alone without query, or together with query (1-20 URLs).";

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
    });
  }

  return Type.Object({
    query: Type.Optional(Type.String({ minLength: 1, description: QUERY_WITH_URLS_DESCRIPTION })),
    urls: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MAX_URLS,
        description: URLS_DESCRIPTION,
      }),
    ),
  });
}

/** The description is identical for both schema variants; the schema hides urls. */
export function buildWebSearchToolDescription(_options: WebSearchSchemaOptions): string {
  return WEB_SEARCH_DESCRIPTION;
}

/** Remove known API bookkeeping only at the response root. Result objects and
 * page content may use the same field names and must remain untouched. */
export function omitResponseMetadata(
  data: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const result = { ...data };
  for (const field of fields) delete result[field];
  return result;
}

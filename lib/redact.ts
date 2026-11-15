/** Redact literal secrets and their JSON-escaped forms in untrusted errors. */
export function redactSecrets(message: string, secrets: Iterable<string | undefined>): string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  // Replace longer credentials first so a shared prefix cannot leave a suffix
  // exposed (for example an Authorization value plus its bare token).
  for (const value of [...variants].sort((a, b) => b.length - a.length)) {
    message = message.split(value).join("[REDACTED]");
  }
  return message;
}

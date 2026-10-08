/**
 * Background diagnostics. Callers pass fixed event names and short codes only;
 * message payloads, item fields, passwords and keys are never logged.
 */
export function createLogger(sink: (line: string) => void = (l) => console.info(l)) {
  return (event: string, detail?: string) => sink(`[PassVault] ${event}${detail ? ` (${detail})` : ''}`);
}

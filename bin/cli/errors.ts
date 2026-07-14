/**
 * User-facing CLI failure. `main()` catches this, prints `error: <message>`,
 * and exits non-zero without a stack trace — see bin/humming.ts.
 */
export class CliError extends Error {
  override readonly name = "CliError";
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

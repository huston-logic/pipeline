// The copy's email logging address (decision 0031), read from the EMAIL_LOG_ADDRESS secret. Import-free apart from
// types, so the board can show it without loading the email parser.
import type { Env } from "../env.ts";

/** The address as set, trimmed, or null when this copy has none. */
export function logAddressOf(env: Pick<Env, "EMAIL_LOG_ADDRESS">): string | null {
  const address = (env.EMAIL_LOG_ADDRESS ?? "").trim();
  return address === "" ? null : address;
}

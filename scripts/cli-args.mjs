// Command-line flags for the copy scripts (scripts/copies.mjs, scripts/import-csv.ts): `--flag value` or
// `--flag=value`, switches with no value, and list flags that may repeat. Anything else is a UsageError that says how
// to fix the command, so a typo never runs something the owner didn't ask for.

/** A mistake in the command itself; the scripts exit 2 with its message and no stack. */
export class UsageError extends Error {}

const twice = (flag) => new UsageError(`${flag} is given twice. Give it once.`);

/**
 * @typedef {{ key: string, example: string, allowEmpty?: boolean }} ValueFlag
 * @typedef {{ values?: Record<string, ValueFlag>, switches?: Record<string, string>, lists?: Record<string, ValueFlag> }} FlagSpec
 */

/**
 * The flags in `argv` as { [key]: value }: a string for a value flag, true for a switch, a string[] for a list flag.
 * A value flag's value is the next argument unless that is another flag ("--copy --dry-run" is a missing value).
 * @param {string[]} argv
 * @param {FlagSpec} spec
 * @param {string} unknownHint what to say after "Unknown option ...".
 * @returns {Record<string, string | boolean | string[]>}
 */
export function parseFlags(argv, spec, unknownHint) {
  const { values = {}, switches = {}, lists = {} } = spec;
  /** @type {Record<string, string | boolean | string[]>} */
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (Object.hasOwn(switches, flag)) {
      if (inline !== undefined) throw new UsageError(`${flag} takes no value. Use ${flag} on its own.`);
      if (seen.has(flag)) throw twice(flag);
      seen.add(flag);
      out[switches[flag]] = true;
      continue;
    }
    const isList = Object.hasOwn(lists, flag);
    const option = isList ? lists[flag] : Object.hasOwn(values, flag) ? values[flag] : undefined;
    if (option === undefined) throw new UsageError(`Unknown option "${arg}". ${unknownHint}`);
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || (value === "" && !option.allowEmpty)) {
      throw new UsageError(`${flag} needs a value, like ${flag} ${option.example}.`);
    }
    if (isList) {
      const list = out[option.key];
      out[option.key] = Array.isArray(list) ? [...list, value] : [value];
      continue;
    }
    if (seen.has(flag)) throw twice(flag);
    seen.add(flag);
    out[option.key] = value;
  }
  return out;
}

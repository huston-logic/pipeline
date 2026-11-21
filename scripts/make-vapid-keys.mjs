// Makes one copy's web push keys (VAPID, RFC 8292; decision 0030) with Node's Web Crypto and prints the three
// `wrangler secret put` commands with the value to paste at each prompt. It writes no file: the private key exists only
// in this terminal and then in the copy's Worker secrets. Run by the repo owner, once per copy:
//   node scripts/make-vapid-keys.mjs --copy <name> [--subject mailto:<the owner's email>]
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseFlags, UsageError } from "./cli-args.mjs";

const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");

/** A fresh P-256 pair: the public key as an uncompressed point and the private scalar d, both base64url. */
export async function makeVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateKey: d };
}

const SUBJECT = /^(mailto:\S+@\S+|https:\/\/\S+)$/;

/** The lines to print: for each secret, the command and the value to paste when wrangler asks for it. */
export function secretLines(keys, { copy, subject }) {
  const config = `.copies/${copy}/wrangler.jsonc`;
  const entries = [
    ["VAPID_PUBLIC_KEY", keys.publicKey],
    ["VAPID_PRIVATE_KEY", keys.privateKey],
    ["VAPID_SUBJECT", subject],
  ];
  return [
    `Web push keys for the copy "${copy}". Run each command and paste the value below it when wrangler asks.`,
    "The private key is not saved anywhere else: set it now, then clear this terminal.",
    "",
    ...entries.flatMap(([name, value]) => [`npx wrangler secret put ${name} -c ${config}`, `  paste: ${value}`, ""]),
  ];
}

const FLAGS = {
  values: {
    "--copy": { key: "copy", example: "acme" },
    "--subject": { key: "subject", example: "mailto:owner@example.com" },
  },
};

export async function main(argv = process.argv.slice(2), log = console.log) {
  const flags = parseFlags(argv, FLAGS, "Use --copy <name> and, if you like, --subject mailto:<owner email>.");
  const copy = typeof flags.copy === "string" ? flags.copy : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(copy)) throw new UsageError("Give the copy's name, like --copy acme (lower case, digits and dashes).");
  const subject = typeof flags.subject === "string" ? flags.subject : "mailto:<the owner's email>";
  if (typeof flags.subject === "string" && !SUBJECT.test(subject)) {
    throw new UsageError("--subject must start with mailto: or https://, like --subject mailto:owner@example.com.");
  }
  for (const line of secretLines(await makeVapidKeys(), { copy, subject })) log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}

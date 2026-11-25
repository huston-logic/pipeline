// One campaign email: an HTML part with inline styles only (mail clients drop <style>) and a text part. Pure and
// deterministic, so a retried batch rebuilds byte-identical payloads.
import { html } from "../board/html.ts";
import type { Html } from "../board/html.ts";
import type { CampaignStepRow } from "../db/db.ts";
import { isUsableAccent } from "../services/accent.ts";
import { parseBody } from "./body.ts";
import type { Inline } from "./body.ts";

/** Mirrors of `--ink`, `--ink-2`, `--line` and `--silver` in public/board.css (a test keeps them in step). */
export const EMAIL_COLORS = { ink: "#29332d", muted: "#4a5750", line: "#d3dad6", page: "#f3f5f4" };

/** The board's default accent (`--green`), used when the given accent is not usable. */
const DEFAULT_ACCENT = "#2b6455";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MERGE = /\{\{\s*first_name\s*\}\}/gi;

export type EmailRecipient = { firstName: string | null; token: string };
export type EmailFrame = { business: string; postal: string; baseUrl: string; fallback: string; accent: string };

const lines = (text: string): string[] => text.replace(/\r\n?/g, "\n").split("\n");

export function renderEmail(
  step: CampaignStepRow,
  r: EmailRecipient,
  frame: EmailFrame,
): { subject: string; html: string; text: string } {
  const value = r.firstName ?? frame.fallback;
  const merge = (text: string) => text.replace(MERGE, () => value);
  const subject = merge(step.subject).replace(/\s+/g, " ").trim();
  const unsubscribe = `${frame.baseUrl.replace(/\/$/, "")}/unsubscribe/${r.token}`;
  const accent = isUsableAccent(frame.accent) ? frame.accent : DEFAULT_ACCENT;
  const blocks = parseBody(step.body);
  const hasButton = step.button_label !== null && step.button_url !== null;

  const inlineHtml = (part: Inline): Html =>
    part.kind === "text"
      ? html`${merge(part.text)}`
      : html`<a href="${part.href}" style="color:${accent};text-decoration:underline">${merge(part.text)}</a>`;
  const paragraph = (block: (typeof blocks)[number]): Html => {
    const rows = block.lines.map((line) => line.map(inlineHtml));
    const joined = rows.flatMap((row, i) => (i === 0 ? [row] : [html`<br>`, row]));
    return html`<p style="margin:0 0 16px">${joined}</p>`;
  };
  const button = hasButton
    ? html`<p style="margin:24px 0"><a href="${step.button_url}" style="display:inline-block;padding:14px 24px;min-height:16px;background:${accent};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${step.button_label}</a></p>`
    : "";
  const postalHtml = lines(frame.postal).flatMap((line, i) => (i === 0 ? [line] : [html`<br>`, line]));

  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:24px 12px;background:${EMAIL_COLORS.page};font-family:${FONT};font-size:16px;line-height:1.5;color:${EMAIL_COLORS.ink}">
<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;font-family:${FONT};font-size:16px;line-height:1.5;color:${EMAIL_COLORS.ink}">
${blocks.map(paragraph)}
${button}
<hr style="border:0;border-top:1px solid ${EMAIL_COLORS.line};margin:32px 0 16px">
<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${EMAIL_COLORS.muted}">${frame.business}<br>${postalHtml}</p>
<p style="margin:0;font-size:14px;line-height:1.5;color:${EMAIL_COLORS.muted}"><a href="${unsubscribe}" style="color:${EMAIL_COLORS.muted};text-decoration:underline">Unsubscribe from these emails</a></p>
</div>
</body>
</html>`;

  const inlineText = (part: Inline): string => {
    if (part.kind === "text") return merge(part.text);
    const label = merge(part.text);
    return label === part.href ? part.href : `${label} (${part.href})`;
  };
  const parts = blocks.map((block) => block.lines.map((line) => line.map(inlineText).join("")).join("\n"));
  if (hasButton) parts.push(`${step.button_label}: ${step.button_url}`);
  parts.push(["--", frame.business, ...lines(frame.postal), `Unsubscribe: ${unsubscribe}`].join("\n"));

  return { subject, html: page.value, text: parts.join("\n\n") };
}

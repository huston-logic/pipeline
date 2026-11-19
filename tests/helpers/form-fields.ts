// The fields a browser would send for a form drawn by the board, read from the page's markup. No imports, so the
// end-to-end tests can use it too.
/** Every named control of the form posting to `action`, as a browser would send it unchanged. */
export function formFields(body: string, action: string): URLSearchParams {
  const start = body.indexOf(`action="${action}"`);
  if (start < 0) throw new Error(`No form posts to ${action}.`);
  const end = body.indexOf("</form>", start);
  const form = body.slice(start, end);
  const fields = new URLSearchParams();
  const unescape = (text: string) =>
    text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  for (const m of form.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
    if (name === undefined) continue;
    fields.append(unescape(name), unescape(/\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? ""));
  }
  // Textareas and selects by their opening tag, and their content up to the matching close tag (found by position).
  for (const { name, content } of elements(form, "textarea")) {
    // A browser sends a textarea's newlines as CRLF.
    fields.append(unescape(name), unescape(content).replace(/\n/g, "\r\n"));
  }
  for (const { name, content } of elements(form, "select")) {
    const selected = /<option value="([^"]*)" selected>/.exec(content) ?? /<option value="([^"]*)"/.exec(content);
    fields.append(unescape(name), unescape(selected?.[1] ?? ""));
  }
  return fields;
}

function elements(markup: string, tag: "textarea" | "select"): { name: string; content: string }[] {
  const found: { name: string; content: string }[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))) {
    const name = /\bname="([^"]*)"/.exec(m[1] ?? "")?.[1];
    const start = (m.index ?? 0) + m[0].length;
    const end = markup.indexOf(`</${tag}>`, start);
    if (name !== undefined && end >= 0) found.push({ name, content: markup.slice(start, end) });
  }
  return found;
}

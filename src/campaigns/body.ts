// A campaign's body is plain text: paragraphs, line breaks and https links, never HTML. The renderer (email) and the
// board preview both read it through parseBody, so what the owner sees is what is sent.

export type Inline = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/** A paragraph: one entry per source line. */
export type Block = { lines: Inline[][] };

/** True for a plain https address: no spaces, no user name or password, a host. */
export function isHttpsUrl(text: string): boolean {
  if (!/^https:\/\/\S+$/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

// A [label](https://...) link, or a bare https address (http: and other schemes never match, so they stay text).
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)|https:\/\/[^\s<>]+/g;
const TRAILING = /[.,;:!?)]+$/;

function parseLine(line: string): Inline[] {
  const out: Inline[] = [];
  const addText = (text: string) => {
    if (text === "") return;
    const last = out.at(-1);
    if (last?.kind === "text") last.text += text;
    else out.push({ kind: "text", text });
  };
  let at = 0;
  for (const match of line.matchAll(LINK)) {
    addText(line.slice(at, match.index));
    const [whole, label, target] = match;
    if (label !== undefined && target !== undefined) {
      if (isHttpsUrl(target)) out.push({ kind: "link", text: label, href: target });
      else addText(whole);
    } else {
      const url = whole.replace(TRAILING, "");
      if (isHttpsUrl(url)) {
        out.push({ kind: "link", text: url, href: url });
        addText(whole.slice(url.length));
      } else addText(whole);
    }
    at = match.index + whole.length;
  }
  addText(line.slice(at));
  return out;
}

export function parseBody(text: string): Block[] {
  const blocks: Block[] = [];
  let lines: Inline[][] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      if (lines.length > 0) blocks.push({ lines });
      lines = [];
    } else lines.push(parseLine(line));
  }
  if (lines.length > 0) blocks.push({ lines });
  return blocks;
}

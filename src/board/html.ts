export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type HtmlValue = Html | string | number | boolean | null | undefined | readonly HtmlValue[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Marks markup as trusted. Only for strings written in this repo, never for data. */
export function raw(markup: string): Html {
  return new Html(markup);
}

function render(value: HtmlValue): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

/** Template tag that escapes every interpolation except Html fragments (from `html` or `raw`). */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

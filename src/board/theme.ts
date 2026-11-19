// /theme.css: the owner's accent colour as a stylesheet (decision 0015). The CSP allows no inline styles, so the
// setting reaches the page as this small file, linked after /board.css. The stored value is checked again here, so a
// value written around the service (an import, a hand fix) can never put anything else into the stylesheet.
import type { Db } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { isUsableAccent } from "../services/accent.ts";

export const THEME_PATH = "/theme.css";

export function themeCss(accent: string | null): string {
  if (accent === null) return "/* No accent colour is set, so the board uses its default. */\n";
  if (!isUsableAccent(accent)) return "/* The accent colour in the settings can't be used, so the board uses its default. */\n";
  return `:root{--accent:${accent};}\n`;
}

export async function themeStylesheet(db: Db): Promise<string> {
  return themeCss((await getSettings(db)).accent_color);
}

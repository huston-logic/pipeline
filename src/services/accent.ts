// The board's accent colour, an owner setting (decision 0015). The board puts white text on it (buttons) and uses it
// as text on white cards and on the silver page (links, the current tab), so every one of those pairs must reach the
// WCAG AA ratio for body text. Stored in lower case, so a stored value can be checked again before it is written out.
import { UserError } from "./errors.ts";

/** The `--silver` page background in public/board.css (a test keeps the two in step). */
export const PAGE_SILVER = "#f3f5f4";
const WHITE = "#ffffff";
const MIN_RATIO = 4.5;

const HEX = /^#[0-9a-fA-F]{6}$/;
const STORED = /^#[0-9a-f]{6}$/;

function channel(hex: string, at: number): number {
  const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2 contrast ratio of two #rrggbb colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The weakest of the three pairs the board draws with the accent. */
export function accentContrast(hex: string): number {
  return Math.min(contrastRatio(WHITE, hex), contrastRatio(hex, WHITE), contrastRatio(hex, PAGE_SILVER));
}

/** A valid accent in its stored spelling (lower case), or a UserError saying how to fix it. */
export function checkAccent(input: string): string {
  const text = input.trim();
  if (!HEX.test(text)) {
    throw new UserError(`"${input}" isn't a colour I can use. Give a hex colour like #2b6455, or null to clear it.`);
  }
  const hex = text.toLowerCase();
  const ratio = accentContrast(hex);
  if (ratio < MIN_RATIO) {
    throw new UserError(
      `${hex} is too light to use on the board: white text on it, and it as text on white or on the page background, ` +
        `need a contrast of at least 4.5 to 1, and it has ${(Math.floor(ratio * 100) / 100).toFixed(2)} to 1. ` +
        "Pick a darker colour.",
    );
  }
  return hex;
}

/** True for a stored accent that is still safe to write into the theme stylesheet. */
export function isUsableAccent(value: string | null): value is string {
  return value !== null && STORED.test(value) && accentContrast(value) >= MIN_RATIO;
}

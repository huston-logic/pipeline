// The board's accent colour, an owner setting (decision 0015). The board puts white text on it (buttons) and uses it
// as text on white cards, on the silver page and on the faint glow behind the top of the page (links, the current
// tab), so every one of those pairs must reach the WCAG AA ratio for body text. Stored in lower case, so a stored
// value can be checked again before it is written out.
import { UserError } from "./errors.ts";

/** The `--silver` page background in public/board.css (a test keeps the two in step). */
export const PAGE_SILVER = "#f3f5f4";

/** `--glow-soft` in public/board.css, the centre of the one glow (a test keeps the two in step). */
const GLOW_SOFT = { r: 180, g: 222, b: 200, alpha: 0.5 };

const WHITE = "#ffffff";
const MIN_RATIO = 4.5;

const HEX = /^#[0-9a-fA-F]{6}$/;
const STORED = /^#[0-9a-f]{6}$/;

const byte = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
const toHex = (values: number[]) => `#${values.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The glow's centre over the silver page: the darkest colour accent text can sit on. Rounded down (darker). */
export const PAGE_GLOW = toHex(
  [GLOW_SOFT.r, GLOW_SOFT.g, GLOW_SOFT.b].map((c, i) =>
    Math.floor(c * GLOW_SOFT.alpha + byte(PAGE_SILVER, 1 + 2 * i) * (1 - GLOW_SOFT.alpha)),
  ),
);

function channel(hex: string, at: number): number {
  const value = byte(hex, at) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2 contrast ratio of two #rrggbb colours, from 1 to 21. The order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The weakest pair the board draws with the accent: white text on it and it as text on white (one ratio), it as
 * text on the page silver, and it as text on the glow.
 */
export function accentContrast(hex: string): number {
  return Math.min(contrastRatio(hex, WHITE), contrastRatio(hex, PAGE_SILVER), contrastRatio(hex, PAGE_GLOW));
}

/** A valid accent in its stored spelling (lower case), or a UserError saying how to fix it. */
export function checkAccent(input: string): string {
  const text = input.trim();
  // The input is not repeated: an error message never carries text the caller sent (AGENTS.md).
  if (!HEX.test(text)) throw new UserError("That isn't a colour I can use: give it as #rrggbb, for example #2b6455.");
  const hex = text.toLowerCase();
  const ratio = accentContrast(hex);
  if (ratio < MIN_RATIO) {
    throw new UserError(
      `${hex} is too light to use on the board: white text on it, and it as text on white, on the page background ` +
        `or on the glow at the top of the page, need a contrast of at least 4.5 to 1, and it has ` +
        `${(Math.floor(ratio * 100) / 100).toFixed(2)} to 1. Pick a darker colour.`,
    );
  }
  return hex;
}

/** True for a stored accent that is still safe to write into the theme stylesheet. */
export function isUsableAccent(value: string | null): value is string {
  return value !== null && STORED.test(value) && accentContrast(value) >= MIN_RATIO;
}

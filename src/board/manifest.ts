// /manifest.webmanifest: lets a phone add the board to its home screen (decision 0019). Written by the Worker from the
// settings, like /theme.css, so the app is named after the business and tinted with its accent. Built as an object and
// serialised with JSON.stringify, so a business name can never break out of its string.
import type { Db, SettingsRow } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { PAGE_SILVER } from "../services/accent.ts";
import { DEFAULT_NAME, shortNameOf, themeColorOf } from "./layout.ts";

export const MANIFEST_PATH = "/manifest.webmanifest";

type ManifestIcon = { src: string; sizes: string; type: "image/png"; purpose: "any" | "maskable" };

export type WebManifest = {
  name: string;
  short_name: string;
  id: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
};

const ICONS: ManifestIcon[] = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

type ManifestSettings = Pick<SettingsRow, "business_name" | "accent_color">;

export function webManifest(settings: ManifestSettings): WebManifest {
  const name = settings.business_name ?? DEFAULT_NAME;
  return {
    name,
    short_name: shortNameOf(name),
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PAGE_SILVER,
    theme_color: themeColorOf(settings.accent_color),
    icons: ICONS,
  };
}

export function manifestJson(settings: ManifestSettings): string {
  return JSON.stringify(webManifest(settings));
}

export async function manifestFor(db: Db): Promise<string> {
  return manifestJson(await getSettings(db));
}

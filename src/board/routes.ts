// Every board page path. The accessibility test and lighthouserc.cjs read this list, and lighthouserc.cjs loads it
// with require(), so keep this file free of imports and of TypeScript-only syntax beyond type annotations.

export type NavItem = { href: string; label: string };

export const boardRoutes: string[] = ["/"];

export const navItems: NavItem[] = [{ href: "/", label: "Board" }];

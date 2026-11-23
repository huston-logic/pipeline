// Every import module by key (decision 0034). A key with no module here can't be imported yet.
import type { ImportModuleKey } from "../engine.ts";
import { peopleModule } from "./people.ts";

export { peopleModule };

export const IMPORT_MODULES = { people: peopleModule } as const satisfies Partial<Record<ImportModuleKey, unknown>>;

// Every import module by key (decisions 0034, 0037). Each entry must be an ImportModule (a test checks its key).
import type { AnyImportModule, ImportModuleKey } from "../engine.ts";
import { peopleModule } from "./people.ts";

export { peopleModule };

export const IMPORT_MODULES = { people: peopleModule } as const satisfies Partial<Record<ImportModuleKey, AnyImportModule>>;

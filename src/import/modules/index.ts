// Every import module by key (decisions 0034, 0037). Each entry must be an ImportModule (a test checks its key).
import type { AnyImportModule, ImportModuleKey } from "../engine.ts";
import { dealsModule } from "./deals.ts";
import { peopleModule } from "./people.ts";
import { tasksModule } from "./tasks.ts";

export { dealsModule, peopleModule, tasksModule };

export const IMPORT_MODULES = { people: peopleModule, deals: dealsModule, tasks: tasksModule } as const satisfies Record<
  ImportModuleKey,
  AnyImportModule
>;

export const isImportModuleKey = (text: string | null): text is ImportModuleKey => text !== null && Object.hasOwn(IMPORT_MODULES, text);

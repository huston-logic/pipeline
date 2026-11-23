// The board import's words for each module (decisions 0036, 0037): headings, ledes, where Cancel and the done step go.
// Fixed text only: nothing here comes from a file.
import type { ImportModuleKey } from "../import/engine.ts";

export interface ImportText {
  heading: string;
  /** What one row is about, as in "each person's name". */
  one: string;
  /** "your people": what "Nothing in this file would change ..." names. */
  yours: string;
  /** The group of built-in columns in each column's select. */
  group: string;
  lede: string;
  descriptions: { start: string; map: string; check: string; done: string };
  /** Where Cancel goes, and the done step's first button. */
  back: (asLeads: boolean) => { href: string; label: string };
}

export const IMPORT_TEXT: Record<ImportModuleKey, ImportText> = {
  people: {
    heading: "Import people",
    one: "person",
    yours: "your people",
    group: "Contact details",
    lede: "Bring in people from a spreadsheet saved as a CSV file. You match the columns and check the result before anything is saved.",
    descriptions: {
      start: "Bring people in from a spreadsheet: choose a CSV file or paste its rows, then match the columns.",
      map: "Match each column of the file to a contact detail, a field or the notes, or leave it out.",
      check: "What the import would do: new people, details filled in, lines skipped and possible duplicates.",
      done: "The import's counts: new people, details filled in, lines skipped. Undo takes it all back.",
    },
    back: (asLeads) => (asLeads ? { href: "/leads", label: "See your leads" } : { href: "/contacts", label: "See your contacts" }),
  },
  deals: {
    heading: "Import deals",
    one: "deal",
    yours: "your deals",
    group: "Deal details",
    lede:
      "Bring in deals from a spreadsheet saved as a CSV file. Each deal goes to a person on file, found by contact id, email, or " +
      "name and business, or adds them. You match the columns and check the result before anything is saved.",
    descriptions: {
      start: "Bring deals in from a spreadsheet: choose a CSV file or paste its rows, then match the columns.",
      map: "Match each column of the file to a deal detail or a field, or leave it out.",
      check: "What the import would do: new deals and people, details filled in, closed deals and lines skipped.",
      done: "The import's counts: new deals and people, details filled in, lines skipped. Undo takes it all back.",
    },
    back: () => ({ href: "/pipeline", label: "See your pipeline" }),
  },
  tasks: {
    heading: "Import tasks",
    one: "task",
    yours: "your tasks",
    group: "Task details",
    lede:
      "Bring in tasks from a spreadsheet saved as a CSV file. Each task goes on a deal or a person already on file. You match " +
      "the columns and check the result before anything is saved.",
    descriptions: {
      start: "Bring tasks in from a spreadsheet: choose a CSV file or paste its rows, then match the columns.",
      map: "Match each column of the file to a task detail, or leave it out.",
      check: "What the import would do: new tasks, details filled in and lines skipped.",
      done: "The import's counts: new tasks, details filled in, lines skipped. Undo takes it all back.",
    },
    back: () => ({ href: "/", label: "See Today" }),
  },
};

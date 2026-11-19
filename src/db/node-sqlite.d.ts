// The subset of node:sqlite that the test-only D1 shim (sqlite-d1.ts) uses. @types/node 20 has no node:sqlite types;
// delete this file when @types/node is 22.13 or later, which declares the module itself.
declare module "node:sqlite" {
  type SQLInputValue = null | number | bigint | string | Uint8Array;
  type SQLOutputValue = null | number | bigint | string | Uint8Array;

  interface StatementColumn {
    name: string;
  }

  class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    columns(): StatementColumn[];
  }

  class DatabaseSync {
    constructor(path: string, options?: { enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

// TEST-ONLY: a Db whose first batch runs `rival` just before it, so a test can make another writer win the race
// between a service's reads and its write.
import type { Db } from "../../src/db/db.ts";

export function racing(db: Db, rival: () => Promise<unknown>): Db {
  let pending = true;
  return {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      if (pending) {
        pending = false;
        await rival();
      }
      return db.batch(statements);
    },
  };
}

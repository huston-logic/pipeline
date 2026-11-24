// TEST-ONLY: a Db that counts its D1 calls the way the free plan's 50-per-request limit counts them (docs/PAID-PLAN.md,
// "Run 6: proposals and D1 calls"): each first/all/run/raw on a prepared statement is one call, and each batch() is
// one call however many statements it holds. `log` keeps each call's SQL (a batch as "batch(n)") for a failing test.
import type { Db } from "../../src/db/db.ts";

export type CountingDb = Db & { readonly calls: number; readonly log: readonly string[]; reset(): void };

const RUNS = new Set(["first", "all", "run", "raw"]);

export function countingDb(db: Db): CountingDb {
  let calls = 0;
  const log: string[] = [];
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (typeof prop === "string" && RUNS.has(prop)) {
          return (...args: unknown[]) => {
            calls++;
            log.push(sql);
            return (target[prop as "all"] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  return {
    get calls() {
      return calls;
    },
    get log() {
      return log;
    },
    reset() {
      calls = 0;
      log.length = 0;
    },
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => {
      calls++;
      log.push(`batch(${statements.length})`);
      return db.batch<T>(statements.map((statement) => real.get(statement) ?? statement));
    },
  };
}

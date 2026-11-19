import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteD1 } from "../db/sqlite-d1.ts";
import { MAX_STATEMENT_BYTES, renderScript, renderStatement, sqlLiteral } from "./sql.ts";

test("literals: strings with quotes doubled, NULL, integers and reals", () => {
  assert.equal(sqlLiteral("Pat"), "'Pat'");
  assert.equal(sqlLiteral("O'Brien ''x''"), "'O''Brien ''''x'''''");
  assert.equal(sqlLiteral(""), "''");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral(-7), "-7");
  assert.equal(sqlLiteral(1.25), "1.25");
  assert.equal(sqlLiteral(-0), "0");
});

test("literals refuse every other type and values SQL text can't carry exactly", () => {
  for (const bad of [undefined, true, 1n, {}, [], NaN, Infinity, 2 ** 60, "nul\u0000byte"]) {
    assert.throws(() => sqlLiteral(bad), /can't be written|NUL/, String(bad));
  }
});

test("renders each ? in order, leaving ? inside quoted text alone, and refuses a count mismatch", () => {
  assert.equal(
    renderStatement({ sql: "INSERT INTO t (a, b) VALUES (?, ?)", params: ["x", null] }),
    "INSERT INTO t (a, b) VALUES ('x', NULL);",
  );
  assert.equal(renderStatement({ sql: "SELECT '?', \"?\" , ?", params: [1] }), "SELECT '?', \"?\" , 1;");
  assert.equal(renderStatement({ sql: "DELETE FROM write_guard", params: [] }), "DELETE FROM write_guard;");
  assert.throws(() => renderStatement({ sql: "SELECT ?, ?", params: [1] }), /2 placeholders but 1 value/);
  assert.throws(() => renderStatement({ sql: "SELECT ?", params: [1, 2] }), /1 placeholder but 2 values/);
});

test("rendered SQL stores exactly the bound values: quotes, newlines, emoji, comment and statement marks", async () => {
  const values = [
    "it's \"quoted\"",
    "line one\nline two\r\nthree\rfour",
    "Casey 🌱 Placeholder 👩🏽‍💻 naïve café",
    "-- not a comment; DROP TABLE t; /* nor this */",
    "BEGIN; END; ?",
    "﻿starts with a BOM",
    "x".repeat(10_000),
  ];
  const db = new SqliteD1();
  db.exec("CREATE TABLE t (n INTEGER, v TEXT, r REAL) STRICT");
  db.exec(
    renderScript(values.map((v, i) => ({ sql: "INSERT INTO t (n, v, r) VALUES (?, ?, ?)", params: [i, v, i + 0.5] }))),
  );
  const rows = (await db.prepare("SELECT n, v, r FROM t ORDER BY n").all<{ n: number; v: string; r: number }>()).results;
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    values.map((v, i) => ({ n: i, v, r: i + 0.5 })),
  );
});

test("a statement over D1's 100 KB limit is refused with a plain way out", () => {
  assert.equal(MAX_STATEMENT_BYTES, 100_000);
  const big = { sql: "SELECT ?", params: ["é".repeat(50_000)] };
  assert.throws(() => renderScript([big]), /too large.*Split the CSV/s);
  assert.doesNotThrow(() => renderScript([{ sql: "SELECT ?", params: ["e".repeat(90_000)] }]));
});

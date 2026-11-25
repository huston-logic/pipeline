import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContactRow } from "../db/db.ts";
import { firstNameOf } from "./first-name.ts";

function contact(name: string, untrusted: string[] = []): ContactRow {
  return { name, untrusted_fields: JSON.stringify(untrusted) } as ContactRow;
}

test("takes the first word, keeping its case", () => {
  assert.equal(firstNameOf(contact("  Ana Example ")), "Ana");
  assert.equal(firstNameOf(contact("jo-anne Example")), "jo-anne");
  assert.equal(firstNameOf(contact("D’Arcy Example")), "D’Arcy");
  assert.equal(firstNameOf(contact("O'Neil")), "O'Neil");
  assert.equal(firstNameOf(contact("Zoë Example")), "Zoë");
});

test("a name from outside gives null", () => {
  assert.equal(firstNameOf(contact("Ana Example", ["name"])), null);
  assert.equal(firstNameOf(contact("Ana Example", ["phone"])), "Ana");
});

test("odd first words give null", () => {
  for (const name of ["", "   ", "-Ana", "Ana-", "'Ana", "A1", "<b>Ana", "Ana@example.com", "x".repeat(41)]) {
    assert.equal(firstNameOf(contact(name)), null, name);
  }
  assert.equal(firstNameOf(contact("x".repeat(40))), "x".repeat(40));
  assert.equal(firstNameOf(contact("A")), "A");
});

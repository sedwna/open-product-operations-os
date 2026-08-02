import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, stringifyCsv } from "../src/csv.js";

test("CSV serialization neutralizes spreadsheet formulas and preserves exact logical values", () => {
  const rows = [["title"], ["=WEBSERVICE(\"https://example.test\")"], ["  +1+1"], ["@SUM(A1:A2)"], ["'=literal"], ["''=also-literal"], ["ordinary"]];
  const serialized = stringifyCsv(rows);
  const lines = serialized.trimEnd().split("\n");
  assert.ok(lines[1].startsWith("\"'="));
  assert.ok(lines[2].startsWith("'  +"));
  assert.ok(lines[3].startsWith("'@"));
  assert.ok(lines[4].startsWith("''="));
  assert.ok(lines[5].startsWith("'''="));
  assert.deepEqual(parseCsv(serialized), rows);
});

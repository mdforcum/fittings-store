import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSE_READ_SCHEMA } from "../lib/hose-read.ts";
import { strictSchema } from "../lib/strict-schema.ts";

test("strict schemas close every object, nested ones too", () => {
  const s = strictSchema(HOSE_READ_SCHEMA) as {
    additionalProperties: boolean;
    properties: { ends: { items: { additionalProperties: boolean } } };
  };
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.ends.items.additionalProperties, false);
  assert.equal((HOSE_READ_SCHEMA as Record<string, unknown>).additionalProperties, undefined); // the original is untouched
});

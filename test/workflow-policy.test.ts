import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = ".github/workflows";
const files = readdirSync(dir).filter((file) => file.endsWith(".yml"));

for (const file of files) {
  const text = readFileSync(`${dir}/${file}`, "utf8");
  test(`${file} sets a top-level permissions block`, () => {
    assert.match(text, /^permissions:/m);
  });
  test(`${file} does not persist checkout credentials`, () => {
    const checkouts = text.match(/uses: actions\/checkout@/g) ?? [];
    const safe = text.match(/persist-credentials: false/g) ?? [];
    assert.equal(safe.length, checkouts.length);
  });
}

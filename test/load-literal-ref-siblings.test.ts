import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec } from "../src/load.js";

for (const keyword of ["const", "default", "example"]) {
  test(`external reference ${keyword} siblings retain ref keys after merging`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "literal-ref-sibling-"));
    try {
      const path = join(dir, "spec.json");
      await writeFile(
        join(dir, "schema.json"),
        JSON.stringify({
          type: "object",
          [keyword]: { $ref: "./missing-target.json", target: true },
        }),
      );
      await writeFile(
        path,
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Literal sibling", version: "1" },
          paths: {},
          components: {
            schemas: {
              Payload: {
                $ref: "./schema.json",
                [keyword]: { $ref: "./missing-sibling.json", sibling: true },
              },
            },
          },
        }),
      );
      const doc = await loadSpec(path);
      const result = doc.components!.schemas!.Payload as any;
      assert.equal(result[keyword].$ref, "./missing-sibling.json");
      assert.equal(result[keyword].sibling, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("loading a wide literal payload does not overflow the restoration walker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "literal-ref-wide-"));
  try {
    const path = join(dir, "spec.json");
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 140_000; i++) payload[`key${i}`] = i;
    await writeFile(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Wide payload", version: "1" },
        paths: {},
        components: {
          schemas: { Payload: { type: "object", default: payload } },
        },
      }),
    );
    const doc = await loadSpec(path);
    assert.deepEqual(
      (doc.components!.schemas!.Payload as any).default,
      payload,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

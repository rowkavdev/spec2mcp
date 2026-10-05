import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const media of ['application/problem+json', 'application/vnd.example+json']) {
  for (const minProperties of [0, 1]) {
    test(`${media} preserves required object-body behavior with minProperties ${minProperties}`, async () => {
      const body = { required: true, content: { [media]: { schema: {
        type: 'object', minProperties, properties: { note: { type: 'string' } },
      } } } };
      const doc = { openapi: '3.0.3', info: { title: 'JSON bodies', version: '1' }, components: { schemas: {} },
        paths: { '/x': { post: { operationId: 'x', requestBody: body, responses: { '204': { description: 'OK' } } } } },
      } as unknown as OpenAPIV3.Document;
      await init(doc);
      const tool = buildManifest(doc).tools[0]!;
      assert.equal(tool.contentType, media);
      if (minProperties === 0) {
        assert.equal(tool.requiredEmptyObject, true, 'required body has an empty-object wire path');
      } else {
        assert.deepEqual(tool.inputSchema.required, ['body']);
        const whole = tool.args.find(arg => arg.name === 'body')!;
        assert.deepEqual(whole.apiFieldPath, []);
        assert.equal(whole.schema.minProperties, 1);
      }
    });
  }
}

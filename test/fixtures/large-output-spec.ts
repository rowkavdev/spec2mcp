import type { OpenAPIV3 } from 'openapi-types';

/** Small source document with a large expanded response tree. */
export function largeOutputSpec(operationCount = 612): OpenAPIV3.Document {
  const schemas: Record<string, OpenAPIV3.SchemaObject> = {
    Leaf: { type: 'object', properties: { value: { type: 'string' } } },
  };
  for (let level = 1; level <= 6; level++) {
    schemas[`Level${level}`] = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) =>
        [`branch${i}`, { $ref: `#/components/schemas/${level === 1 ? 'Leaf' : `Level${level - 1}`}` }])),
    };
  }
  const paths: OpenAPIV3.PathsObject = {};
  for (let i = 0; i < operationCount; i++) {
    paths[`/items/${i}`] = {
      get: { operationId: `getItem${i}`, responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Level6' } } } },
      } },
    };
  }
  return {
    openapi: '3.0.3', info: { title: 'Shared graph', version: '1' }, paths,
    components: { schemas },
  };
}

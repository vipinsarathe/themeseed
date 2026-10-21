/**
 * Runtime validation against the vendored Magento contract schemas.
 *
 * Same mechanics as `nic-demo/schema.ts`: the JSON files are imported rather
 * than read from disk so they travel inside `dist/` and inside the single-file
 * esbuild bundle of the Claude Code plugin without any path arithmetic.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import contentSchema from './schema/magento-content-1.schema.json' with { type: 'json' };
import requestSchema from './schema/magento-content-request-1.schema.json' with { type: 'json' };

// ajv ships CommonJS; under NodeNext the constructor sits on `.default`.
type AjvCtor = new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ctor = ((Ajv2020 as unknown as { default?: AjvCtor }).default ??
  (Ajv2020 as unknown as AjvCtor)) as AjvCtor;

let requestValidator: ValidateFunction | undefined;
let contentValidator: ValidateFunction | undefined;

function compile(schema: unknown): ValidateFunction {
  return new Ctor({ allErrors: true, strict: false }).compile(schema);
}

/** Returns one readable line per violation; empty when the document is valid. */
export function validateMagentoRequestSchema(doc: unknown): string[] {
  requestValidator ??= compile(requestSchema);
  return requestValidator(doc) ? [] : formatErrors(requestValidator.errors);
}

export function validateMagentoContentSchema(doc: unknown): string[] {
  contentValidator ??= compile(contentSchema);
  return contentValidator(doc) ? [] : formatErrors(contentValidator.errors);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  const lines = (errors ?? []).map((error) => {
    const where = error.instancePath || '(root)';
    const extra =
      error.keyword === 'additionalProperties'
        ? ` "${String((error.params as { additionalProperty?: string }).additionalProperty)}"`
        : '';
    return `${where}: ${error.message ?? 'invalid'}${extra}`;
  });
  // allOf + $ref produce the same message under several instance paths.
  return [...new Set(lines)];
}

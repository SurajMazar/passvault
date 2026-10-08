import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { E } from './errors';

/** Run a (strict) zod schema from @passvault/validation; issues -> 400 validation_failed. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw E.validation(
      r.error.issues.map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        // zod messages never include the offending value
        message: i.code === 'unrecognized_keys' ? `Unrecognized key(s): ${(i as { keys?: string[] }).keys?.join(', ')}` : i.message,
      })),
    );
  }
  return r.data;
}

export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.output<S> {
    return parseOrThrow(this.schema, value);
  }
}

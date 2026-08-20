/**
 * @file A total, non-throwing pass-through `SchemaLike`. `schema` is required on
 *   every structured prompt, so a test that cares about something else - the
 *   parse/repair/normalize pipeline, the model stamp on the result - still has
 *   to supply one. This is that schema, in one place instead of per file.
 */

import type { SchemaLike } from '../../src/types.mts'

export const identitySchema: SchemaLike<unknown> = {
  parse(value: unknown): unknown {
    return value
  },
}

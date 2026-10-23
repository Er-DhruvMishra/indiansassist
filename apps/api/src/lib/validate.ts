/** zod parsing that answers `400 validation_failed` with `details.issues` (section 6.2). */
import type { z } from 'zod';
import { HttpError } from '../errors.js';

export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const res = schema.safeParse(value ?? {});
  if (!res.success) {
    const first = res.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    throw new HttpError('validation_failed', `${where}${first?.message ?? 'invalid request'}`, {
      issues: res.error.issues,
    });
  }
  return res.data;
}

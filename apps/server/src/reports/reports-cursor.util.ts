import { Types } from 'mongoose';

import { InvalidReportCursorError } from './reports.errors';

// Seek pagination over the `{accountId, createdAt: -1, _id: -1}` index (see that index's own
// comment in `schemas/report.schema.ts`): a `(createdAt, _id)` pair is enough to resume the
// scan exactly where the previous page left off, because that pair is (a) exactly what the
// index is sorted by and (b) unique — two reports never share both fields, even when they
// share `createdAt` to the millisecond (the attacker/defender report pair from one arrival
// always differ in `_id`). This is the standard, robust cursor shape for a descending
// timestamp index; an offset-based cursor (`skip: N`) was rejected because it re-scans and
// re-sorts everything before the offset on every page and silently reorders results if a new
// report is written between two page reads — a real risk here, since reports arrive
// continuously while a player might be paging through old ones.
export interface ReportCursor {
  createdAt: number;
  id: string;
}

export function encodeReportCursor(cursor: ReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

// Opaque to the client by design — it's a base64url-encoded JSON blob, not a field the client
// is meant to construct or read into meaning; a client that mangles it gets a stable 400
// rather than a confusing empty/wrong page.
export function decodeReportCursor(raw: string): ReportCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidReportCursorError(raw);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('createdAt' in parsed) ||
    !('id' in parsed) ||
    typeof (parsed as { createdAt: unknown }).createdAt !== 'number' ||
    typeof (parsed as { id: unknown }).id !== 'string' ||
    !Types.ObjectId.isValid((parsed as { id: string }).id)
  ) {
    throw new InvalidReportCursorError(raw);
  }

  return parsed as ReportCursor;
}

import { HttpException, HttpStatus } from '@nestjs/common';

// Same wire shape as `settlements.errors.ts`'s `ErrorResponseBody`/`errorBody` (§15: the
// server returns i18n keys + params, never prose) — duplicated rather than imported
// cross-module, mirroring how `movements.errors.ts` duplicates it rather than reusing
// `settlements`' copy.
export interface ErrorResponseBody {
  error: {
    key: string;
    params: Record<string, unknown>;
  };
}

function errorBody(key: string, params: Record<string, unknown> = {}): ErrorResponseBody {
  return { error: { key, params } };
}

// A report id that doesn't exist, or belongs to another account — indistinguishable by
// design, same "don't leak existence" convention as `SettlementNotFoundError`/
// `MovementNotFoundError` (see `SettlementsService.settleSettlementDoc`'s own comment):
// reports are strictly per-account, so a foreign id must 404, never 403.
export class ReportNotFoundError extends HttpException {
  constructor(reportId: string) {
    super(errorBody('errors.report.notFound', { reportId }), HttpStatus.NOT_FOUND);
  }
}

// A `cursor` query param that doesn't decode to the `{createdAt, id}` shape
// `ReportsService.listMine` writes into `nextCursor` — either genuinely malformed input, or a
// cursor minted for a different account (cursors are opaque and unsigned, so this is a
// courtesy 400 for "your own client sent something broken," not a security boundary; the
// `accountId` filter is what actually scopes every query, cursor or not).
export class InvalidReportCursorError extends HttpException {
  constructor(cursor: string) {
    super(errorBody('errors.report.invalidCursor', { cursor }), HttpStatus.BAD_REQUEST);
  }
}

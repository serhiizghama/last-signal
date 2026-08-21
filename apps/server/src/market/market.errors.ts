import { HttpException, HttpStatus } from '@nestjs/common';

// Same wire shape as `settlements.errors.ts`'s/`movements.errors.ts`'s `ErrorResponseBody`/
// `errorBody` (§15: the server returns i18n keys + params, never prose) — duplicated rather
// than imported cross-module, mirroring how `MovementCommandError` mirrors
// `BuildCommandError` rather than the two sharing a base class.
export interface ErrorResponseBody {
  error: {
    key: string;
    params: Record<string, unknown>;
  };
}

function errorBody(key: string, params: Record<string, unknown> = {}): ErrorResponseBody {
  return { error: { key, params } };
}

// An offer id that doesn't exist, or belongs to another account — indistinguishable by
// design, same "don't leak existence" convention as `MovementNotFoundError`/
// `SettlementNotFoundError`.
export class TradeOfferNotFoundError extends HttpException {
  constructor(offerId: string) {
    super(errorBody('errors.market.offerNotFound', { offerId }), HttpStatus.NOT_FOUND);
  }
}

// Every rejected `createOffer`/`cancelOffer` command (no Market, no faction, unknown/
// identical resource, invalid amount, ratio out of range, insufficient resources, the offer
// isn't `open`) — one class, key + params + status supplied at the call site, mirroring
// `MovementCommandError`/`TrainCommandError`.
export class MarketCommandError extends HttpException {
  constructor(
    key: string,
    params: Record<string, unknown> = {},
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(errorBody(key, params), status);
  }
}

// Thrown internally when a version-guarded `findOneAndUpdate` matches no document (the
// expected `version` is stale) — a plain `Error`, not an `HttpException`, caught by
// `MarketService.runCommand` to decide whether to retry the whole command. Mirrors
// `movements.errors.ts`'s identically-named class exactly; kept as its own local class (not
// imported cross-module) for the same reason that one is its own class rather than reusing
// `settlements.errors.ts`'s.
export class VersionConflictError extends Error {
  constructor() {
    super(
      'VersionConflictError: trade offer or settlement version changed underneath this command',
    );
  }
}

// Surfaced once `MarketService.runCommand`'s bounded retry (concurrency playbook) is
// exhausted. Reuses the exact same shared i18n key as `settlements`'/`movements`' own
// `CommandConflictRetryExhaustedError` classes — a generic, shared-meaning outcome ("the
// server is under heavy contention, retry"), not market-specific wording, so this feature's
// own TS class intentionally points at the same key rather than minting its own.
export class CommandConflictRetryExhaustedError extends HttpException {
  constructor() {
    super(errorBody('errors.command.conflictRetryExhausted'), HttpStatus.CONFLICT);
  }
}

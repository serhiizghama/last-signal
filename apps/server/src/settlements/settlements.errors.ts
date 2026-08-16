import { HttpException, HttpStatus } from '@nestjs/common';

// The server returns i18n keys + params, never prose (§15) — every error thrown by this
// feature carries a stable key plus params in this exact shape, so the client can look the
// key up in its own i18n bundle regardless of HTTP status code.
export interface ErrorResponseBody {
  error: {
    key: string;
    params: Record<string, unknown>;
  };
}

function errorBody(key: string, params: Record<string, unknown> = {}): ErrorResponseBody {
  return { error: { key, params } };
}

// A settlement id that doesn't exist (or isn't even a well-formed id).
export class SettlementNotFoundError extends HttpException {
  constructor(settlementId: string) {
    super(errorBody('errors.settlement.notFound', { settlementId }), HttpStatus.NOT_FOUND);
  }
}

// Every rejected build command (bad type, prerequisites, queue full, affordability, the
// Food gate, an unknown queue item) — one class, key + params + status supplied at the
// call site so each validation failure in `SettlementsService` stays a one-liner.
export class BuildCommandError extends HttpException {
  constructor(
    key: string,
    params: Record<string, unknown> = {},
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(errorBody(key, params), status);
  }
}

// Thrown internally by the version-guard helpers when a `findOneAndUpdate` matches no
// document (the expected `version` is stale) — a plain `Error`, not an `HttpException`,
// because `SettlementsService`'s command runner catches it to decide whether to retry the
// whole command before ever turning it into an HTTP response.
export class VersionConflictError extends Error {
  constructor() {
    super('VersionConflictError: settlement version changed underneath this command');
  }
}

// Surfaced only once the bounded retry loop in the concurrency playbook (§11) is
// exhausted — a real, if rare, client-visible outcome under heavy contention, so it gets
// its own key rather than reusing a generic 500.
export class CommandConflictRetryExhaustedError extends HttpException {
  constructor() {
    super(errorBody('errors.command.conflictRetryExhausted'), HttpStatus.CONFLICT);
  }
}

// The account already owns as many settlements as its current Influence allows (§7: hard
// cap 3 in v1, gated by `settlementsAllowed` — 1 with zero Influence, i.e. every account's
// first settlement). The Influence-gated multi-settlement founding flow itself is M2; M1b
// only ever hits this on a *second* creation attempt.
export class SettlementLimitReachedError extends HttpException {
  constructor() {
    super(errorBody('errors.settlement.limitReached'), HttpStatus.CONFLICT);
  }
}

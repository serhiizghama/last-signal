import { HttpException, HttpStatus } from '@nestjs/common';

// Same wire shape as `settlements.errors.ts`'s `ErrorResponseBody`/`errorBody` (§15: the
// server returns i18n keys + params, never prose) — duplicated rather than imported
// cross-module, mirroring how `TrainCommandError` mirrors `BuildCommandError` in that same
// file rather than the two sharing a base class.
export interface ErrorResponseBody {
  error: {
    key: string;
    params: Record<string, unknown>;
  };
}

function errorBody(key: string, params: Record<string, unknown> = {}): ErrorResponseBody {
  return { error: { key, params } };
}

// A movement id that doesn't exist, or belongs to another account — indistinguishable by
// design, same "don't leak existence" convention as `SettlementNotFoundError`.
export class MovementNotFoundError extends HttpException {
  constructor(movementId: string) {
    super(errorBody('errors.movement.notFound', { movementId }), HttpStatus.NOT_FOUND);
  }
}

// Every rejected `sendScouts`/`cancelMovement` command (unknown type, bad target, non-scout
// unit, insufficient troops, empty unit list, wrong status, expired cancel window) — one
// class, key + params + status supplied at the call site, mirroring `BuildCommandError`/
// `TrainCommandError`.
export class MovementCommandError extends HttpException {
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
// `MovementsService.runCommand` to decide whether to retry the whole command. Mirrors
// `settlements.errors.ts`'s identically-named class exactly; kept as its own local class (not
// imported cross-module) for the same reason `MovementCommandError` is its own class rather
// than reusing `BuildCommandError`.
export class VersionConflictError extends Error {
  constructor() {
    super('VersionConflictError: movement or settlement version changed underneath this command');
  }
}

// Surfaced once `MovementsService.runCommand`'s bounded retry (concurrency playbook) is
// exhausted. Reuses the exact same i18n key as `settlements`' own
// `CommandConflictRetryExhaustedError` — this is a generic, shared-meaning outcome ("the
// server is under heavy contention, retry"), not settlement-specific wording, so the two
// features' distinct TS classes intentionally point at one shared key rather than each
// minting its own.
export class CommandConflictRetryExhaustedError extends HttpException {
  constructor() {
    super(errorBody('errors.command.conflictRetryExhausted'), HttpStatus.CONFLICT);
  }
}

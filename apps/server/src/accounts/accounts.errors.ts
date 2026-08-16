import { HttpException, HttpStatus } from '@nestjs/common';

function errorBody(
  key: string,
  params: Record<string, unknown> = {},
): { error: { key: string; params: Record<string, unknown> } } {
  return { error: { key, params } };
}

// `name` failed length bounds (after trimming).
export class InvalidNameError extends HttpException {
  constructor(min: number, max: number) {
    super(errorBody('errors.account.invalidName', { min, max }), HttpStatus.BAD_REQUEST);
  }
}

// `name` collided with an existing account's name (the unique index is the ultimate
// authority — see `AccountsService.register`).
export class NameTakenError extends HttpException {
  constructor(name: string) {
    super(errorBody('errors.account.nameTaken', { name }), HttpStatus.CONFLICT);
  }
}

// `faction` was not one of the three valid values.
export class InvalidFactionError extends HttpException {
  constructor(faction: string) {
    super(errorBody('errors.account.invalidFaction', { faction }), HttpStatus.BAD_REQUEST);
  }
}

// `side` was given but was not one of the two valid values.
export class InvalidSideError extends HttpException {
  constructor(side: string) {
    super(errorBody('errors.account.invalidSide', { side }), HttpStatus.BAD_REQUEST);
  }
}

// The calling account already registered (faction is set once, at registration, in v1 —
// see the M1 design record).
export class AlreadyRegisteredError extends HttpException {
  constructor() {
    super(errorBody('errors.account.alreadyRegistered'), HttpStatus.CONFLICT);
  }
}

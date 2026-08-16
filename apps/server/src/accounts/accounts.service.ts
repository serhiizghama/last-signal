import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { NotAuthenticatedError } from '../auth/auth.errors';
import { isDuplicateKeyError } from '../database/mongo-errors.util';
import type { AccountDocument, Faction, Side } from '../schemas/account.schema';
import { Account, FACTIONS, SIDES } from '../schemas/account.schema';
import {
  AlreadyRegisteredError,
  InvalidFactionError,
  InvalidNameError,
  InvalidSideError,
  NameTakenError,
} from './accounts.errors';
import type { RegisterDto } from './dto/register.dto';

// Display-name bounds — first-pass, generous enough for anything a friends-and-family
// world would type, tight enough to keep the UI's account chrome from breaking.
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 32;

function isFaction(value: string): value is Faction {
  return (FACTIONS as readonly string[]).includes(value);
}

function isSide(value: string): value is Side {
  return (SIDES as readonly string[]).includes(value);
}

// Registration & faction choice (§13 of the M1 design record): turns an existing guest
// account into a named, factioned one. Never creates a new `Account` document — the guest
// account (and its session/cookie) already exists by the time this runs, via `AuthGuard`.
@Injectable()
export class AccountsService {
  constructor(@InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>) {}

  async register(accountId: Types.ObjectId, dto: RegisterDto): Promise<AccountDocument> {
    const account = await this.accountModel.findById(accountId);
    if (!account) {
      // Can't happen through the normal flow — `AuthGuard` already resolved this account
      // from a live session immediately before this runs. Defensive only.
      throw new NotAuthenticatedError();
    }

    // Faction is chosen once, at registration, in v1 — no switching endpoint (§13). Its
    // presence is what "already registered" means; `isGuest` flips in the same write below,
    // so checking `faction` alone is the single source of truth rather than two fields that
    // could theoretically disagree.
    if (account.faction) {
      throw new AlreadyRegisteredError();
    }

    const name = dto.name.trim();
    if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
      throw new InvalidNameError(MIN_NAME_LENGTH, MAX_NAME_LENGTH);
    }
    if (!isFaction(dto.faction)) {
      throw new InvalidFactionError(dto.faction);
    }
    if (dto.side !== undefined && !isSide(dto.side)) {
      throw new InvalidSideError(dto.side);
    }

    account.name = name;
    account.faction = dto.faction;
    account.isGuest = false;
    if (dto.side !== undefined) {
      account.side = dto.side;
    }

    try {
      await account.save();
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new NameTakenError(name);
      }
      throw error;
    }
    return account;
  }
}

import { randomUUID } from 'node:crypto';

import type { GameConfig } from '@last-signal/game-core';
import { generateOases } from '@last-signal/game-core';
import type { OnModuleInit } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';

import { isDuplicateKeyError } from '../database/mongo-errors.util';
import { GAME_CONFIG } from '../game-config/game-config.tokens';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { OasisDocument } from '../schemas/oasis.schema';
import { OASIS_TYPE_FARM, Oasis } from '../schemas/oasis.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World } from '../schemas/world.schema';
import { INITIAL_ACT, INITIAL_ROUND_NUMBER, WORLD_SINGLETON_KEY } from './world.constants';

// World bootstrap + the `oases` collection (M2a.3, `docs/M2_DESIGN_DECISIONS.md` §2, §12):
// generates and stores the world seed, and places the farm oases derived from it in one
// transaction. Terrain itself is never stored — `terrainAt` in `game-core` derives it from
// the seed on every read, both server- and client-side. The Signal Source stays unplaced
// (`world.source` all defaults, i.e. `holderSide: null`) until M5's Act 2 reveal.
@Injectable()
export class WorldService implements OnModuleInit {
  constructor(
    @InjectModel(World.name) private readonly worldModel: Model<WorldDocument>,
    @InjectModel(Oasis.name) private readonly oasisModel: Model<OasisDocument>,
    // Used only by `regenerate`, to delete the NPC accounts/settlements it previously
    // created — see that method's own comment. Every other method here is unaware of
    // `Account`/`Settlement` entirely; this is deliberately the one place that reaches into
    // those collections from the `world` module.
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
  ) {}

  // Self-heals a fresh dev/prod boot: an empty DB gets bootstrapped into a world; an
  // already-bootstrapped one is left untouched.
  async onModuleInit(): Promise<void> {
    await this.bootstrap(Date.now());
  }

  // Idempotent, race-safe world bootstrap: a no-op (returns the existing document) if a
  // world already exists; otherwise generates a fresh seed and creates the world + its
  // oases together. Safe under two concurrent calls racing from an empty DB — see
  // `createWorld`'s comment for how.
  async bootstrap(now: number): Promise<WorldDocument> {
    const existing = await this.worldModel.findOne({ key: WORLD_SINGLETON_KEY });
    if (existing) {
      return existing;
    }
    return this.createWorld(randomUUID(), now);
  }

  // The singleton. Throws if `bootstrap` has never run — every real boot path
  // (`onModuleInit`) guarantees it has, so a caller hitting this is a programming error
  // (a module wired without ever booting `WorldModule`), not a client-facing condition, and
  // is deliberately a plain `Error` rather than an `HttpException` for that reason.
  async getWorld(): Promise<WorldDocument> {
    const world = await this.worldModel.findOne({ key: WORLD_SINGLETON_KEY });
    if (!world) {
      throw new Error(
        'WorldService.getWorld: no world document exists — bootstrap() must run before this is called',
      );
    }
    return world;
  }

  // Every oasis document (24 at the draft config — no pagination needed at this scale, §12).
  async listOases(): Promise<OasisDocument[]> {
    return this.oasisModel.find({});
  }

  // Dev-only: deletes the world document and every oasis, then bootstraps again with `seed`
  // (or a fresh random one). Also deletes every NPC account/settlement `NpcSeederService`
  // previously created (M2a.5, §4) — their coordinates were chosen against the seed being
  // discarded, so leaving them behind would show a client a terrain/oasis layout that no
  // longer matches how they were placed; the next boot's `NpcSeederService` reseeds a fresh
  // population against the new seed (`npcsSeededAt` resets to `null` simply because
  // `createWorld` below inserts a brand-new document — see that field's own comment). This
  // endpoint itself does not re-trigger seeding synchronously.
  // Human accounts/settlements are deliberately left untouched even though the same
  // staleness argument technically applies to them too: their stored `{x, y}` stays a valid
  // grid coordinate, and wiping a real player's progress as a side effect of a dev-only
  // terrain regen would be far worse than a cosmetic mismatch. `isNpc` is the exact, narrow
  // filter that makes this distinction — never true for a human account. Never call this
  // endpoint against a world with real players in it regardless.
  async regenerate(seed: string | undefined, now: number): Promise<WorldDocument> {
    const npcAccountIds = (await this.accountModel.find({ isNpc: true }, '_id')).map(
      (account) => account._id,
    );
    if (npcAccountIds.length > 0) {
      await this.settlementModel.deleteMany({ accountId: { $in: npcAccountIds } });
      await this.accountModel.deleteMany({ _id: { $in: npcAccountIds } });
    }
    await this.worldModel.deleteMany({ key: WORLD_SINGLETON_KEY });
    await this.oasisModel.deleteMany({});
    return this.createWorld(seed ?? randomUUID(), now);
  }

  // Creates the world document and its oases in one transaction, so the two never disagree
  // (a crash between them would otherwise leave a world with no oases, or oases with no
  // world). Race-safety: if two calls both observe no existing world in `bootstrap` and both
  // reach here concurrently, the unique index on `World.key` lets at most one `create`
  // succeed — the loser either hits the same duplicate-key error directly, or first gets a
  // `TransientTransactionError` from a genuine storage-engine write conflict (which the
  // MongoDB driver's own `session.withTransaction` retries transparently) and hits the
  // duplicate-key error on that retry once the winner has committed. Either way the error is
  // caught below and treated as "someone else already bootstrapped": read back and return
  // the winner's document instead of throwing.
  private async createWorld(seed: string, now: number): Promise<WorldDocument> {
    const session = await this.connection.startSession();
    try {
      let result: WorldDocument | undefined;
      await session.withTransaction(async () => {
        const [world] = await this.worldModel.create(
          [
            {
              key: WORLD_SINGLETON_KEY,
              seed,
              roundNumber: INITIAL_ROUND_NUMBER,
              act: INITIAL_ACT,
              startedAt: now,
            },
          ],
          { session },
        );
        if (!world) {
          throw new Error('WorldService: world creation returned no document');
        }

        const oases = generateOases(this.config, seed);
        if (oases.length > 0) {
          await this.oasisModel.insertMany(
            oases.map((tile) => ({ x: tile.x, y: tile.y, type: OASIS_TYPE_FARM })),
            { session, ordered: true },
          );
        }

        result = world;
      });
      return result as WorldDocument;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const winner = await this.worldModel.findOne({ key: WORLD_SINGLETON_KEY });
      if (!winner) {
        // Unreachable in practice: a duplicate-key error on `key` means some transaction's
        // insert of that same fixed value has already committed.
        throw error;
      }
      return winner;
    } finally {
      await session.endSession();
    }
  }
}

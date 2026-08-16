import type { GameConfig, Tile } from '@last-signal/game-core';
import type { OnModuleInit } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';

import { GAME_CONFIG } from '../game-config/game-config.tokens';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World } from '../schemas/world.schema';
import { WORLD_SINGLETON_KEY } from '../world/world.constants';
import { WorldService } from '../world/world.service';
import type { NpcSpec } from './npc-generator';
import { buildNpcSpecs } from './npc-generator';
import { DEFAULT_WORLD_NPC_COUNT, WORLD_NPC_COUNT_KEY } from './npc.constants';
import type { NpcRng } from './npc.tokens';
import { NPC_RNG } from './npc.tokens';

export interface NpcSeedResult {
  seeded: boolean;
  npcCount: number;
}

// Seeds the ~135 inert NPC accounts + settlements (M2a.5, `docs/M2_DESIGN_DECISIONS.md` §4)
// once per world, through the same placement policy humans use (§3) and the `game-core`
// catalogue for legality. No behaviour, no ticks — that's M4's job; this only ever writes.
@Injectable()
export class NpcSeederService implements OnModuleInit {
  constructor(
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(World.name) private readonly worldModel: Model<WorldDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    @Inject(WorldService) private readonly worldService: WorldService,
    @Inject(NPC_RNG) private readonly rng: NpcRng,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  // Self-heals a fresh boot exactly like `WorldService.onModuleInit` does for the world
  // itself — and, deliberately, calls `WorldService.bootstrap` again below rather than
  // assuming `WorldModule`'s own `onModuleInit` already ran first: `bootstrap` is idempotent
  // (a no-op once a world exists), so this never has to depend on Nest's cross-module
  // lifecycle-hook ordering to guarantee a world exists before seeding is attempted.
  async onModuleInit(): Promise<void> {
    await this.seedIfNeeded(Date.now());
  }

  // Idempotent, race-safe NPC seeding. Returns `{ seeded: false }` without touching the
  // database at all when `WORLD_NPC_COUNT` is 0 (every existing integration spec sets this)
  // or the world's `npcsSeededAt` marker is already set (the common case on every boot after
  // the first) — the expensive part (`buildNpcSpecs`, §4) only ever runs when there is a real
  // chance this call will actually seed.
  async seedIfNeeded(now: number): Promise<NpcSeedResult> {
    const desiredCount = this.readDesiredCount();
    if (desiredCount <= 0) {
      return { seeded: false, npcCount: 0 };
    }

    const world = await this.worldService.bootstrap(now);
    if (world.npcsSeededAt !== null) {
      return { seeded: false, npcCount: 0 };
    }

    // Everything below is computed in memory before any write — see `npc-generator.ts`'s
    // own comment on why (no per-NPC DB round trip). The reads happen outside the
    // transaction below on purpose: they only ever need to be a reasonably fresh snapshot
    // (the atomic claim inside the transaction is what actually makes this safe under
    // concurrency, exactly like `PlacementService.findTile` + the settlement `{x,y}` unique
    // index does for a single human placement — see that pattern's own comment for why a
    // TOCTOU window here is acceptable: at boot time, before the HTTP server is listening,
    // nothing else can be writing settlements or accounts concurrently anyway).
    const [oasisDocs, existingSettlementDocs, existingAccountDocs] = await Promise.all([
      this.worldService.listOases(),
      this.settlementModel.find({}, 'x y'),
      this.accountModel.find({}, 'name'),
    ]);
    const oasisTiles = new Set(oasisDocs.map((oasis) => `${oasis.x},${oasis.y}`));
    // Starts from whatever settlements already exist (there may be none, but this never
    // assumes that — see the brief's own instruction) so the annulus radius `pickSpawnTile`
    // draws against, and the minimum-distance check, both account for them from NPC #1
    // onward, not just from NPC #(existingCount + 1).
    const existingTiles: Tile[] = existingSettlementDocs.map((doc) => ({ x: doc.x, y: doc.y }));
    const usedNames = new Set(existingAccountDocs.map((doc) => doc.name));

    const specs = buildNpcSpecs(
      this.config,
      world.seed,
      desiredCount,
      oasisTiles,
      existingTiles,
      usedNames,
      this.rng,
      now,
    );

    const session = await this.connection.startSession();
    try {
      let seeded = false;
      await session.withTransaction(async () => {
        seeded = await this.claimAndInsert(now, specs, session);
      });
      return { seeded, npcCount: seeded ? specs.length : 0 };
    } finally {
      await session.endSession();
    }
  }

  // The atomic claim + bulk insert, both in the same transaction: either both commit
  // together, or neither does. Committing them together matters — if the claim alone
  // committed and the inserts then failed/aborted, the world would be permanently stuck
  // believing it had already seeded (`npcsSeededAt` set) with no NPCs to show for it. Mirrors
  // `WorldService.createWorld`'s own "conditional write is the tie-breaker" shape: only a
  // caller that actually flips `npcsSeededAt` from `null` here proceeds to insert; a second
  // boot, or a second concurrent one, finds it already set (`findOneAndUpdate` matches
  // nothing) and does nothing.
  private async claimAndInsert(
    now: number,
    specs: NpcSpec[],
    session: ClientSession,
  ): Promise<boolean> {
    const claimed = await this.worldModel.findOneAndUpdate(
      { key: WORLD_SINGLETON_KEY, npcsSeededAt: null },
      { $set: { npcsSeededAt: now } },
      { session },
    );
    if (!claimed) {
      return false;
    }
    await this.accountModel.insertMany(
      specs.map((spec) => spec.account),
      { session, ordered: true },
    );
    await this.settlementModel.insertMany(
      specs.map((spec) => spec.settlement),
      { session, ordered: true },
    );
    return true;
  }

  private readDesiredCount(): number {
    return Number(
      this.configService.get<string>(WORLD_NPC_COUNT_KEY, String(DEFAULT_WORLD_NPC_COUNT)),
    );
  }
}

import type { BuildingType } from '@last-signal/game-core';
import {
  DEFAULT_CONFIG,
  SETTLEMENT_SLOTS,
  calcNetFoodPerHour,
  calcStorageCaps,
  chebyshevDistance,
  isInGrid,
  missingPrerequisites,
  scoutUnitForFaction,
  spawnAnnulus,
  spawnRadius,
  terrainAt,
  unitsTrainableAt,
} from '@last-signal/game-core';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World } from '../schemas/world.schema';
import { toTroopCounts } from '../settlements/settlements.util';
import { WORLD_SINGLETON_KEY } from '../world/world.constants';
import { WorldService } from '../world/world.service';
import { pickNpcBand } from './npc-generator';
import { NpcSeederService } from './npc-seeder.service';
import { NPC_BARRACKS_LEVEL } from './npc.constants';

// NPC seeding (M2a.5, `docs/M2_DESIGN_DECISIONS.md` §4) against a real MongoDB replica set —
// same boot pattern as every other `AppModule` integration spec. `WORLD_NPC_COUNT` is left at
// its default (135) here, deliberately: this is the one suite that wants the real thing, since
// every other spec sets it to 0 (see each of their own comments). `app.init()` in `beforeAll`
// therefore seeds the full population as a side effect of booting, exactly like a real
// dev/prod boot — most tests below just read back what that produced.
describe('NPC seeding (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let moduleRef: TestingModule;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let worldModel: Model<WorldDocument>;
  let oasisModel: Model<OasisDocument>;
  let npcSeederService: NpcSeederService;
  let worldService: WorldService;

  let humanAccountId: string;
  let humanSettlementId: string;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-npc-seeder-test');

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // Seeds the full 135-NPC population as a side effect (`NpcSeederService.onModuleInit`),
    // exactly like a real fresh boot.
    await app.init();
    // Explicit IPv4-bound single listener — avoids ephemeral-port collisions with other
    // local processes; see `accounts.integration.spec.ts`'s beforeAll for why this matters.
    await app.listen(0, '127.0.0.1');

    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    worldModel = moduleRef.get(getModelToken(World.name));
    oasisModel = moduleRef.get(getModelToken(Oasis.name));
    npcSeederService = moduleRef.get(NpcSeederService);
    worldService = moduleRef.get(WorldService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
  }, 60_000);

  // Deletes every NPC account/settlement and clears the world's `npcsSeededAt` marker,
  // simulating "a fresh, unseeded world" without paying for a second `MongoMemoryReplSet` +
  // `AppModule` boot. Used by the performance and concurrent-race tests below, which both
  // need to observe a real (not idempotent-no-op) seeding run.
  async function resetToUnseeded(): Promise<void> {
    const npcAccountIds = (await accountModel.find({ isNpc: true }, '_id')).map((a) => a._id);
    await settlementModel.deleteMany({ accountId: { $in: npcAccountIds } });
    await accountModel.deleteMany({ isNpc: true });
    await worldModel.updateOne({ key: WORLD_SINGLETON_KEY }, { $set: { npcsSeededAt: null } });
  }

  it('booting the app seeds exactly 135 NPC accounts + settlements, every one on-grid, off-lake, off-oasis, and pairwise apart', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    expect(npcAccounts).toHaveLength(135);

    const settlements = await settlementModel.find({
      accountId: { $in: npcAccounts.map((a) => a._id) },
    });
    expect(settlements).toHaveLength(135);

    const world = await worldModel.findOne({ key: WORLD_SINGLETON_KEY });
    expect(world).not.toBeNull();
    expect(world!.npcsSeededAt).not.toBeNull();
    const oases = await oasisModel.find({});
    const oasisTiles = new Set(oases.map((o) => `${o.x},${o.y}`));

    for (const settlement of settlements) {
      const tile = { x: settlement.x, y: settlement.y };
      expect(isInGrid(DEFAULT_CONFIG, tile)).toBe(true);
      expect(terrainAt(DEFAULT_CONFIG, world!.seed, tile.x, tile.y)).not.toBe('toxicLake');
      expect(oasisTiles.has(`${tile.x},${tile.y}`)).toBe(false);
    }

    for (let i = 0; i < settlements.length; i += 1) {
      for (let j = i + 1; j < settlements.length; j += 1) {
        const distance = chebyshevDistance(
          { x: settlements[i]!.x, y: settlements[i]!.y },
          { x: settlements[j]!.x, y: settlements[j]!.y },
        );
        expect(distance).toBeGreaterThanOrEqual(DEFAULT_CONFIG.map.settlement.minDistance);
      }
    }
  });

  // M3c beginner protection (`docs/M3_DESIGN_DECISIONS.md` §11, §19.2): `NpcSeederService`
  // writes settlements via `insertMany`, bypassing `SettlementsService.createSettlement`
  // (and its `protectedUntil` stamping) entirely — a freshly seeded NPC account must
  // therefore carry no `protectedUntil` at all. Protecting NPCs would make the whole seeded
  // world un-raidable for 72h and break the §0 raid-income bound the extended seeder bands
  // exist to satisfy.
  it('freshly seeded NPC accounts have no protectedUntil (beginner protection does not cover NPCs)', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    expect(npcAccounts).toHaveLength(135);
    for (const account of npcAccounts) {
      expect(account.protectedUntil).toBeUndefined();
    }
  });

  it('pickNpcBand draws roughly 40/40/20 over many draws (the weighting logic itself, decoupled from persisted data)', () => {
    const counts: Record<string, number> = { young: 0, developed: 0, veteran: 0 };
    const draws = 20_000;
    for (let i = 0; i < draws; i += 1) {
      const band = pickNpcBand(() => Math.random()).band;
      counts[band] = (counts[band] ?? 0) + 1;
    }
    expect(counts['young']! / draws).toBeGreaterThan(0.35);
    expect(counts['young']! / draws).toBeLessThan(0.45);
    expect(counts['developed']! / draws).toBeGreaterThan(0.35);
    expect(counts['developed']! / draws).toBeLessThan(0.45);
    expect(counts['veteran']! / draws).toBeGreaterThan(0.15);
    expect(counts['veteran']! / draws).toBeLessThan(0.25);
  });

  // Every persisted NPC settlement is checked against the invariants its band must hold
  // (§4). Bands aren't stored (M4 can infer "young" from "no Barracks" the same way this test
  // does — nothing here needs a field that would make an NPC distinguishable from a human),
  // so this also doubles as the DB-backed half of the "roughly 40/40/20" acceptance
  // criterion: "no Barracks" is exactly the `young` band (CC 1-2 never reaches Barracks'
  // prerequisite of CC 3), so its share should be close to 40%; among the settlements that
  // do have one, the unambiguous CC sub-ranges (3-4 can only be `developed`, 6-7 can only be
  // `veteran` — CC 5 is shared by both bands' draft ranges and is excluded here) should split
  // roughly 2:1 (§4: 40 vs 20).
  it('every NPC settlement is structurally legal for its buildings/troops, and the band split matches §4', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    const accountById = new Map(npcAccounts.map((a) => [String(a._id), a]));
    const settlements = await settlementModel.find({
      accountId: { $in: npcAccounts.map((a) => a._id) },
    });

    let withoutBarracks = 0;
    let developedRangeCount = 0;
    let veteranRangeCount = 0;

    for (const settlement of settlements) {
      const buildingLevels = settlement.buildings.map((b) => ({
        type: b.type as BuildingType,
        level: b.level,
      }));

      for (const building of buildingLevels) {
        expect(missingPrerequisites(DEFAULT_CONFIG, buildingLevels, building.type)).toEqual([]);
      }

      const commandCenter = buildingLevels.find((b) => b.type === 'commandCenter');
      expect(commandCenter).toBeDefined();
      const ccLevel = commandCenter!.level;
      const barracks = buildingLevels.find((b) => b.type === 'barracks');
      const account = accountById.get(String(settlement.accountId));
      expect(account).toBeDefined();

      if (!barracks) {
        withoutBarracks += 1;
        expect(ccLevel).toBeGreaterThanOrEqual(1);
        expect(ccLevel).toBeLessThanOrEqual(2);
        expect(settlement.troops).toHaveLength(0);
        expect(buildingLevels.some((b) => b.type === 'electronicsWorkshop')).toBe(false);
        for (const b of buildingLevels) {
          if (b.type === 'commandCenter') continue;
          expect(b.level).toBeGreaterThanOrEqual(1);
          expect(b.level).toBeLessThanOrEqual(3);
        }
      } else {
        expect(ccLevel).toBeGreaterThanOrEqual(3);
        expect(ccLevel).toBeLessThanOrEqual(7);
        expect(barracks.level).toBe(NPC_BARRACKS_LEVEL);

        // Every Barracks-having band (developed, veteran) has a non-null `defenders` range
        // whose minimum is > 0 (developed [10,20], veteran [30,60] — see npc.constants.ts),
        // so a defender entry is always present here; the scout entry is optional (developed's
        // scouts range [0,3] can roll 0; veteran's [2,6] cannot). troops.length is therefore
        // 1 (defenders only) or 2 (scouts + defenders).
        expect(settlement.troops.length).toBeGreaterThanOrEqual(1);
        expect(settlement.troops.length).toBeLessThanOrEqual(2);

        const scout = scoutUnitForFaction(DEFAULT_CONFIG, account!.faction!);
        const defenseInfantry = unitsTrainableAt(
          DEFAULT_CONFIG,
          'barracks',
          account!.faction!,
        ).find((u) => u.role === 'defenseInfantry')!;
        expect(defenseInfantry).toBeDefined();

        const scoutEntry = settlement.troops.find((t) => t.unitType === scout.type);
        if (scoutEntry) {
          expect(scoutEntry.count).toBeGreaterThanOrEqual(1); // 0-count scouts are dropped
          expect(scoutEntry.count).toBeLessThanOrEqual(6);
        }

        const defenderEntry = settlement.troops.find((t) => t.unitType === defenseInfantry.type);
        expect(defenderEntry).toBeDefined();
        expect(defenderEntry!.count).toBeGreaterThanOrEqual(10);
        expect(defenderEntry!.count).toBeLessThanOrEqual(60);

        // No stray troop entries: every entry here is either the scout or the defender.
        expect(settlement.troops.length).toBe((scoutEntry ? 1 : 0) + 1);

        // The Hidden Cache: always present for a Barracks-having band (same non-null-range
        // reasoning as defenders above), and legal per `missingPrerequisites` (already
        // asserted for every building above, including this one).
        const hiddenCache = buildingLevels.find((b) => b.type === 'hiddenCache');
        expect(hiddenCache).toBeDefined();
        expect(hiddenCache!.level).toBeGreaterThanOrEqual(2);
        expect(hiddenCache!.level).toBeLessThanOrEqual(6);

        // developed's Hidden Cache range [2,3] and veteran's [4,6] don't overlap — unlike CC
        // level 5, the cache level unambiguously identifies the band, so it cross-checks the
        // defender count against the *right* band's range rather than the shared union.
        if (hiddenCache!.level <= 3) {
          expect(defenderEntry!.count).toBeLessThanOrEqual(20); // developed's defenders cap
        } else {
          expect(defenderEntry!.count).toBeGreaterThanOrEqual(30); // veteran's defenders floor
        }

        if (ccLevel <= 4) developedRangeCount += 1;
        if (ccLevel >= 6) veteranRangeCount += 1;
      }
    }

    expect(withoutBarracks).toBeGreaterThan(30); // ~40% of 135, generous bounds
    expect(withoutBarracks).toBeLessThan(80);

    const unambiguous = developedRangeCount + veteranRangeCount;
    expect(unambiguous).toBeGreaterThan(0);
    const developedFraction = developedRangeCount / unambiguous;
    expect(developedFraction).toBeGreaterThan(0.4); // roughly 2:1, generous bounds
    expect(developedFraction).toBeLessThan(0.9);
  });

  // §19's whole reason for existing: "135 free farms with zero defence would hand every
  // player the §0 raid-income bound on day one" — so the world must actually contain
  // defenders once seeded, and their presence must track the band weights (§4: 40/40/20 for
  // young/developed/veteran), not just exist in isolated cases. `young` (no Barracks) is the
  // only band with zero defenders; `developed` + `veteran` together are ~60% of the
  // population and every one of them holds a defender (see the previous test: neither
  // band's `defenders` range includes 0).
  it('the §19 intent, asserted directly: defenders actually exist across the seeded world, and only in the bands that should have them', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    const settlements = await settlementModel.find({
      accountId: { $in: npcAccounts.map((a) => a._id) },
    });
    expect(settlements.length).toBe(135);

    const accountById = new Map(npcAccounts.map((a) => [String(a._id), a]));
    let withDefenseInfantry = 0;
    let withoutBarracks = 0;

    for (const settlement of settlements) {
      const account = accountById.get(String(settlement.accountId))!;
      const barracks = settlement.buildings.find((b) => b.type === 'barracks');
      const defenseInfantry = unitsTrainableAt(DEFAULT_CONFIG, 'barracks', account.faction!).find(
        (u) => u.role === 'defenseInfantry',
      )!;
      const hasDefender = settlement.troops.some((t) => t.unitType === defenseInfantry.type);

      if (!barracks) {
        withoutBarracks += 1;
        // `young` never trains anything (no Barracks), so it can never hold defence
        // infantry either.
        expect(hasDefender).toBe(false);
      } else {
        // Every Barracks-having settlement (developed/veteran) holds a defender.
        expect(hasDefender).toBe(true);
        withDefenseInfantry += 1;
      }
    }

    // ~40% young (no defenders) / ~60% developed+veteran (defenders) — generous bounds
    // around §4's 40/40/20 split, same tolerance the band-weighting test above uses.
    expect(withDefenseInfantry / settlements.length).toBeGreaterThan(0.45);
    expect(withDefenseInfantry / settlements.length).toBeLessThan(0.75);
    expect(withDefenseInfantry).toBe(settlements.length - withoutBarracks);
  });

  it('every seeded NPC settlement is net-Food-non-negative at genesis (M3a.7 §19 "the Food consequence")', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    const settlements = await settlementModel.find({
      accountId: { $in: npcAccounts.map((a) => a._id) },
    });
    expect(settlements.length).toBe(135);

    for (const settlement of settlements) {
      const buildingLevels = settlement.buildings.map((b) => ({
        type: b.type as BuildingType,
        level: b.level,
      }));
      const netFood = calcNetFoodPerHour(
        DEFAULT_CONFIG,
        buildingLevels,
        toTroopCounts(settlement.troops),
      );
      expect(netFood).toBeGreaterThanOrEqual(0);
    }
  });

  it('no seeded NPC settlement exceeds SETTLEMENT_SLOTS', async () => {
    const npcAccounts = await accountModel.find({ isNpc: true });
    const settlements = await settlementModel.find({
      accountId: { $in: npcAccounts.map((a) => a._id) },
    });
    expect(settlements.length).toBe(135);

    for (const settlement of settlements) {
      expect(settlement.buildings.length).toBeLessThanOrEqual(SETTLEMENT_SLOTS);
    }
  });

  it("resources sit at ~50% of each settlement's own storage caps", async () => {
    const npcAccountIds = (await accountModel.find({ isNpc: true }, '_id')).map((a) => a._id);
    const settlements = await settlementModel.find({ accountId: { $in: npcAccountIds } });

    for (const settlement of settlements) {
      const buildingLevels = settlement.buildings.map((b) => ({
        type: b.type as BuildingType,
        level: b.level,
      }));
      const caps = calcStorageCaps(DEFAULT_CONFIG, buildingLevels);
      expect(settlement.resources.values.scrap).toBe(caps.scrap * 0.5);
      expect(settlement.resources.values.fuel).toBe(caps.fuel * 0.5);
      expect(settlement.resources.values.electronics).toBe(caps.electronics * 0.5);
      expect(settlement.resources.values.food).toBe(caps.food * 0.5);
    }
  });

  it('seeding is idempotent: a second seedIfNeeded call adds nothing', async () => {
    const before = await accountModel.countDocuments({ isNpc: true });
    expect(before).toBe(135);

    const result = await npcSeederService.seedIfNeeded(Date.now());
    expect(result).toEqual({ seeded: false, npcCount: 0 });

    const after = await accountModel.countDocuments({ isNpc: true });
    expect(after).toBe(135);
  });

  it('performance: reseeding a freshly reset world completes within a generous ceiling', async () => {
    await resetToUnseeded();

    const start = Date.now();
    const result = await npcSeederService.seedIfNeeded(Date.now());
    const elapsedMs = Date.now() - start;
    console.log(`NpcSeederService: seeding 135 NPCs took ${elapsedMs}ms`);

    expect(result).toEqual({ seeded: true, npcCount: 135 });
    expect(elapsedMs).toBeLessThan(5_000);

    const count = await accountModel.countDocuments({ isNpc: true });
    expect(count).toBe(135);
  }, 30_000);

  it('two concurrent seed attempts against a freshly reset world create exactly one batch, not two', async () => {
    await resetToUnseeded();

    const now = Date.now();
    const [first, second] = await Promise.all([
      npcSeederService.seedIfNeeded(now),
      npcSeederService.seedIfNeeded(now),
    ]);

    const seededCount = [first.seeded, second.seeded].filter(Boolean).length;
    expect(seededCount).toBe(1);

    const count = await accountModel.countDocuments({ isNpc: true });
    expect(count).toBe(135);
  }, 30_000);

  it('a human account registering afterward lands inside the current spawn annulus (135 NPCs present -> spawnRadius = 25)', async () => {
    const settlementCount = await settlementModel.countDocuments({});
    expect(settlementCount).toBe(135); // sanity: no leftover human settlements from earlier tests

    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    expect(guestResponse.status).toBe(201);
    const cookies = guestResponse.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('lsSession='));
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error('unreachable');

    const createResponse = await request(app.getHttpServer())
      .post('/api/settlements')
      .set('Cookie', cookie);
    expect(createResponse.status).toBe(201);

    humanAccountId = guestResponse.body.id as string;
    humanSettlementId = createResponse.body.id as string;

    // The brief's own worked example: 135 NPCs -> R(135) = 25.
    expect(spawnRadius(DEFAULT_CONFIG, settlementCount)).toBe(25);
    const annulus = spawnAnnulus(DEFAULT_CONFIG, settlementCount);
    const distance = chebyshevDistance(
      { x: createResponse.body.x as number, y: createResponse.body.y as number },
      { x: 0, y: 0 },
    );
    expect(distance).toBeGreaterThanOrEqual(annulus.inner);
    expect(distance).toBeLessThanOrEqual(DEFAULT_CONFIG.map.radius);
  });

  it('regenerate deletes previously-seeded NPCs, leaves the human account/settlement untouched, resets the marker, and a later seed call reseeds', async () => {
    const worldBefore = await worldModel.findOne({ key: WORLD_SINGLETON_KEY });
    expect(worldBefore!.npcsSeededAt).not.toBeNull();

    const regenerated = await worldService.regenerate(undefined, Date.now());
    expect(regenerated.seed).not.toBe(worldBefore!.seed);
    expect(regenerated.npcsSeededAt).toBeNull();

    const npcCountAfter = await accountModel.countDocuments({ isNpc: true });
    expect(npcCountAfter).toBe(0);
    const totalSettlementsAfter = await settlementModel.countDocuments({});
    expect(totalSettlementsAfter).toBe(1); // just the human one

    const humanAccountStill = await accountModel.findById(humanAccountId);
    expect(humanAccountStill).not.toBeNull();
    const humanSettlementStill = await settlementModel.findById(humanSettlementId);
    expect(humanSettlementStill).not.toBeNull();

    // Closing the loop: the next boot's `NpcSeederService.onModuleInit` would call exactly
    // this, and it reseeds cleanly against the new seed.
    const reseedResult = await npcSeederService.seedIfNeeded(Date.now());
    expect(reseedResult).toEqual({ seeded: true, npcCount: 135 });
    const npcCountFinal = await accountModel.countDocuments({ isNpc: true });
    expect(npcCountFinal).toBe(135);
  }, 30_000);
});

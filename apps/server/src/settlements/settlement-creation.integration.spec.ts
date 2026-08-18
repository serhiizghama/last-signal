import {
  DEFAULT_CONFIG,
  chebyshevDistance,
  isInGrid,
  spawnAnnulus,
  spawnRadius,
  terrainAt,
} from '@last-signal/game-core';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { Account } from '../schemas/account.schema';
import type { AccountDocument } from '../schemas/account.schema';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import { Session } from '../schemas/session.schema';
import type { SessionDocument } from '../schemas/session.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import type { WorldDocument } from '../schemas/world.schema';
import { World } from '../schemas/world.schema';
import { PLACEMENT_RNG } from '../placement/placement.tokens';
import { STARTING_RESOURCES } from './settlements.constants';

// A fake `PlacementRng` that serves `values` in order, then falls back to real randomness
// once exhausted. Used by the forced-collision test below: enough control to make two
// concurrent placements propose the identical candidate, while every later draw (a retry
// after the forced collision) stays free to find a genuinely different, legal tile via real
// randomness — never a fixed value forever, which would just loop the picker into
// `PlacementExhaustedError` once that first candidate is legitimately taken.
function queuedRng(values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? Math.random();
}

// Mutable indirection so `PLACEMENT_RNG` can be swapped per-test without recompiling the
// Nest testing module (which is expensive and shared across every test in this file via
// `beforeAll`): the DI-provided value is a stable wrapper closing over this variable, and
// individual tests reassign the variable rather than the DI binding itself.
let placementRngImpl: () => number = () => Math.random();

// `POST /api/settlements` end to end: the center-out expanding annulus placement policy
// (`docs/M2_DESIGN_DECISIONS.md` §3, replacing M1b's deterministic outer-ring rule), the
// Influence-gated settlement limit (§7 — M1b only ever exercises "first settlement always
// allowed" / "second rejected"), and — the headline acceptance criterion for the whole M1b
// milestone, still true under the new policy — a fresh account registering, picking a
// faction, and getting a settlement, entirely through the API.
describe('Settlement creation (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let accountModel: Model<AccountDocument>;
  let settlementModel: Model<SettlementDocument>;
  let sessionModel: Model<SessionDocument>;
  let worldModel: Model<WorldDocument>;
  let oasisModel: Model<OasisDocument>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env['MONGODB_URI'] = replSet.getUri('last-signal-settlement-creation-test');
    // NPC seeding is covered by its own suite (`npc/npc-seeder.integration.spec.ts`) — this
    // one's placement-annulus/property assertions assume the settlement count is exactly the
    // count this file itself creates, so seeding stays off here.
    process.env['WORLD_NPC_COUNT'] = '0';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Real `Math.random()` by default (matching production); individual tests redirect
      // `placementRngImpl` to force specific candidates. See that variable's own comment.
      .overrideProvider(PLACEMENT_RNG)
      .useValue((): number => placementRngImpl())
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    accountModel = moduleRef.get(getModelToken(Account.name));
    settlementModel = moduleRef.get(getModelToken(Settlement.name));
    sessionModel = moduleRef.get(getModelToken(Session.name));
    worldModel = moduleRef.get(getModelToken(World.name));
    oasisModel = moduleRef.get(getModelToken(Oasis.name));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
    delete process.env['MONGODB_URI'];
    delete process.env['WORLD_NPC_COUNT'];
  }, 60_000);

  afterEach(async () => {
    placementRngImpl = () => Math.random();
    await Promise.all([
      accountModel.deleteMany({}),
      settlementModel.deleteMany({}),
      sessionModel.deleteMany({}),
    ]);
  });

  interface GuestSession {
    cookie: string;
    accountId: string;
  }

  async function createGuestSession(): Promise<GuestSession> {
    const response = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('lsSession='));
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error('unreachable');
    return { cookie, accountId: response.body.id as string };
  }

  function createSettlement(cookie: string) {
    return request(app.getHttpServer()).post('/api/settlements').set('Cookie', cookie);
  }

  it('happy path: on-grid coordinates, a level-1 Command Center, resources initialised', async () => {
    const { cookie } = await createGuestSession();

    const response = await createSettlement(cookie);

    expect(response.status).toBe(201);
    expect(response.body.x).toBeGreaterThanOrEqual(-30);
    expect(response.body.x).toBeLessThanOrEqual(30);
    expect(response.body.y).toBeGreaterThanOrEqual(-30);
    expect(response.body.y).toBeLessThanOrEqual(30);
    expect(response.body.buildings).toEqual([
      expect.objectContaining({ type: 'commandCenter', level: 1, slot: 0 }),
    ]);
    expect(response.body.resources.values).toEqual(STARTING_RESOURCES);
  });

  // M3c beginner protection (`docs/M3_DESIGN_DECISIONS.md` §11): a brand-new account's first
  // settlement stamps `account.protectedUntil` to `now + protection.durationMs`, inside the
  // same transaction as the settlement write.
  it('creating a first settlement stamps account.protectedUntil to now + protection.durationMs', async () => {
    const { cookie, accountId } = await createGuestSession();

    const before = Date.now();
    const response = await createSettlement(cookie);
    const after = Date.now();
    expect(response.status).toBe(201);

    const account = await accountModel.findById(accountId);
    expect(account).not.toBeNull();
    expect(account!.protectedUntil).toBeDefined();
    expect(account!.protectedUntil).toBeGreaterThanOrEqual(
      before + DEFAULT_CONFIG.protection.durationMs,
    );
    expect(account!.protectedUntil).toBeLessThanOrEqual(
      after + DEFAULT_CONFIG.protection.durationMs,
    );
  });

  it('a second settlement attempt is rejected with errors.settlement.limitReached', async () => {
    const { cookie } = await createGuestSession();

    const first = await createSettlement(cookie);
    expect(first.status).toBe(201);

    const second = await createSettlement(cookie);
    expect(second.status).toBe(409);
    expect(second.body.error.key).toBe('errors.settlement.limitReached');

    const stored = await settlementModel.find({});
    expect(stored).toHaveLength(1);
  });

  // Proves the new policy's own acceptance criteria (M2a, `docs/M2_DESIGN_DECISIONS.md` §13):
  // every settlement created through the real API is on-grid, never on a toxic-lake or oasis
  // tile, pairwise Chebyshev distance >= the configured minimum from every other one, and
  // lands inside the spawn annulus for the settlement count *at the time it was created*.
  // Created sequentially (not concurrently) so each read of "existing settlements" sees every
  // prior settlement already committed — the collision test below is what exercises the
  // concurrent-race path; this one asserts the steady-state invariants the policy promises.
  it('property: ~30 settlements are on-grid, never on a lake/oasis tile, pairwise distance >= minDistance, and inside their annulus', async () => {
    const world = await worldModel.findOne({});
    expect(world).not.toBeNull();
    if (!world) throw new Error('unreachable');
    const oases = await oasisModel.find({});
    const oasisTiles = new Set(oases.map((o) => `${o.x},${o.y}`));

    const COUNT = 30;
    const created: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < COUNT; i += 1) {
      const { cookie } = await createGuestSession();
      const response = await createSettlement(cookie);
      expect(response.status).toBe(201);
      const tile = { x: response.body.x as number, y: response.body.y as number };

      // `i` is exactly the number of settlements that already existed when this one was
      // placed (0-indexed, created sequentially, a clean collection at the start of this
      // test) — the `n` `pickSpawnTile` drew its annulus from.
      const annulus = spawnAnnulus(DEFAULT_CONFIG, i);
      const distance = chebyshevDistance(tile, { x: 0, y: 0 });
      expect(distance).toBeGreaterThanOrEqual(annulus.inner);
      expect(distance).toBeLessThanOrEqual(DEFAULT_CONFIG.map.radius);

      created.push(tile);
    }

    for (const tile of created) {
      expect(isInGrid(DEFAULT_CONFIG, tile)).toBe(true);
      expect(terrainAt(DEFAULT_CONFIG, world.seed, tile.x, tile.y)).not.toBe('toxicLake');
      expect(oasisTiles.has(`${tile.x},${tile.y}`)).toBe(false);
    }

    for (let i = 0; i < created.length; i += 1) {
      for (let j = i + 1; j < created.length; j += 1) {
        expect(chebyshevDistance(created[i]!, created[j]!)).toBeGreaterThanOrEqual(
          DEFAULT_CONFIG.map.settlement.minDistance,
        );
      }
    }
  });

  // Replaces the M1b-era test that forced a collision by rewinding the (now-deleted)
  // placement counter. Under the new policy a sequential re-draw of an already-occupied tile
  // is caught by `isSettleable`'s own minimum-distance rule before it ever reaches the
  // database (distance 0 to an existing settlement is always illegal) — so the unique
  // `{x, y}` index can only ever be the actual tie-breaker for a genuine TOCTOU race: two
  // concurrent placements that both read "no settlement here yet" before either commits. This
  // test forces exactly that race, deterministically, via the injected RNG.
  it('two concurrent creates racing for the same candidate collide on the unique {x,y} index and the loser retries onto a distinct tile', async () => {
    // Establishes a known-legal target tile without hardcoding coordinates or reasoning
    // about terrain/oases directly: create a real settlement through the normal (real-RNG)
    // path, capture where it landed, then free the tile again by deleting the document. No
    // settlements exist either before this probe or after it's deleted, so recomputing the
    // very same annulus (`spawnRadius(DEFAULT_CONFIG, 0)`) below reproduces exactly the rng
    // draw that lands on it.
    const probe = await createGuestSession();
    const probeSettlement = await createSettlement(probe.cookie);
    expect(probeSettlement.status).toBe(201);
    const target = { x: probeSettlement.body.x as number, y: probeSettlement.body.y as number };
    await settlementModel.deleteOne({ x: target.x, y: target.y });

    const outer = spawnRadius(DEFAULT_CONFIG, 0);
    // Sanity: the probe must have landed within the n=0 annulus's outer radius for the rng
    // values derived below (which can only reach `[-outer, outer]`) to actually reproduce
    // `target` — true by construction of `pickSpawnTile`, asserted here defensively so a
    // violation fails loudly instead of silently deriving a bogus rng value.
    expect(Math.max(Math.abs(target.x), Math.abs(target.y))).toBeLessThanOrEqual(outer);

    // The exact rng() value that makes `pickSpawnTile`'s `Math.floor(rng() * span) - outer`
    // (see `packages/game-core/src/map/spawn.ts`) land on `target` at n=0: the midpoint of
    // the bucket that floors to `target.<axis> + outer`.
    const span = 2 * outer + 1;
    const rngValueFor = (coordinate: number): number => (coordinate + outer + 0.5) / span;
    const vx = rngValueFor(target.x);
    const vy = rngValueFor(target.y);

    const first = await createGuestSession();
    const second = await createGuestSession();

    // Both concurrent calls' very first `pickSpawnTile` draw is forced onto `target` —
    // neither has committed yet when the other reads existing settlements (the TOCTOU window
    // `createSettlement`'s own comment documents), so both consider it legal. The unique
    // `{x, y}` index is the tie-breaker: one insert succeeds, the other throws a duplicate-key
    // error and the loser's bounded retry loop draws again — by then the queue below is
    // drained, so that redraw uses real randomness against the now-correct (one more
    // settlement) state.
    placementRngImpl = queuedRng([vx, vy, vx, vy]);

    const [firstResponse, secondResponse] = await Promise.all([
      createSettlement(first.cookie),
      createSettlement(second.cookie),
    ]);

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const results = [
      { x: firstResponse.body.x as number, y: firstResponse.body.y as number },
      { x: secondResponse.body.x as number, y: secondResponse.body.y as number },
    ];
    expect(results[0]!.x === results[1]!.x && results[0]!.y === results[1]!.y).toBe(false);
    // Exactly one of the two landed on the forced/contested tile — the other is the retry's
    // genuinely different candidate, proving the collision-retry path actually ran.
    const landedOnTarget = results.filter((r) => r.x === target.x && r.y === target.y);
    expect(landedOnTarget).toHaveLength(1);

    const allSettlements = await settlementModel.find({});
    expect(allSettlements).toHaveLength(2);
    const tileKeys = allSettlements.map((s) => `${s.x},${s.y}`);
    expect(new Set(tileKeys).size).toBe(tileKeys.length);
  });

  it('unauthenticated creation is rejected with errors.auth.notAuthenticated', async () => {
    const response = await request(app.getHttpServer()).post('/api/settlements').send({});
    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('errors.auth.notAuthenticated');
  });

  it('GET /api/settlements/mine returns only the caller own settlements', async () => {
    const owner = await createGuestSession();
    const other = await createGuestSession();
    const created = await createSettlement(owner.cookie);
    expect(created.status).toBe(201);
    await createSettlement(other.cookie);

    const mine = await request(app.getHttpServer())
      .get('/api/settlements/mine')
      .set('Cookie', owner.cookie);

    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].id).toBe(created.body.id);
  });

  // The M1b acceptance criterion, verbatim: "a fresh account can register, pick a faction,
  // and get a settlement, entirely through the API."
  it('acceptance path: guest -> register with faction -> create settlement -> read it back', async () => {
    const guestResponse = await request(app.getHttpServer()).post('/api/auth/guest').send({});
    expect(guestResponse.status).toBe(201);
    const cookies = guestResponse.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('lsSession='));
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error('unreachable');

    const registerResponse = await request(app.getHttpServer())
      .post('/api/accounts/register')
      .set('Cookie', cookie)
      .send({ name: 'Acceptance Traveller', faction: 'engineers', side: 'silence' });
    expect(registerResponse.status).toBe(200);
    expect(registerResponse.body).toMatchObject({
      name: 'Acceptance Traveller',
      isGuest: false,
      faction: 'engineers',
      side: 'silence',
    });

    const createResponse = await request(app.getHttpServer())
      .post('/api/settlements')
      .set('Cookie', cookie);
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.buildings).toEqual([
      expect.objectContaining({ type: 'commandCenter', level: 1 }),
    ]);

    const readBackResponse = await request(app.getHttpServer())
      .get(`/api/settlements/${createResponse.body.id}`)
      .set('Cookie', cookie);
    expect(readBackResponse.status).toBe(200);
    expect(readBackResponse.body.id).toBe(createResponse.body.id);
    expect(readBackResponse.body.x).toBeGreaterThanOrEqual(-30);
    expect(readBackResponse.body.x).toBeLessThanOrEqual(30);
    expect(readBackResponse.body.y).toBeGreaterThanOrEqual(-30);
    expect(readBackResponse.body.y).toBeLessThanOrEqual(30);
  });
});

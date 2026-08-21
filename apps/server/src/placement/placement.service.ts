import type { GameConfig, Tile } from '@last-signal/game-core';
import { isSettleable, pickSpawnTile, terrainAt } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { GAME_CONFIG } from '../game-config/game-config.tokens';
import type { OasisDocument } from '../schemas/oasis.schema';
import { Oasis } from '../schemas/oasis.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { WorldService } from '../world/world.service';
import { PlacementExhaustedError } from './placement.errors';
import type { PlacementRng } from './placement.tokens';
import { PLACEMENT_RNG } from './placement.tokens';

// The center-out expanding annulus spawn policy (`docs/M2_DESIGN_DECISIONS.md` §3),
// replacing M1b's deterministic outer-ring rule — one policy for humans and NPCs alike. Every
// actual game rule (the annulus geometry, settleability) lives in `game-core`'s
// `pickSpawnTile` + `isSettleable`; this service's only job is feeding them real data (the
// world seed, the live settlement/oasis tiles) and turning "no legal tile anywhere on the
// grid" into the existing HTTP error. No placement rule is reimplemented server-side here.
@Injectable()
export class PlacementService {
  constructor(
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Oasis.name) private readonly oasisModel: Model<OasisDocument>,
    @Inject(GAME_CONFIG) private readonly config: GameConfig,
    @Inject(WorldService) private readonly worldService: WorldService,
    @Inject(PLACEMENT_RNG) private readonly rng: PlacementRng,
  ) {}

  // The one legality check both public methods below share (M3d.1, §13): a candidate tile is
  // legal exactly when `isSettleable` says so, fed the live world seed, every existing
  // settlement's coordinates and every oasis tile. Factored out so `findTile` (drawing a
  // *fresh* candidate from the spawn annulus) and `isTileSettleable` (answering the same
  // question for a *caller-chosen* tile — a `settle` movement's target, §13) can never
  // silently disagree about what "legal" means; both build their `existingSettlements`/
  // `oasisTiles` snapshot from a query and hand it straight to this closure rather than each
  // re-deriving `isSettleable`'s input shape by hand.
  private buildLegalityCheck(
    world: { seed: string },
    existingSettlements: readonly Tile[],
    oasisTiles: ReadonlySet<string>,
  ): (tile: Tile) => boolean {
    return (tile: Tile): boolean =>
      isSettleable(this.config, {
        tile,
        terrain: terrainAt(this.config, world.seed, tile.x, tile.y),
        isOasis: oasisTiles.has(`${tile.x},${tile.y}`),
        existingSettlements,
      });
  }

  // Draws one fresh candidate tile from the current spawn annulus (§3: uniform within
  // `[max(0, R(n) - W), R(n)]`, `n` = the current total settlement count, growing outward if
  // that band has no legal tile). Loads the world seed, every existing settlement's
  // coordinates, and every oasis tile ONCE per call — not once per candidate `pickSpawnTile`
  // draws internally in its own retry loop — since at this scale (~150 settlements, 24
  // oases) that's a handful of KB, and reloading per draw would turn one placement attempt
  // into dozens of redundant queries for no benefit (§12: "map fetch cost ... negligible"
  // applies here too).
  //
  // No `session` parameter: every caller (`SettlementsService.createSettlement`) deliberately
  // draws the candidate tile *before* opening its own transaction — see that method's own
  // comment on why a retry must draw a genuinely fresh candidate rather than resuming one.
  async findTile(): Promise<Tile> {
    const [world, settlementDocs, oasisDocs] = await Promise.all([
      this.worldService.getWorld(),
      this.settlementModel.find({}, 'x y'),
      this.oasisModel.find({}, 'x y'),
    ]);

    const existingSettlements: Tile[] = settlementDocs.map((doc) => ({ x: doc.x, y: doc.y }));
    const oasisTiles = new Set(oasisDocs.map((doc) => `${doc.x},${doc.y}`));
    const isLegal = this.buildLegalityCheck(world, existingSettlements, oasisTiles);

    const tile = pickSpawnTile(this.config, existingSettlements.length, {
      rng: this.rng,
      isLegal,
    });
    if (!tile) {
      throw new PlacementExhaustedError();
    }
    return tile;
  }

  // The M3d.1 sibling `findTile` never needed until now: answers "may a settlement be
  // founded on THIS caller-chosen tile" rather than drawing one of its own (§13: a `settle`
  // movement's target tile, validated both at send — `MovementsService.sendMovement` — and
  // again at arrival — `SettleArrivalResolver` — since the world can change while the convoy
  // travels). Takes an optional `session` (unlike `findTile`, which never runs inside one):
  // both real call sites need this read to see the same in-flight transaction's own writes
  // (there are none that touch settlements/oases here, but a consistent snapshot matters when
  // this runs alongside other reads/writes in the same multi-document transaction), so the
  // caller passes its own session through rather than this method silently reading outside it.
  //
  // Deliberately reuses `buildLegalityCheck` rather than re-deriving `isSettleable`'s input —
  // see that method's own comment for why the two callers must never be able to disagree.
  async isTileSettleable(tile: Tile, session?: ClientSession): Promise<boolean> {
    const options = session ? { session } : undefined;
    const [world, settlementDocs, oasisDocs] = await Promise.all([
      this.worldService.getWorld(),
      this.settlementModel.find({}, 'x y', options),
      this.oasisModel.find({}, 'x y', options),
    ]);

    const existingSettlements: Tile[] = settlementDocs.map((doc) => ({ x: doc.x, y: doc.y }));
    const oasisTiles = new Set(oasisDocs.map((doc) => `${doc.x},${doc.y}`));
    return this.buildLegalityCheck(world, existingSettlements, oasisTiles)(tile);
  }
}

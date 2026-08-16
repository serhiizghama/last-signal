import type { GameConfig, Tile } from '@last-signal/game-core';
import { isSettleable, pickSpawnTile, terrainAt } from '@last-signal/game-core';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

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

  // Draws one fresh candidate tile from the current spawn annulus (§3: uniform within
  // `[max(0, R(n) - W), R(n)]`, `n` = the current total settlement count, growing outward if
  // that band has no legal tile). Loads the world seed, every existing settlement's
  // coordinates, and every oasis tile ONCE per call — not once per candidate `pickSpawnTile`
  // draws internally in its own retry loop — since at this scale (~150 settlements, 24
  // oases) that's a handful of KB, and reloading per draw would turn one placement attempt
  // into dozens of redundant queries for no benefit (§12: "map fetch cost ... negligible"
  // applies here too).
  async findTile(): Promise<Tile> {
    const [world, settlementDocs, oasisDocs] = await Promise.all([
      this.worldService.getWorld(),
      this.settlementModel.find({}, 'x y'),
      this.oasisModel.find({}, 'x y'),
    ]);

    const existingSettlements: Tile[] = settlementDocs.map((doc) => ({ x: doc.x, y: doc.y }));
    const oasisTiles = new Set(oasisDocs.map((doc) => `${doc.x},${doc.y}`));

    const isLegal = (tile: Tile): boolean =>
      isSettleable(this.config, {
        tile,
        terrain: terrainAt(this.config, world.seed, tile.x, tile.y),
        isOasis: oasisTiles.has(`${tile.x},${tile.y}`),
        existingSettlements,
      });

    const tile = pickSpawnTile(this.config, existingSettlements.length, {
      rng: this.rng,
      isLegal,
    });
    if (!tile) {
      throw new PlacementExhaustedError();
    }
    return tile;
  }
}

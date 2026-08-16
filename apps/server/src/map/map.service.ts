import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { Settlement } from '../schemas/settlement.schema';
import { WorldService } from '../world/world.service';
import type { MapSettlementView, MapView } from './map.view';
import { buildMapOasisView, buildMapSettlementView, buildMapWorldView } from './map.view';

// The read model behind `GET /api/map` (M2a.6, `docs/M2_DESIGN_DECISIONS.md` §5). Everything
// here is public between players — no per-account visibility state, no fog of war (§5's
// rejected alternatives) — so, unlike `SettlementsService`, there is no ownership check and no
// settling of lazy resource accrual: the map never carries resources at all, for anyone.
@Injectable()
export class MapService {
  constructor(
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @Inject(WorldService) private readonly worldService: WorldService,
  ) {}

  async getMapView(now: number): Promise<MapView> {
    const [world, oases, settlementDocs] = await Promise.all([
      // Reused rather than re-implemented: `WorldService` already owns the singleton read and
      // the oases collection (M2a.3) — this module only ever adds settlements + their owners.
      this.worldService.getWorld(),
      this.worldService.listOases(),
      // Public fields only — never `resources`/`buildings`/`buildQueue`/`troops`/`version`, so
      // there is nothing for `MapSettlementView` to accidentally leak even by a future
      // spreading mistake (see `toPlainResources`'s comment in `settlements.view.ts` for why
      // spreading a Mongoose document is unsafe regardless).
      this.settlementModel.find({}, 'x y name accountId'),
    ]);

    // Owner data resolved as two queries joined in memory — not a `$lookup` aggregation and
    // not a per-settlement query (which would be an N+1 at ~150 settlements). At this scale
    // (§12: "one query over ~150 settlements + one over 24 oases, negligible") a second
    // collection scan of comparable size costs about the same as the settlements query itself
    // and is far simpler to read/test than an aggregation pipeline that does the same join
    // server-side.
    const ownerIds = [...new Set(settlementDocs.map((doc) => String(doc.accountId)))];
    const ownerDocs = await this.accountModel.find({ _id: { $in: ownerIds } }, 'name faction side');
    const ownerById = new Map(ownerDocs.map((doc) => [String(doc._id), doc]));

    const settlements: MapSettlementView[] = [];
    for (const doc of settlementDocs) {
      const owner = ownerById.get(String(doc.accountId));
      // Every settlement's `accountId` references a real account written in the same
      // transaction that created it (`SettlementsService.createSettlement`,
      // `NpcSeederService.claimAndInsert`) — accounts are never deleted, so this should never
      // miss. Skipped rather than thrown: the map stays a read-only, best-effort view, and one
      // stale row is not worth failing the whole response for every player.
      if (!owner) continue;
      settlements.push(buildMapSettlementView(doc, owner));
    }

    return {
      world: buildMapWorldView(world, now),
      settlements,
      oases: oases.map(buildMapOasisView),
    };
  }
}

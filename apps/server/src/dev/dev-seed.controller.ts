import { randomUUID } from 'node:crypto';

import { Body, Controller, Inject, NotFoundException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { Account } from '../schemas/account.schema';
import type { AccountDocument } from '../schemas/account.schema';
import { Settlement } from '../schemas/settlement.schema';
import type { SettlementDocument } from '../schemas/settlement.schema';
import { SettlementsService } from '../settlements/settlements.service';
import { SeedSettlementDto } from './dev-seed.dto';

export interface SeedSettlementResult {
  accountId: string;
  settlementId: string;
}

// Manual/dev-testing shortcut only — the real flow every other caller (including the M1b
// acceptance-criterion test) goes through is `POST /api/auth/guest` ->
// `POST /api/accounts/register` -> `POST /api/settlements`. This endpoint exists purely to
// save a few round-trips when poking the API by hand, by creating a bare guest account and
// its first settlement in one call.
//
// Delegates the actual settlement creation to `SettlementsService.createSettlement` — the
// same real, on-grid, collision-safe outer-ring placement every other settlement gets. This
// is the fix for the known bug this endpoint used to have: the pre-M1b version generated
// raw random coordinates directly (`x: 28418, y: 79586` and similar), far outside the
// 61×61 grid, instead of going through `PlacementService`. Now there is no code path left
// that can produce an off-grid settlement.
//
// Obviously dev-scoped: refuses to run once `NODE_ENV=production` (returns a plain 404,
// same as a route that doesn't exist — no hint to a scanner that a dev endpoint is even
// present).
@Controller('dev')
export class DevSeedController {
  constructor(
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  @Post('seed-settlement')
  async seedSettlement(@Body() dto: SeedSettlementDto): Promise<SeedSettlementResult> {
    if (this.configService.get<string>('NODE_ENV', 'development') === 'production') {
      throw new NotFoundException();
    }

    // Random-suffixed default, not a fixed literal: `Account.name` is now uniquely indexed
    // (see that schema's comment), so two seed calls with no explicit `name` in the same
    // run must not collide.
    const accountName = dto.name ?? `Dev Account ${randomUUID().slice(0, 8)}`;
    const account = await this.accountModel.create({ name: accountName, isGuest: true });

    const settlement = await this.settlementsService.createSettlement(
      account._id,
      dto.name ?? 'Dev Settlement',
      Date.now(),
    );

    const hasResourceOverride =
      dto.scrap !== undefined ||
      dto.fuel !== undefined ||
      dto.electronics !== undefined ||
      dto.food !== undefined;
    if (hasResourceOverride) {
      await this.settlementModel.updateOne(
        { _id: settlement.id },
        {
          $set: {
            'resources.values.scrap': dto.scrap ?? settlement.resources.values.scrap,
            'resources.values.fuel': dto.fuel ?? settlement.resources.values.fuel,
            'resources.values.electronics':
              dto.electronics ?? settlement.resources.values.electronics,
            'resources.values.food': dto.food ?? settlement.resources.values.food,
          },
        },
      );
    }

    return { accountId: String(account._id), settlementId: settlement.id };
  }
}

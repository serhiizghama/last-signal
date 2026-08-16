import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { AccountDocument } from '../schemas/account.schema';
import { StartBuildDto } from './dto/start-build.dto';
import { TrainScoutsDto } from './dto/train-scouts.dto';
import { SettlementsService } from './settlements.service';
import type { SettlementStateView } from './settlements.view';

// Every route here is ownership-checked (§ M1b): `SettlementsService` verifies the
// resolved account actually owns the settlement id in the URL before reading/mutating it —
// see `SettlementsService.settleSettlementDoc`'s comment for exactly where that happens.
@Controller('settlements')
@UseGuards(AuthGuard)
export class SettlementsController {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(
    @Inject(SettlementsService) private readonly settlementsService: SettlementsService,
  ) {}

  // Registered before `GET :id` — Nest/Express match routes in declaration order, and a
  // literal path must come before a parameterised sibling or `:id` would swallow `mine` as
  // `id === 'mine'`.
  @Get('mine')
  async mine(@CurrentAccount() account: AccountDocument): Promise<SettlementStateView[]> {
    return this.settlementsService.listSettlements(account._id, Date.now());
  }

  @Post()
  async create(@CurrentAccount() account: AccountDocument): Promise<SettlementStateView> {
    return this.settlementsService.createSettlement(account._id, account.name, Date.now());
  }

  @Get(':id')
  async getState(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
  ): Promise<SettlementStateView> {
    return this.settlementsService.getSettlementState(id, account._id, Date.now());
  }

  // 200, not the Nest POST default of 201: the response body is the settlement's current
  // state view, not a representation of a newly-created resource at a new URL.
  @Post(':id/build')
  @HttpCode(HttpStatus.OK)
  async startBuild(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
    @Body() dto: StartBuildDto,
  ): Promise<SettlementStateView> {
    return this.settlementsService.startBuild(id, account._id, dto.type, Date.now());
  }

  @Post(':id/build/:queueItemId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelBuild(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
    @Param('queueItemId') queueItemId: string,
  ): Promise<SettlementStateView> {
    return this.settlementsService.cancelBuild(id, account._id, queueItemId, Date.now());
  }

  // 200, not 201, same rationale as `startBuild` above. No cancel counterpart exists for
  // training (see `MAX_ACTIVE_TRAINING_ORDERS`'s comment in `settlements.constants.ts`) —
  // this is the only training route this controller ever gains in M2b.
  @Post(':id/train')
  @HttpCode(HttpStatus.OK)
  async trainScouts(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
    @Body() dto: TrainScoutsDto,
  ): Promise<SettlementStateView> {
    return this.settlementsService.trainScouts(
      id,
      account._id,
      account.faction,
      dto.unitType,
      dto.count,
      Date.now(),
    );
  }
}

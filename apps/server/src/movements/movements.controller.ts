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
import { SendMovementDto } from './dto/send-movement.dto';
import { MovementsService } from './movements.service';
import type { MovementView } from './movements.view';

// Every route here is ownership-checked (§ M1b/M2b.3 convention): `MovementsService` verifies
// the resolved account actually owns the settlement/movement id involved before
// reading/mutating it — see `MovementsService.sendMovement`
// (via `SettlementsService.settleSettlementDoc`) and `.cancelMovement`'s own comments.
@Controller('movements')
@UseGuards(AuthGuard)
export class MovementsController {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(MovementsService) private readonly movementsService: MovementsService) {}

  // Registered before `POST :id/cancel` for the same reason `SettlementsController` registers
  // `GET mine` before `GET :id` — a literal path segment (`mine`) never collides with a
  // parameterised sibling here regardless of order (different HTTP methods/shapes), but kept
  // in the same relative position for consistency with that controller's convention.
  @Get('mine')
  async mine(@CurrentAccount() account: AccountDocument): Promise<MovementView[]> {
    return this.movementsService.listMine(account._id, Date.now());
  }

  @Post()
  async send(
    @CurrentAccount() account: AccountDocument,
    @Body() dto: SendMovementDto,
  ): Promise<MovementView> {
    return this.movementsService.sendMovement(
      dto.fromSettlementId,
      account._id,
      dto.type,
      dto.target,
      dto.units,
      Date.now(),
      dto.siegeTarget,
    );
  }

  // 200, not the Nest POST default of 201 — same rationale as `SettlementsController`'s build
  // routes: the response body is the movement's current state, not a representation of a
  // newly-created resource at a new URL.
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
  ): Promise<MovementView> {
    return this.movementsService.cancelMovement(id, account._id, Date.now());
  }
}

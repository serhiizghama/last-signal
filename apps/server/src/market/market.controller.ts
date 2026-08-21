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
import { AcceptOfferDto } from './dto/accept-offer.dto';
import { CreateOfferDto } from './dto/create-offer.dto';
import { ExchangeDto } from './dto/exchange.dto';
import { MarketService } from './market.service';
import type {
  MarketExchangeView,
  TradeAcceptView,
  TradeOfferBoardView,
  TradeOfferCancelView,
  TradeOfferView,
} from './market.view';

// Every route here is ownership-checked where ownership applies (§ M1b/M2b.3 convention):
// `MarketService` verifies the resolved account actually owns the settlement/offer id
// involved before mutating it — see `MarketService.createOffer`
// (via `SettlementsService.settleSettlementDoc`) and `.cancelOffer`'s own comments. The board
// read (`GET offers`) is deliberately the one route with no ownership check at all — offers
// are public (§14: this is a marketplace).
@Controller('market')
@UseGuards(AuthGuard)
export class MarketController {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(MarketService) private readonly marketService: MarketService) {}

  @Post('offers')
  async create(
    @CurrentAccount() account: AccountDocument,
    @Body() dto: CreateOfferDto,
  ): Promise<TradeOfferView> {
    return this.marketService.createOffer(
      dto.fromSettlementId,
      account._id,
      account.faction,
      dto.give,
      dto.want,
      Date.now(),
    );
  }

  @Get('offers')
  async list(@CurrentAccount() account: AccountDocument): Promise<TradeOfferBoardView> {
    return this.marketService.listOffers(account._id, Date.now());
  }

  // 200, not the Nest POST default of 201 — same rationale as `MovementsController`'s own
  // `:id/cancel` route: the response body is the offer's current state (plus the refund
  // clamp), not a representation of a newly-created resource at a new URL.
  @Post('offers/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
  ): Promise<TradeOfferCancelView> {
    return this.marketService.cancelOffer(id, account._id, Date.now());
  }

  // 200, not 201 — same rationale as `cancel` above: the response body reflects the offer's
  // new state (plus the two spawned movements' ids), not a single newly-created resource at
  // a new URL of its own (M3d.3, §14).
  @Post('offers/:id/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
    @Body() dto: AcceptOfferDto,
  ): Promise<TradeAcceptView> {
    return this.marketService.acceptOffer(
      id,
      account._id,
      account.faction,
      dto.fromSettlementId,
      Date.now(),
    );
  }

  // The world exchange (§14, M3d.4) — deliberately its own top-level route, not nested under
  // `offers`: an exchange has no offer document, no counterparty, and nothing on the board.
  // 201 (Nest's default for `@Post`, left unoverridden): unlike `cancel`/`accept` above, this
  // genuinely creates a new resource — a `MarketExchange` document — at no URL of its own yet
  // (M3e may add a `GET` for it), the same shape `createOffer` above already returns 201 for.
  @Post('exchange')
  async exchange(
    @CurrentAccount() account: AccountDocument,
    @Body() dto: ExchangeDto,
  ): Promise<MarketExchangeView> {
    return this.marketService.startExchange(
      dto.fromSettlementId,
      account._id,
      account.faction,
      dto.from,
      dto.to,
      dto.amount,
      Date.now(),
    );
  }
}

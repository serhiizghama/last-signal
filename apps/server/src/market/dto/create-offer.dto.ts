import { Type } from 'class-transformer';
import { IsNumber, IsString, ValidateNested } from 'class-validator';

// Mirrors `TrainUnitsDto`/`SendMovementDto`'s rationale (see either's own comment): only
// structural/shape checks live here. `resource` stays a bare string rather than
// `@IsIn(RESOURCE_KINDS)`, and `amount` stays `@IsNumber()` rather than `@IsInt()`/`@Min()` —
// an unknown resource kind, a non-integer amount, or a non-positive one must all still reach
// `MarketService.createOffer` and come back as a stable i18n key
// (`errors.market.unknownResource`/`invalidAmount`, §15), never a generic 400 from the
// validation pipe.
export class TradeOfferSideDto {
  @IsString()
  resource!: string;

  @IsNumber()
  amount!: number;
}

export class CreateOfferDto {
  @IsString()
  fromSettlementId!: string;

  // `@ValidateNested`/`@Type` are needed so `class-validator` actually recurses into
  // `give`/`want` when the global `ValidationPipe` runs (`main.ts`) — without them a nested
  // object survives `whitelist: true` unvalidated (`SendMovementDto`'s own comment on
  // `target`/`units` explains this in full).
  @ValidateNested()
  @Type(() => TradeOfferSideDto)
  give!: TradeOfferSideDto;

  @ValidateNested()
  @Type(() => TradeOfferSideDto)
  want!: TradeOfferSideDto;
}

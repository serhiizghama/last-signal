import { IsNumber, IsString } from 'class-validator';

// Mirrors `CreateOfferDto`'s rationale (see that class's own comment): only structural/shape
// checks live here. `from`/`to` stay bare strings rather than `@IsIn(RESOURCE_KINDS)`, and
// `amount` stays `@IsNumber()` rather than `@IsInt()`/`@Min()` — an unknown resource kind, the
// same resource on both sides, a non-integer amount, or a non-positive one must all still
// reach `MarketService.startExchange` and come back as a stable i18n key
// (`errors.market.unknownResource`/`sameResource`/`invalidAmount`, §15), never a generic 400
// from the validation pipe.
export class ExchangeDto {
  @IsString()
  fromSettlementId!: string;

  @IsString()
  from!: string;

  @IsString()
  to!: string;

  @IsNumber()
  amount!: number;
}

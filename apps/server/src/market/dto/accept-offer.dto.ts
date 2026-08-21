import { IsString } from 'class-validator';

// Mirrors `CreateOfferDto`'s rationale (see that class's own comment): only a structural
// shape check lives here. `fromSettlementId` is the accepter's OWN settlement — which one
// pays `want.amount` and receives `give.amount` — never validated for ownership here (that
// is `MarketService.acceptOffer`'s job, via `SettlementsService.settleSettlementDoc`, the
// same seam every other command in this codebase uses for its own "is this really yours"
// check).
export class AcceptOfferDto {
  @IsString()
  fromSettlementId!: string;
}

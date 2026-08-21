import { IsString } from 'class-validator';

// Mirrors `RecallMovementDto`'s rationale — only structural checks live here. `ownerAccountId`
// names the contingent's owner (the host is naming somebody else's troops to send home), not
// the caller — the caller is always the host, resolved from the authenticated session, never
// from the request body.
export class EvictMovementDto {
  @IsString()
  hostSettlementId!: string;

  @IsString()
  ownerAccountId!: string;

  @IsString()
  fromSettlementId!: string;
}

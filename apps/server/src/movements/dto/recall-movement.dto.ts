import { IsString } from 'class-validator';

// Mirrors `SendMovementDto`'s rationale (see its own comment): only structural checks live
// here. Every semantic rejection (unknown/foreign origin, no such contingent, the "cannot
// happen" same-settlement invariant) belongs to `MovementsService`, not here, so it comes
// back as a stable i18n key (§15) rather than a generic pipe error.
export class RecallMovementDto {
  @IsString()
  hostSettlementId!: string;

  @IsString()
  fromSettlementId!: string;
}

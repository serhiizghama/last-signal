import { IsNumber, IsOptional, IsString } from 'class-validator';

// Dev-only seeding input — see `DevSeedController`'s doc comment for why this exists and
// how it's meant to be replaced. Every field is optional so `POST /api/dev/seed-settlement`
// with an empty body is enough to get a usable settlement.
//
// No `x`/`y` here (unlike the pre-M1b version): coordinates now always come from the real
// `PlacementService` outer-ring rule, same as every other settlement — that was the actual
// bug this rework fixes (see `DevSeedController`'s comment).
export class SeedSettlementDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  scrap?: number;

  @IsOptional()
  @IsNumber()
  fuel?: number;

  @IsOptional()
  @IsNumber()
  electronics?: number;

  @IsOptional()
  @IsNumber()
  food?: number;
}

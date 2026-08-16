import { IsOptional, IsString } from 'class-validator';

// Mirrors `StartBuildDto`'s rationale (see its own comment): only structural/type checks
// live here. Semantic validation — name length bounds, uniqueness, faction/side membership
// — belongs to `AccountsService`, so a rejection reaches the client as
// `{ error: { key, params } }` (§15: i18n keys, never class-validator's generic prose
// message), not a generic 400.
export class RegisterDto {
  @IsString()
  name!: string;

  @IsString()
  faction!: string;

  @IsOptional()
  @IsString()
  side?: string;
}

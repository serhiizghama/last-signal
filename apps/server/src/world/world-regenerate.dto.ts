import { IsOptional, IsString } from 'class-validator';

// Dev-only regenerate input — see `WorldDevController`'s doc comment. `seed` is optional:
// omit it for a fresh random seed, or pass one to reproduce a specific world deterministically
// (handy for repro'ing a bug against a known layout).
export class RegenerateWorldDto {
  @IsOptional()
  @IsString()
  seed?: string;
}

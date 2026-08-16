import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { MAX_REPORTS_LIMIT } from '../reports.constants';

// `GET /api/reports` query params. Unlike every POST-body DTO in this codebase
// (`SendScoutsDto` etc.), query-string values arrive as raw strings no matter what they
// represent — `@Type(() => Number)` is required here (and isn't anywhere else) so
// `class-transformer` actually casts `limit` before `@IsInt()`/`@Min()`/`@Max()` run;
// `main.ts`'s global `ValidationPipe` runs with `transform: true` but, like every other
// decorator-metadata-dependent behavior in this codebase, can't be trusted to infer the
// target type on its own under Vitest's esbuild transform (see `HealthController`'s comment
// on `@Inject` for the same underlying reason).
export class ListReportsQueryDto {
  // Cursor validity (does this decode to a real `{createdAt, id}` pair?) is
  // `ReportsService`'s job, not the DTO's — same split of responsibility as every semantic
  // check in this codebase (§15: a stable i18n key, not a generic pipe rejection).
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REPORTS_LIMIT)
  limit?: number;
}

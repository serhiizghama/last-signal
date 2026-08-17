import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsString, ValidateNested } from 'class-validator';

// Mirrors `StartBuildDto`/`TrainUnitsDto`'s rationale (see their own comments): only
// structural/shape checks live here. `@ValidateNested`/`@Type` are needed so
// `class-validator` actually recurses into `target`/`units` when the global `ValidationPipe`
// runs (`main.ts`) — without them a nested object survives `whitelist: true` unvalidated.
// Every semantic rejection (unknown type, non-scout unit, insufficient troops, target not a
// settlement, target is your own settlement, invalid/zero counts, empty unit list) belongs to
// `MovementsService`, not here, so it comes back as a stable i18n key (§15) rather than a
// generic pipe error — same split of responsibility as every other command DTO in this
// codebase.
export class MovementTargetDto {
  @IsNumber()
  x!: number;

  @IsNumber()
  y!: number;
}

export class MovementUnitDto {
  @IsString()
  unitType!: string;

  @IsNumber()
  count!: number;
}

export class SendScoutsDto {
  // M2 ships exactly one movement type (`docs/M2_DESIGN_DECISIONS.md` §6) — still a bare
  // string, not `@IsIn(['scout'])`: an unrecognised type must reach `MovementsService` and
  // come back as `errors.movement.unknownType`, not a generic pipe rejection.
  @IsString()
  type!: string;

  @IsString()
  fromSettlementId!: string;

  @ValidateNested()
  @Type(() => MovementTargetDto)
  target!: MovementTargetDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MovementUnitDto)
  units!: MovementUnitDto[];
}

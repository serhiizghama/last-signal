import { IsNumber, IsString } from 'class-validator';

// Mirrors `StartBuildDto`'s rationale (see its own comment): only structural/type checks
// live here. `unitType` stays a bare string rather than `@IsIn(UNIT_TYPES)` — an unknown,
// untrainable, or wrong-faction unit type must still reach `SettlementsService.trainUnits`
// and come back as `{ error: { key: 'errors.training.unknownType' | 'wrongFaction', ... } }`
// (§15: i18n keys, never a generic class-validator message). `count` stays `@IsNumber()`
// rather than `@IsInt()`/`@Min()`/`@Max()` for the same reason: 0, negative, non-integer and
// over-the-cap values must all reach the service and come back as
// `errors.training.invalidCount`, not a generic 400 from the validation pipe.
export class TrainUnitsDto {
  @IsString()
  unitType!: string;

  @IsNumber()
  count!: number;
}

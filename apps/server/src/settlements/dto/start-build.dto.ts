import { IsString } from 'class-validator';

// `type` is validated as a non-empty string here, not restricted to `BuildingType` via
// `class-validator`'s `IsIn` — an unrecognised type must still reach `SettlementsService`
// and come back as `{ error: { key: 'errors.build.unknownType', ... } }` (§15: i18n keys,
// not a generic class-validator message), so the "is this a real building type" check
// belongs to the service, not the DTO.
export class StartBuildDto {
  @IsString()
  type!: string;
}

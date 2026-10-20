import { ArrayMaxSize, IsArray, IsDefined, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateRoomDto {
  @IsInt() @Min(1) @Max(40)
  lobbyTarget!: number;

  @IsOptional() @IsInt() @Min(1) @Max(600)
  durationMinutes?: number;
}

export class JoinRoomV2Dto {
  @IsString() @Matches(/^\d{6}$/u)
  code!: string;

  @IsString() @Matches(/^[A-Za-z0-9_-]{32,80}$/u)
  deviceId!: string;

  @IsString() @MinLength(1) @MaxLength(100) @Matches(/\S/u)
  firstName!: string;

  @IsString() @MinLength(1) @MaxLength(100) @Matches(/\S/u)
  lastName!: string;

  @IsOptional() @IsString() @MaxLength(128)
  sessionToken?: string;
}

export class RoomAnswerDto {
  @IsString() @MinLength(1) @MaxLength(100)
  questionId!: string;

  @IsDefined()
  value!: unknown;
}

export class SaveRoomAnswersDto {
  @IsArray() @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => RoomAnswerDto)
  answers!: RoomAnswerDto[];
}

export class RoomProctorEventDto {
  @IsString() @IsIn(['VISIBILITY_HIDDEN', 'VISIBILITY_RESTORED', 'SCREEN_SHARE_ENDED', 'SCREEN_SHARE_RESTORED'])
  eventType!: 'VISIBILITY_HIDDEN' | 'VISIBILITY_RESTORED' | 'SCREEN_SHARE_ENDED' | 'SCREEN_SHARE_RESTORED';
}

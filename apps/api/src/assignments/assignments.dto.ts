import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional,
  IsString, IsObject, IsIn, IsDateString, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '@prisma/client';

export class QuestionOptionDto {
  @IsString() @MinLength(1) @MaxLength(500) @Matches(/\S/u)
  text!: string;

  @IsOptional() @IsBoolean()
  isCorrect?: boolean;
}

export class CreateQuestionDto {
  @IsEnum(QuestionType) @IsIn([QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE, QuestionType.SHORT_TEXT, QuestionType.LONG_TEXT, QuestionType.NUMERIC])
  type!: QuestionType;

  @IsString() @MinLength(1) @MaxLength(5000) @Matches(/\S/u)
  prompt!: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10000)
  points?: number;

  @IsOptional() @IsBoolean()
  required?: boolean;

  @IsOptional() @IsObject()
  config?: Record<string, unknown>;

  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];
}

export class CreateAssignmentDto {
  @IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/u)
  title!: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsString() @MinLength(1) @MaxLength(120) @Matches(/\S/u)
  subjectName!: string;

  @IsOptional() @IsInt() @Min(1) @Max(600)
  timeLimitMinutes?: number;

  @IsOptional() @IsDateString()
  availableFrom?: string;

  @IsOptional() @IsDateString()
  dueAt?: string;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  maxAttempts?: number;

  @IsOptional() @IsInt() @Min(1) @Max(2000)
  lobbyTarget?: number;

  @IsOptional() @IsBoolean()
  shuffleQuestions?: boolean;

  @IsOptional() @IsBoolean()
  shuffleOptions?: boolean;

  @IsOptional() @IsString() @MaxLength(100)
  classId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(100, { each: true })
  studentIds?: string[];

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CreateQuestionDto)
  questions!: CreateQuestionDto[];
}

export class AnswerInputDto {
  @IsString() @MinLength(1) @MaxLength(100)
  questionId!: string;

  @IsOptional() @IsString() @MaxLength(20000)
  textValue?: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(-9999999999.9999) @Max(9999999999.9999)
  numericValue?: number;

  @IsOptional()
  jsonValue?: unknown;
}

export class SubmitAnswersDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AnswerInputDto)
  answers!: AnswerInputDto[];
}

export class RoomJoinDto {
  @IsString() @MinLength(6) @MaxLength(16) @Matches(/^[A-Za-z0-9]+$/u)
  code!: string;
}

export class ProctorEventDto {
  @IsString() @IsIn(['VISIBILITY_HIDDEN', 'PAGE_HIDDEN', 'VISIBILITY_RESTORED'])
  eventType!: string;
}

export class GradeAnswerDto {
  @IsString() @MinLength(1) @MaxLength(100)
  answerId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10000)
  awardedPoints!: number;

  @IsOptional() @IsString() @MaxLength(5000)
  teacherComment?: string;
}

export class GradeSubmissionDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => GradeAnswerDto)
  answers!: GradeAnswerDto[];

  @IsOptional() @IsString() @MaxLength(10000)
  feedback?: string;
}


export class ReturnSubmissionDto {
  @IsOptional() @IsString() @MaxLength(10000)
  feedback?: string;
}

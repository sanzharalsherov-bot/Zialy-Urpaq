import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const clean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : value;

export class CreateClassDto {
  @Transform(clean) @IsString() @MinLength(1) @MaxLength(80) @Matches(/\S/u)
  name!: string;

  @Transform(clean) @IsString() @MinLength(4) @MaxLength(20) @Matches(/\S/u)
  academicYear!: string;
}

export class CreateSubjectDto {
  @Transform(clean) @IsString() @MinLength(1) @MaxLength(120) @Matches(/\S/u)
  name!: string;

  @IsOptional() @Transform(clean) @IsString() @MaxLength(1000)
  description?: string;
}

export class CreateStudentDto {
  @Transform(clean) @IsString() @MinLength(1) @MaxLength(100) @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  firstName!: string;

  @Transform(clean) @IsString() @MinLength(1) @MaxLength(100) @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  lastName!: string;

  @IsString() @MinLength(1) @MaxLength(100)
  classId!: string;

  @IsOptional() @Transform(clean) @IsString() @MaxLength(40) @Matches(/^[\p{L}\p{N}._/-]+$/u)
  studentNo?: string;
}

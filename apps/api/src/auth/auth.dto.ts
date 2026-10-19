import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { MaxPasswordBytes } from './auth.security';

const trimEmail = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const trimName = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : value;

export class LoginDto {
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @MaxPasswordBytes()
  password!: string;
}

export class BootstrapAdminDto extends LoginDto {
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @MaxPasswordBytes()
  @Matches(/\S/u)
  declare password: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  bootstrapKey!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(64)
  studentAccessCode!: string;
}

export class SharedStudentLoginDto {
  @IsString() @MinLength(6) @MaxLength(64)
  accessCode!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString() @MinLength(1) @MaxLength(100)
  firstName!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString() @MinLength(1) @MaxLength(100)
  lastName!: string;
}

export class UpdateStudentAccessCodeDto {
  @IsString() @MinLength(6) @MaxLength(64)
  accessCode!: string;
}


export class CreateTeacherDto {
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @MaxPasswordBytes()
  @Matches(/\S/u)
  password!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;
}

export class CreateUserDto {
  @IsIn([UserRole.TEACHER])
  role!: UserRole;

  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @MaxPasswordBytes()
  @Matches(/\S/u)
  password!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(trimName)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;
}

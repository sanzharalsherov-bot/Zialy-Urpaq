import {
  BadRequestException, ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BootstrapAdminDto, CreateTeacherDto, CreateUserDto, LoginDto, SharedStudentLoginDto, UpdateStudentAccessCodeDto } from './auth.dto';
import { LoginAttempts, normalizeName, sharedStudentSubject, studentCodeVersion, validatePasswordBytes } from './auth.security';

// Match the cost of a real account lookup without revealing whether an email exists.
const DUMMY_PASSWORD_HASH = '$2b$12$MxL1EXKMiIgviwHB7aLHC.KHsTNoMVb6FY7byx35hPAZeIpjJV9VC';

@Injectable()
export class AuthService {
  private readonly attempts = new LoginAttempts();
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  private safeSecretEquals(a: string, b: string): boolean {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  }

  private accessCodeMaterial(code: string) {
    const normalized = code.trim().normalize('NFKC');
    if (normalized.length < 6 || normalized.length > 64) throw new BadRequestException('Общий код должен содержать от 6 до 64 символов');
    return createHash('sha256').update(normalized).digest('base64');
  }

  async bootstrapAdmin(dto: BootstrapAdminDto) {
    const configuredKey = process.env.BOOTSTRAP_ADMIN_KEY;
    if (!configuredKey || !this.safeSecretEquals(dto.bootstrapKey, configuredKey)) {
      throw new UnauthorizedException('Неверный ключ первоначальной настройки');
    }
    if (await this.prisma.user.count() > 0) {
      throw new ConflictException('Первый администратор уже создан; bootstrap отключён');
    }
    if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32) {
      throw new ServiceUnavailableException('JWT_SECRET должен содержать не менее 32 символов');
    }
    validatePasswordBytes(dto.password);
    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const studentAccessCodeHash = await bcrypt.hash(this.accessCodeMaterial(dto.studentAccessCode), 12);
    const user = await this.prisma.$transaction(async tx => {
      // A process-wide mutex is insufficient when two API instances are running.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(19851016)`;
      if (await tx.user.count() > 0) {
        throw new ConflictException('Первый администратор уже создан; bootstrap отключён');
      }
      const created = await tx.user.create({
        data: {
          email, passwordHash,
          firstName,
          lastName,
          role: UserRole.ADMIN,
        },
        select: { id: true, email: true, firstName: true, lastName: true, role: true },
      });
      await tx.schoolSettings.upsert({
        where: { id: 'school' },
        create: { id: 'school', studentAccessCodeHash },
        update: { studentAccessCodeHash },
      });
      return created;
    });
    return { message: 'Первый администратор создан', user };
  }

  async createTeacher(dto: CreateTeacherDto) {
    return this.createUser({ ...dto, role: UserRole.TEACHER });
  }

  async listUsers() {
    return this.prisma.user.findMany({
      where: { role: UserRole.TEACHER },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, createdAt: true },
    });
  }

  async createUser(dto: CreateUserDto) {
    if (dto.role !== UserRole.TEACHER) throw new BadRequestException('Можно создавать только учётные записи преподавателей');
    validatePasswordBytes(dto.password);
    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    let user;
    try {
      user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName,
        lastName,
        role: dto.role,
        teacherProfile: { create: {} },
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('Пользователь с таким email уже существует');
      }
      throw error;
    }
    return { message: 'Учётная запись преподавателя создана', user };
  }

  async login(dto: LoginDto, ip = 'unknown') {
    if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32) {
      throw new ServiceUnavailableException('JWT_SECRET не настроен корректно');
    }
    validatePasswordBytes(dto.password);
    const email = dto.email.trim().toLowerCase();
    const releaseIp = this.attempts.reserve(`staff-ip:${ip}`, 60);
    let releaseAccount: () => void;
    try {
      releaseAccount = this.attempts.reserve(`staff-account:${createHash('sha256').update(email).digest('hex')}`, 10);
    } catch (error) {
      releaseIp();
      throw error;
    }
    let user;
    try {
      user = await this.prisma.user.findUnique({ where: { email } });
    } catch (error) {
      releaseAccount();
      releaseIp();
      throw error;
    }
    const matches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.isActive || !matches || user.role === UserRole.STUDENT) {
      throw new UnauthorizedException('Неверный email или пароль');
    }
    releaseAccount();
    releaseIp();
    const accessToken = await this.jwt.signAsync({
      sub: user.id, email: user.email, role: user.role,
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 7200,
      user: {
        id: user.id, email: user.email, firstName: user.firstName,
        lastName: user.lastName, role: user.role,
      },
    };
  }

  async loginSharedStudent(dto: SharedStudentLoginDto, ip = 'unknown') {
    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const material = this.accessCodeMaterial(dto.accessCode);
    const release = this.attempts.reserve(`student-ip:${ip}`, 30);
    let settings;
    try {
      settings = await this.prisma.schoolSettings.findUnique({ where: { id: 'school' } });
    } catch (error) {
      release();
      throw error;
    }
    const matches = await bcrypt.compare(material, settings?.studentAccessCodeHash ?? DUMMY_PASSWORD_HASH);
    if (!settings || !matches) {
      throw new UnauthorizedException('Неверный общий код школы');
    }
    release();
    const sub = sharedStudentSubject(firstName, lastName);
    const accessToken = await this.jwt.signAsync({
      sub, role: UserRole.STUDENT, kind: 'shared_student', firstName, lastName,
      accessCodeVersion: studentCodeVersion(settings.studentAccessCodeHash),
    });
    return {
      accessToken, tokenType: 'Bearer', expiresIn: 7200,
      user: { id: sub, email: '', firstName, lastName, role: UserRole.STUDENT },
    };
  }

  async getStudentAccessCodeStatus() {
    const settings = await this.prisma.schoolSettings.findUnique({ where: { id: 'school' }, select: { id: true } });
    return { configured: !!settings };
  }

  async updateStudentAccessCode(dto: UpdateStudentAccessCodeDto) {
    const studentAccessCodeHash = await bcrypt.hash(this.accessCodeMaterial(dto.accessCode), 12);
    await this.prisma.schoolSettings.upsert({
      where: { id: 'school' },
      create: { id: 'school', studentAccessCodeHash },
      update: { studentAccessCodeHash },
    });
    return { message: 'Общий код входа учеников обновлён' };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Аккаунт недоступен');
    return user;
  }
}

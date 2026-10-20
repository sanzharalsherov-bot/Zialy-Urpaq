import {
  CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException, HttpException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from './auth.types';
import { JWT_AUDIENCE, JWT_ISSUER, normalizeName, sharedStudentSubject, studentCodeVersion } from './auth.security';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly rates = new Map<string, { count: number; until: number }>();
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthenticatedUser;
    }>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > 4096 || !/^Bearer [^\s]+$/i.test(header)) {
      throw new UnauthorizedException('Требуется авторизация');
    }

    const token = header.slice(7);
    let payload: {
      sub: string; exp: number; email?: string; role?: UserRole; kind?: string;
      firstName?: string; lastName?: string; studentProfileId?: string; accessCodeVersion?: string;
    };

    try {
      payload = await this.jwt.verifyAsync(token, {
        algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
      });
      if (!payload || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 ||
        !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000 ||
        (payload.kind !== undefined && payload.kind !== 'shared_student')) {
        throw new Error('Invalid token claims');
      }
      if (payload.kind === 'shared_student' && (
        payload.role !== UserRole.STUDENT || typeof payload.firstName !== 'string' || typeof payload.lastName !== 'string' ||
        normalizeName(payload.firstName) !== payload.firstName || normalizeName(payload.lastName) !== payload.lastName ||
        payload.sub !== sharedStudentSubject(payload.firstName, payload.lastName) ||
        typeof payload.studentProfileId !== 'string' || !payload.studentProfileId || payload.studentProfileId.length > 128 ||
        typeof payload.accessCodeVersion !== 'string' || !/^[a-f0-9]{64}$/.test(payload.accessCodeVersion)
      )) throw new Error('Invalid shared student token');
    } catch {
      throw new UnauthorizedException('Недействительный или просроченный токен');
    }

    const now = Date.now();
    let rate = this.rates.get(payload.sub);
    if (!rate || now >= rate.until) {
      if (this.rates.size >= 10000) for (const [key, entry] of this.rates) if (entry.until <= now) this.rates.delete(key);
      if (this.rates.size >= 10000) throw new HttpException('Слишком много активных сессий. Повторите позже.', 429);
      rate = { count: 0, until: now + 60_000 }; this.rates.set(payload.sub, rate);
    }
    if (++rate.count > 240) throw new HttpException('Слишком много запросов. Повторите через минуту.', 429);

    if (payload.kind === 'shared_student') {
      let settings;
      try {
        settings = await this.prisma.schoolSettings.findUnique({
          where: { id: 'school' }, select: { studentAccessCodeHash: true },
        });
      } catch {
        throw new ServiceUnavailableException('Не удалось проверить сессию. Повторите позже.');
      }
      if (!settings || payload.accessCodeVersion !== studentCodeVersion(settings.studentAccessCodeHash)) {
        throw new UnauthorizedException('Код школы изменён. Войдите заново.');
      }
      let profile;
      try {
        profile = await this.prisma.studentProfile.findUnique({
          where: { id: payload.studentProfileId },
          select: { id: true, user: { select: { isActive: true, role: true, firstName: true, lastName: true } } },
        });
      } catch {
        throw new ServiceUnavailableException('Не удалось проверить профиль ученика. Повторите позже.');
      }
      if (!profile || !profile.user.isActive || profile.user.role !== UserRole.STUDENT ||
          profile.user.firstName !== payload.firstName || profile.user.lastName !== payload.lastName) {
        throw new UnauthorizedException('Профиль ученика недоступен. Войдите заново.');
      }
      request.user = {
        sub: payload.sub, email: '', role: UserRole.STUDENT, kind: 'shared_student',
        firstName: payload.firstName, lastName: payload.lastName, studentProfileId: profile.id,
      };
      return true;
    }

    let user;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true, email: true, role: true, isActive: true, firstName: true, lastName: true,
          studentProfile: { select: { id: true } },
        },
      });
    } catch {
      throw new ServiceUnavailableException('Не удалось проверить сессию. Повторите позже.');
    }
    if (!user || !user.isActive || user.role === UserRole.STUDENT) {
      throw new UnauthorizedException('Аккаунт недоступен');
    }
    request.user = {
      sub: user.id, email: user.email, role: user.role, firstName: user.firstName,
      lastName: user.lastName, studentProfileId: user.studentProfile?.id,
    };
    return true;
  }
}

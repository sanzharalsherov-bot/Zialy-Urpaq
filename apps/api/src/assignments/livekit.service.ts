import { createHmac, createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { RoomStatus, SubmissionStatus } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

type TokenInput = { apiKey: string; apiSecret: string; identity: string; name: string; room: string; staff: boolean; nowSeconds?: number };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sessionDigest = (token: string) => createHash('sha256').update(token).digest('hex');

export function buildLiveKitToken(input: TokenInput): string {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(input.apiKey) || input.apiSecret.length < 32 || input.apiSecret.length > 256) throw new Error('LiveKit API credentials are not configured');
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.identity) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.room) || input.name.length > 100) throw new Error('Invalid LiveKit identity or room');
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const claims: Record<string, unknown> = {
    iss: input.apiKey, sub: input.identity, name: input.name,
    nbf: now - 5, iat: now, exp: now + 600,
    video: input.staff
      ? { roomJoin: true, room: input.room, canPublish: false, canSubscribe: true }
      : { roomJoin: true, room: input.room, canPublish: true, canSubscribe: false, canPublishSources: ['screen_share'] },
  };
  const body = `${header}.${encode(claims)}`;
  return `${body}.${createHmac('sha256', input.apiSecret).update(body).digest('base64url')}`;
}

@Injectable()
export class LiveKitService {
  constructor(private readonly prisma: PrismaService) {}

  private credentials() {
    const apiKey = process.env.LIVEKIT_API_KEY ?? '';
    const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
    const url = process.env.LIVEKIT_PUBLIC_URL ?? '';
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(apiKey) || apiSecret.length < 32 || apiSecret.length > 256 || !/^wss?:\/\/[^/@?#]+(?:\/[A-Za-z0-9/_-]*)?$/.test(url)) throw new ServiceUnavailableException('Трансляция экрана не настроена на сервере');
    return { apiKey, apiSecret, url };
  }

  private async roomDeadlinePassed(startedAt: Date | null, durationMinutes: number | null) {
    if (!startedAt || durationMinutes === null) return false;
    const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
    const now = rows[0]?.now ?? new Date();
    return now.getTime() >= startedAt.getTime() + durationMinutes * 60_000;
  }

  private token(identity: string, name: string, room: string, staff: boolean) {
    const credentials = this.credentials();
    return { url: credentials.url, token: buildLiveKitToken({ ...credentials, identity, name, room, staff }) };
  }

  async staffToken(roomId: string, user: AuthenticatedUser) {
    if (user.role !== 'ADMIN' && user.role !== 'TEACHER') throw new ForbiddenException();
    const room = await this.prisma.testRoom.findFirst({ where: { id: roomId, ...(user.role === 'ADMIN' ? {} : { creatorId: user.sub }) }, select: { id: true, status: true, startedAt: true, durationMinutes: true } });
    if (!room) throw new NotFoundException('Комната не найдена');
    if (room.status !== RoomStatus.RUNNING) throw new BadRequestException('Трансляция доступна только во время теста');
    if (await this.roomDeadlinePassed(room.startedAt, room.durationMinutes)) throw new BadRequestException('Время теста истекло');
    const userName = await this.prisma.user.findUnique({ where: { id: user.sub }, select: { firstName: true, lastName: true } });
    return this.token(`staff:${user.sub}`, `${userName?.firstName ?? 'Staff'} ${userName?.lastName ?? ''}`.trim().slice(0, 100), room.id, true);
  }

  async studentToken(roomId: string, roomToken: string) {
    if (!roomToken || roomToken.length > 128) throw new NotFoundException('Комната не найдена');
    const participant = await this.prisma.roomParticipant.findFirst({
      where: { roomId, sessionHash: sessionDigest(roomToken) },
      select: { id: true, firstName: true, lastName: true, room: { select: { id: true, status: true, startedAt: true, durationMinutes: true } } },
    });
    if (!participant) throw new NotFoundException('Комната не найдена');
    if (participant.room.status !== RoomStatus.RUNNING) throw new BadRequestException('Трансляция доступна только во время теста');
    if (await this.roomDeadlinePassed(participant.room.startedAt, participant.room.durationMinutes)) throw new BadRequestException('Время теста истекло');
    const attempt = await this.prisma.submission.findFirst({ where: { roomId, participantId: participant.id }, orderBy: { attemptNo: 'desc' }, select: { status: true } });
    if (!attempt || attempt.status !== SubmissionStatus.IN_PROGRESS) throw new NotFoundException('Активная попытка не найдена');
    return this.token(`student:${participant.id}`, 'Student', roomId, false);
  }
}

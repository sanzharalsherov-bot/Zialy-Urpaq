import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RoomSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      params: { roomId?: string };
      roomToken?: string;
    }>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > 256 || !/^Bearer [A-Za-z0-9_-]{40,80}$/u.test(header)) {
      throw new UnauthorizedException('Требуется сессия ученика');
    }
    const token = header.slice(7);
    const sessionHash = createHash('sha256').update(token).digest('hex');
    const participant = await this.prisma.roomParticipant.findFirst({
      where: { roomId: request.params.roomId, sessionHash }, select: { id: true },
    });
    if (!participant) throw new NotFoundException('Комната не найдена');
    request.roomToken = token;
    return true;
  }
}

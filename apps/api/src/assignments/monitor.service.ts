import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';

type LiveState = { seenAt: number; sharing: boolean; questionId?: string; visible: boolean; frame?: string; frameAt: number; watcherAt: number };
// One short-lived frame per watched student, never persisted or added to logs.
@Injectable()
export class MonitorService implements OnModuleDestroy {
  private readonly states = new Map<string, LiveState>();
  private readonly cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (now - state.seenAt > 60_000) this.states.delete(id);
      else if (now - state.frameAt > 15_000) state.frame = undefined;
    }
  }, 15_000).unref();
  constructor(private readonly prisma: PrismaService) {}
  onModuleDestroy() { clearInterval(this.cleanup); this.states.clear(); }

  private staffScope(user: AuthenticatedUser) {
    if (user.role !== 'ADMIN' && user.role !== 'TEACHER') throw new ForbiddenException();
    return user.role === 'ADMIN' ? {} : { creatorId: user.sub };
  }
  private async ownAttempt(id: string, user: AuthenticatedUser) {
    if (user.role !== 'STUDENT') throw new ForbiddenException();
    const row = await this.prisma.submission.findFirst({
      where: { id, studentIdentityKey: createHash('sha256').update(`student:${user.sub}`).digest('hex'), status: { in: ['IN_PROGRESS', 'WAITING'] } },
      select: { assignmentId: true, status: true },
    });
    if (!row) { this.states.delete(id); throw new NotFoundException('Активная попытка не найдена'); }
    return row;
  }
  private state(id: string) {
    let state = this.states.get(id);
    if (!state) {
      if (this.states.size >= 2000) throw new HttpException('Наблюдение временно недоступно', 503);
      state = { seenAt: Date.now(), sharing: false, visible: true, frameAt: 0, watcherAt: 0 };
      this.states.set(id, state);
    }
    return state;
  }
  async heartbeat(id: string, dto: { visible: boolean; sharing: boolean; questionId?: string }, user: AuthenticatedUser) {
    const attempt = await this.ownAttempt(id, user);
    if (dto.questionId && !await this.prisma.question.findFirst({ where: { id: dto.questionId, assignmentId: attempt.assignmentId }, select: { id: true } })) throw new BadRequestException('Неизвестный вопрос');
    const state = this.state(id);
    if (state.sharing !== dto.sharing) await this.prisma.proctorEvent.create({ data: { submissionId: id, eventType: dto.sharing ? 'SCREEN_STARTED' : 'SCREEN_STOPPED' } });
    Object.assign(state, dto, { seenAt: Date.now() });
    if (!state.sharing) { state.frame = undefined; state.frameAt = 0; }
    await this.prisma.submission.update({ where: { id }, data: { lastSeenAt: new Date() } });
    return { watching: Date.now() - state.watcherAt < 12_000 };
  }
  async uploadFrame(id: string, frame: string, user: AuthenticatedUser) {
    await this.ownAttempt(id, user);
    const state = this.states.get(id);
    if (!state?.sharing || Date.now() - state.seenAt > 20_000) throw new ForbiddenException('Сначала включите демонстрацию');
    if (typeof frame !== 'string' || frame.length > 140_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame)) throw new BadRequestException('Недопустимый кадр');
    const bytes = Buffer.from(frame.slice(23), 'base64');
    if (bytes.length > 100_000 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw new BadRequestException('Недопустимый JPEG');
    if (Date.now() - state.frameAt < 1200) throw new HttpException('Слишком частые кадры', 429);
    if (Date.now() - state.watcherAt < 12_000) { state.frame = frame; state.frameAt = Date.now(); }
    return { accepted: !!state.frame };
  }
  async list(assignmentId: string, user: AuthenticatedUser) {
    const scope = this.staffScope(user);
    const assignment = await this.prisma.assignment.findFirst({ where: { id: assignmentId, ...scope }, select: { id: true, title: true, _count: { select: { questions: true } } } });
    if (!assignment) throw new NotFoundException('Задание не найдено');
    const students = await this.prisma.submission.findMany({ where: { assignmentId }, orderBy: { startedAt: 'desc' }, take: 1000, select: {
      id: true, studentFirstName: true, studentLastName: true, attemptNo: true, status: true, proctorWarnings: true, lastSeenAt: true, _count: { select: { answers: true } },
    } });
    return { assignment, students: students.map(s => ({ ...s, online: !!s.lastSeenAt && Date.now() - s.lastSeenAt.getTime() < 20_000, sharing: this.states.get(s.id)?.sharing === true && Date.now() - (this.states.get(s.id)?.seenAt ?? 0) < 20_000, visible: this.states.get(s.id)?.visible ?? null })) };
  }
  async watch(id: string, user: AuthenticatedUser) {
    const row = await this.prisma.submission.findFirst({ where: { id, assignment: this.staffScope(user) }, select: {
      id: true, status: true, studentFirstName: true, studentLastName: true, proctorWarnings: true,
      answers: { orderBy: { question: { position: 'asc' } }, select: { questionId: true, textValue: true, numericValue: true, jsonValue: true, question: { select: { prompt: true, options: { select: { id: true, text: true } } } } } },
    } });
    if (!row) throw new NotFoundException('Попытка не найдена');
    const active = row.status === 'IN_PROGRESS' || row.status === 'WAITING';
    if (!active) this.states.delete(id);
    const state = active ? this.state(id) : undefined;
    if (state) state.watcherAt = Date.now();
    const currentQuestion = state?.questionId ? await this.prisma.question.findUnique({ where: { id: state.questionId }, select: { prompt: true } }) : null;
    return { ...row, currentQuestion: currentQuestion?.prompt ?? null, visible: state?.visible ?? null, sharing: state?.sharing === true && Date.now() - state.seenAt < 20_000, frame: state?.sharing && Date.now() - state.frameAt < 10_000 ? state.frame ?? null : null, frameAt: state?.frameAt || null };
  }
}

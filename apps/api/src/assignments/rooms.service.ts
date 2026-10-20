import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { AssignmentStatus, Prisma, RoomStatus, SubmissionStatus, UserRole } from '@prisma/client';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateRoomDto, RoomProctorEventDto, SaveRoomAnswersDto } from './rooms.dto';
import { enqueueResultExport } from './results-outbox.service';

type RoomActor = AuthenticatedUser;
type SnapshotOption = { id: string; text: string; isCorrect: boolean };
type SnapshotQuestion = { sourceQuestionId: string; type: string; prompt: string; points: number; required: boolean; options: SnapshotOption[] };
type RoomSnapshot = { version: 1; questions: SnapshotQuestion[]; shuffleQuestions: boolean; shuffleOptions: boolean; durationMinutes: number | null };

const sessionDigest = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class RoomsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() { this.timer = setInterval(() => { void this.finishExpiredRooms(); }, 5000).unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async finishExpiredRooms() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const expired = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "TestRoom"
        WHERE "status" = 'RUNNING'::"RoomStatus" AND "startedAt" IS NOT NULL AND "durationMinutes" IS NOT NULL
          AND "startedAt" + "durationMinutes" * INTERVAL '1 minute' <= NOW()
        ORDER BY "startedAt" LIMIT 50`;
      for (const { id } of expired) {
        await this.prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "TestRoom" WHERE "id" = ${id} FOR UPDATE`;
          const room = await tx.testRoom.findUnique({ where: { id }, select: { status: true, snapshot: true, startedAt: true, durationMinutes: true } });
          if (!room || room.status !== RoomStatus.RUNNING || !room.startedAt || room.durationMinutes === null) return;
          const time = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
          const now = time[0]?.now ?? new Date();
          if (now.getTime() < room.startedAt.getTime() + room.durationMinutes * 60_000) return;
          const attempts = await tx.submission.findMany({ where: { roomId: id, status: SubmissionStatus.IN_PROGRESS }, select: { id: true } });
          for (const attempt of attempts) await this.finalizeRoomAttempt(tx, id, attempt.id, room.snapshot as RoomSnapshot | null, now, 'TIME_LIMIT');
          if (!attempts.length) await tx.testRoom.update({ where: { id }, data: { status: RoomStatus.FINISHED, finishedAt: now } });
        });
      }
    } catch { console.error('Room deadline sweep unavailable; retrying shortly'); }
    finally { this.sweeping = false; }
  }

  private requireStaff(actor: RoomActor) {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.TEACHER) throw new ForbiddenException('Доступ только для преподавателя');
  }

  private staffScope(actor: RoomActor) {
    return actor.role === UserRole.ADMIN ? {} : { creatorId: actor.sub };
  }

  private roomSummary(room: any) {
    return {
      id: room.id, assignmentId: room.assignmentId, assignmentTitle: room.assignment?.title,
      joinCode: room.joinCode, status: room.status, lobbyTarget: room.lobbyTarget,
      count: room._count?.participants ?? room.participants?.length ?? 0,
      warningCount: room.submissions?.reduce((sum: number, submission: any) => sum + (submission.proctorWarnings || 0), 0) ?? 0,
      flaggedParticipants: room.submissions?.filter((submission: any) => (submission.proctorWarnings || 0) >= 2).length ?? 0,
      startedAt: room.startedAt, durationMinutes: room.durationMinutes,
    };
  }

  async createRoom(assignmentId: string, input: CreateRoomDto, actor: RoomActor) {
    this.requireStaff(actor);
    if (!Number.isInteger(input.lobbyTarget) || input.lobbyTarget < 1 || input.lobbyTarget > 40) throw new BadRequestException('В лобби можно указать от 1 до 40 учеников');
    if (input.durationMinutes !== undefined && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 600)) throw new BadRequestException('Длительность должна быть от 1 до 600 минут');
    const assignment = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, ...this.staffScope(actor) },
      select: {
        id: true, creatorId: true, status: true, timeLimitMinutes: true,
        questions: { select: { id: true, type: true, options: { select: { isCorrect: true } } } },
      },
    });
    if (!assignment) throw new NotFoundException('Задание не найдено');
    if (assignment.status !== AssignmentStatus.PUBLISHED) throw new BadRequestException('Сначала опубликуйте задание');
    if (!assignment.questions.length) throw new BadRequestException('В задании нет вопросов');
    const unsupported = assignment.questions.find(question => question.type !== 'SINGLE_CHOICE' && question.type !== 'MULTIPLE_CHOICE');
    if (unsupported) throw new BadRequestException('Комната поддерживает только вопросы с одним или несколькими вариантами ответа. Уберите текстовые и числовые вопросы из задания.');
    for (const question of assignment.questions) {
      if (!question.options.length || !question.options.some(option => option.isCorrect)) {
        throw new BadRequestException('У каждого вопроса комнаты должен быть хотя бы один правильный вариант');
      }
      if (question.type === 'SINGLE_CHOICE' && question.options.filter(option => option.isCorrect).length !== 1) {
        throw new BadRequestException('В вопросе с одним ответом должен быть ровно один правильный вариант');
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const joinCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        const room = await this.prisma.testRoom.create({
          data: { assignmentId, creatorId: actor.sub, joinCode, lobbyTarget: input.lobbyTarget, durationMinutes: input.durationMinutes ?? assignment.timeLimitMinutes },
          include: { assignment: { select: { title: true } }, _count: { select: { participants: true } } },
        });
        return this.roomSummary(room);
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      }
    }
    throw new BadRequestException('Не удалось подобрать свободный код комнаты. Повторите попытку.');
  }

  async listRooms(actor: RoomActor, assignmentId?: string) {
    this.requireStaff(actor);
    const rooms = await this.prisma.testRoom.findMany({
      where: { ...this.staffScope(actor), ...(assignmentId ? { assignmentId } : {}) },
      include: { assignment: { select: { title: true } }, _count: { select: { participants: true } }, submissions: { where: { proctorWarnings: { gt: 0 } }, select: { proctorWarnings: true } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    return rooms.map(room => this.roomSummary(room));
  }

  async getRoom(roomId: string, actor: RoomActor) {
    this.requireStaff(actor);
    const room = await this.prisma.testRoom.findFirst({
      where: { id: roomId, ...this.staffScope(actor) },
      include: {
        assignment: { select: { title: true } }, _count: { select: { participants: true } },
        submissions: { where: { proctorWarnings: { gt: 0 } }, select: { proctorWarnings: true } },
        participants: { orderBy: { joinedAt: 'asc' }, select: { id: true, firstName: true, lastName: true, joinedAt: true, lastSeenAt: true, submissions: { orderBy: { attemptNo: 'desc' }, take: 1, select: { status: true, proctorWarnings: true, finishReason: true, proctorEvents: { orderBy: { createdAt: 'desc' }, take: 6, select: { eventType: true, createdAt: true } } } } } },
      },
    });
    if (!room) throw new NotFoundException('Комната не найдена');
    return { ...this.roomSummary(room), participants: room.participants.map((participant: any) => ({ ...participant, attempt: participant.submissions[0] ?? null, submissions: undefined })) };
  }

  async roomAnalytics(roomId: string, actor: RoomActor) {
    this.requireStaff(actor);
    const room = await this.prisma.testRoom.findFirst({
      where: { id: roomId, ...this.staffScope(actor) },
      include: { assignment: { select: { title: true } } },
    });
    if (!room) throw new NotFoundException('Комната не найдена');
    const attempts = await this.prisma.submission.findMany({
      where: { roomId, status: SubmissionStatus.GRADED, totalScore: { not: null } },
      select: { id: true, studentFirstName: true, studentLastName: true, totalScore: true, startedAt: true, submittedAt: true, answers: { select: { questionId: true, jsonValue: true, isCorrect: true, awardedPoints: true } } },
    });
    const snapshot = room.snapshot as RoomSnapshot | null;
    const questionDefinitions = snapshot?.questions ?? [];
    const totalPoints = questionDefinitions.reduce((sum, question) => sum + question.points, 0);
    const scores = attempts.map((attempt: any) => Number(attempt.totalScore) || 0);
    const durations = attempts.flatMap((attempt: any) => attempt.submittedAt ? [Math.max(0, Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000))] : []).sort((a, b) => a - b);
    const medianDuration = durations.length ? durations.length % 2 ? durations[(durations.length - 1) / 2] : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2) : null;
    const questions = questionDefinitions.map(question => {
      const responses = attempts.flatMap((attempt: any) => attempt.answers.filter((answer: any) => answer.questionId === question.sourceQuestionId && answer.jsonValue !== null).map((answer: any) => answer));
      const correct = responses.filter((answer: any) => answer.isCorrect === true).length;
      const answered = responses.length;
      return { questionId: question.sourceQuestionId, prompt: question.prompt, points: question.points, attemptCount: attempts.length, answered, unanswered: Math.max(0, attempts.length - answered), correct, incorrect: Math.max(0, answered - correct), accuracyPercent: answered ? Math.round(correct * 1000 / answered) / 10 : 0 };
    });
    const ranking = [...attempts].sort((a: any, b: any) => Number(b.totalScore) - Number(a.totalScore) || (a.submittedAt?.getTime() ?? Infinity) - (b.submittedAt?.getTime() ?? Infinity));
    return {
      roomId, assignmentTitle: room.assignment.title, attemptCount: attempts.length,
      summary: {
        averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) * 100 / scores.length) / 100 : 0,
        maximumScore: totalPoints,
        averagePercent: scores.length && totalPoints ? Math.round(scores.reduce((sum, score) => sum + score, 0) * 1000 / scores.length / totalPoints) / 10 : 0,
        medianDurationSeconds: medianDuration,
      },
      questions,
      top: ranking.slice(0, 10).map((attempt: any, index: number) => ({ rank: index + 1, firstName: attempt.studentFirstName, lastName: attempt.studentLastName, score: Number(attempt.totalScore), submittedAt: attempt.submittedAt })),
    };
  }

  private shuffled<T>(values: T[]) {
    const output = [...values];
    for (let i = output.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [output[i], output[j]] = [output[j], output[i]];
    }
    return output;
  }

  private attemptOrder(snapshot: RoomSnapshot) {
    const questionIds = snapshot.questions.map(question => question.sourceQuestionId);
    const questionOrder = snapshot.shuffleQuestions ? this.shuffled(questionIds) : questionIds;
    const optionOrder: Record<string, string[]> = {};
    for (const question of snapshot.questions) {
      const optionIds = question.options.map(option => option.id);
      optionOrder[question.sourceQuestionId] = snapshot.shuffleOptions ? this.shuffled(optionIds) : optionIds;
    }
    return { questionOrder, optionOrder };
  }

  async startRoom(roomId: string, actor: RoomActor) {
    this.requireStaff(actor);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "TestRoom" WHERE "id" = ${roomId} FOR UPDATE`;
      const room = await tx.testRoom.findFirst({
        where: { id: roomId, ...this.staffScope(actor) },
        include: { assignment: { include: { questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } } } }, participants: true },
      });
      if (!room) throw new NotFoundException('Комната не найдена');
      if (room.status === RoomStatus.RUNNING) return {
        id: room.id, assignmentId: room.assignmentId, joinCode: room.joinCode, status: room.status,
        lobbyTarget: room.lobbyTarget, count: room.participants.length, startedAt: room.startedAt,
        durationMinutes: room.durationMinutes,
      };
      if (room.status !== RoomStatus.LOBBY) throw new BadRequestException('Комнату нельзя запустить в текущем состоянии');
      if (!room.participants.length) throw new BadRequestException('Дождитесь хотя бы одного ученика или проверьте код комнаты');
      const questions = room.assignment.questions;
      if (!questions.length) throw new BadRequestException('В задании нет вопросов');
      const unsupported = questions.find(q => q.type !== 'SINGLE_CHOICE' && q.type !== 'MULTIPLE_CHOICE');
      if (unsupported) throw new BadRequestException('В новой комнате пока поддерживаются вопросы с одним или несколькими вариантами ответа');
      for (const question of questions) {
        if (!question.options.length || !question.options.some(option => option.isCorrect)) throw new BadRequestException('У каждого вопроса должен быть хотя бы один правильный вариант');
        if (question.type === 'SINGLE_CHOICE' && question.options.filter(option => option.isCorrect).length !== 1) throw new BadRequestException('В вопросе с одним ответом должен быть ровно один правильный вариант');
      }
      const snapshot: RoomSnapshot = {
        version: 1,
        questions: questions.map(q => ({
          sourceQuestionId: q.id, type: q.type, prompt: q.prompt, points: Number(q.points), required: q.required,
          options: q.options.map(option => ({ id: option.id, text: option.text, isCorrect: option.isCorrect })),
        })),
        shuffleQuestions: room.assignment.shuffleQuestions,
        shuffleOptions: room.assignment.shuffleOptions,
        durationMinutes: room.durationMinutes,
      };
      const startedAt = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
      const authoritativeTime = startedAt[0]?.now ?? new Date();
      const updated = await tx.testRoom.update({ where: { id: roomId }, data: { status: RoomStatus.RUNNING, startedAt: authoritativeTime, snapshot: snapshot as Prisma.InputJsonValue } });
      const waitingAttempts = await tx.submission.findMany({ where: { roomId, status: SubmissionStatus.WAITING }, select: { id: true, participantId: true } });
      for (const attempt of waitingAttempts) {
        const order = this.attemptOrder(snapshot);
        await tx.submission.update({ where: { id: attempt.id }, data: {
          status: SubmissionStatus.IN_PROGRESS, startedAt: authoritativeTime,
          questionOrder: order.questionOrder as Prisma.InputJsonValue,
          optionOrder: order.optionOrder as Prisma.InputJsonValue,
        } });
      }
      await tx.auditLog.create({ data: { actorId: actor.sub, action: 'ROOM_V2_STARTED', entityType: 'TestRoom', entityId: roomId, metadata: { participants: room.participants.length } } });
      return { id: updated.id, assignmentId: updated.assignmentId, joinCode: updated.joinCode, status: updated.status, lobbyTarget: updated.lobbyTarget, count: room.participants.length, startedAt: updated.startedAt, durationMinutes: updated.durationMinutes };
    });
  }

  async joinRoom(code: string, firstName: string, lastName: string, token?: string, sourceIp?: string, deviceId = 'legacy-device') {
    if (!/^\d{6}$/u.test(code)) throw new NotFoundException('Комната не найдена');
    if (!firstName?.trim() || !lastName?.trim() || firstName.length > 100 || lastName.length > 100) throw new BadRequestException('Введите имя и фамилию');
    if (token && (token.length > 128 || !/^[A-Za-z0-9_-]{40,80}$/u.test(token))) throw new NotFoundException('Комната не найдена');
    const source = String(sourceIp || 'unknown').slice(0, 128);
    const device = typeof deviceId === 'string' && /^[A-Za-z0-9_-]{32,80}$/u.test(deviceId) ? deviceId : 'legacy-device';
    const deviceKey = createHash('sha256').update(`room-v2-device:${device}`).digest('hex');
    const ipKey = createHash('sha256').update(`room-v2:${source}:${deviceKey}`).digest('hex');
    const ipSignalKey = createHash('sha256').update(`room-v2-ip:${source}`).digest('hex');
    const blocked = await this.prisma.roomJoinAttempt.findUnique({ where: { ipKey }, select: { blockedUntil: true } });
    if (blocked?.blockedUntil && blocked.blockedUntil > new Date()) throw new HttpException('Слишком много неверных кодов. Попробуйте через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
    const roomRecord = await this.prisma.testRoom.findUnique({ where: { joinCode: code }, select: { id: true } });
    if (!roomRecord) return this.rejectInvalidRoomCode(ipKey, ipSignalKey);
    const freshToken = token ? undefined : randomBytes(32).toString('base64url');
    const requestedHash = sessionDigest(token ?? freshToken!);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "TestRoom" WHERE "id" = ${roomRecord.id} FOR UPDATE`;
      const room = await tx.testRoom.findUnique({ where: { id: roomRecord.id }, include: { assignment: { select: { id: true, title: true } }, participants: { select: { id: true, firstName: true, lastName: true } } } });
      if (!room) throw new NotFoundException('Комната не найдена');
      const now = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
      const serverNow = now[0]?.now ?? new Date();

      if (token) {
        const participant = await tx.roomParticipant.findFirst({ where: { roomId: room.id, sessionHash: requestedHash } });
        if (!participant) throw new NotFoundException('Комната не найдена');
        await tx.roomParticipant.update({ where: { id: participant.id }, data: { lastSeenAt: serverNow } });
        const submission = await tx.submission.findFirst({ where: { roomId: room.id, participantId: participant.id }, orderBy: { attemptNo: 'desc' }, include: { answers: true } });
        if (!submission) throw new NotFoundException('Попытка не найдена');
        await tx.roomJoinAttempt.deleteMany({ where: { ipKey } });
        return { participantId: participant.id, attemptId: submission.id, roomId: room.id, status: room.status, resumed: true, studentRoom: this.studentView(room, submission) };
      }

      if (room.status === RoomStatus.FINISHED || room.status === RoomStatus.CANCELLED) throw new BadRequestException('Комната уже завершена');
      const first = firstName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const last = lastName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      if (room.status === RoomStatus.RUNNING) throw new BadRequestException('Тест уже начался. Для восстановления используйте сохранённую сессию на своём устройстве.');
      if (room.status === RoomStatus.LOBBY && room.participants.length >= room.lobbyTarget) throw new BadRequestException('Лобби заполнено');
      const participantCount = room.participants.length + 1;

      const participant = await tx.roomParticipant.create({ data: { roomId: room.id, firstName: first, lastName: last, sessionHash: requestedHash, joinedAt: serverNow, lastSeenAt: serverNow } });
      const order = { questionOrder: [], optionOrder: {} };
      const submission = await tx.submission.create({
        data: {
          assignmentId: room.assignmentId, roomId: room.id, participantId: participant.id,
          studentFirstName: first, studentLastName: last,
          studentIdentityKey: createHash('sha256').update(`room-participant:${participant.id}`).digest('hex'),
          attemptNo: 1,
          status: SubmissionStatus.WAITING,
          startedAt: serverNow,
          lastSeenAt: serverNow,
          questionOrder: order.questionOrder as Prisma.InputJsonValue,
          optionOrder: order.optionOrder as Prisma.InputJsonValue,
        }, include: { answers: true },
      });
      await tx.auditLog.create({ data: { action: 'ROOM_V2_JOINED', entityType: 'TestRoom', entityId: room.id, metadata: { participantId: participant.id }, ipAddress: ipKey } });
      await tx.roomJoinAttempt.deleteMany({ where: { ipKey } });
      return { participantId: participant.id, attemptId: submission.id, roomId: room.id, sessionToken: freshToken, status: room.status, resumed: false, studentRoom: this.studentView(room, submission, participantCount) };
    }, { maxWait: 20_000, timeout: 20_000 });
  }

  private async rejectInvalidRoomCode(ipKey: string, ipSignalKey: string): Promise<never> {
    const now = new Date();
    const state = await this.prisma.$transaction(async tx => {
      // Always acquire locks in the same order. The device+IP key can block one device,
      // while the IP aggregate is only a signal for staff and never blocks the whole school.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`room-v2-code:${ipKey}`}, 0))::text`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`room-v2-ip-signal:${ipSignalKey}`}, 0))::text`;
      const previous = await tx.roomJoinAttempt.findUnique({ where: { ipKey } });
      if (previous?.blockedUntil && previous.blockedUntil > now) return { blocked: true, failures: previous.failures, ipFailures: 0 };
      const inWindow = previous && now.getTime() - previous.windowStartedAt.getTime() < 15 * 60_000;
      const failures = inWindow ? previous.failures + 1 : 1;
      const blockedUntil = failures >= 3 ? new Date(now.getTime() + 15 * 60_000) : null;
      await tx.roomJoinAttempt.upsert({
        where: { ipKey }, create: { ipKey, failures, windowStartedAt: now, blockedUntil },
        update: { failures, windowStartedAt: inWindow ? previous.windowStartedAt : now, blockedUntil },
      });
      const ipPrevious = await tx.roomJoinAttempt.findUnique({ where: { ipKey: ipSignalKey } });
      const ipInWindow = ipPrevious && now.getTime() - ipPrevious.windowStartedAt.getTime() < 15 * 60_000;
      const ipFailures = ipInWindow ? ipPrevious.failures + 1 : 1;
      await tx.roomJoinAttempt.upsert({
        where: { ipKey: ipSignalKey },
        create: { ipKey: ipSignalKey, failures: ipFailures, windowStartedAt: now, blockedUntil: null },
        update: { failures: ipFailures, windowStartedAt: ipInWindow ? ipPrevious.windowStartedAt : now, blockedUntil: null },
      });
      if (ipFailures === 20) {
        await tx.auditLog.create({ data: { action: 'ROOM_CODE_MASS_GUESSING_FLAGGED', entityType: 'TestRoom', metadata: { ipFailures, windowMinutes: 15 }, ipAddress: ipSignalKey } });
      }
      await tx.auditLog.create({ data: { action: 'ROOM_CODE_REJECTED', entityType: 'TestRoom', metadata: { failures, blocked: !!blockedUntil, ipFailures }, ipAddress: ipSignalKey } });
      return { blocked: !!blockedUntil, failures, ipFailures };
    });
    if (state.blocked) throw new HttpException('Слишком много неверных кодов. Попробуйте через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
    throw new NotFoundException('Комната не найдена');
  }

  private studentView(room: any, submission: any, participantCount?: number) {
    const snapshot = room.snapshot as RoomSnapshot | null;
    if (!snapshot || room.status === RoomStatus.LOBBY) {
      return { room: { id: room.id, status: room.status, startedAt: room.startedAt, durationMinutes: room.durationMinutes, lobbyTarget: room.lobbyTarget, assignmentTitle: room.assignment.title, count: participantCount ?? room.participants?.length ?? room._count?.participants ?? 0 }, submission: { id: submission.id, status: submission.status, score: submission.totalScore === null || submission.totalScore === undefined ? null : Number(submission.totalScore), correctCount: submission.answers?.filter((answer: any) => answer.isCorrect === true).length ?? null, proctorWarnings: submission.proctorWarnings ?? 0, finishReason: submission.finishReason ?? null } };
    }
    const orderedQuestions = this.safeOrder(submission.questionOrder, snapshot.questions.map(question => question.sourceQuestionId));
    const optionOrder = submission.optionOrder && typeof submission.optionOrder === 'object' && !Array.isArray(submission.optionOrder)
      ? submission.optionOrder as Record<string, unknown> : {};
    const questionsById = new Map(snapshot.questions.map(question => [question.sourceQuestionId, question]));
    const questions = orderedQuestions.flatMap(questionId => {
      const question = questionsById.get(questionId);
      if (!question) return [];
      const orderedOptions = this.safeOrder(optionOrder[questionId], question.options.map(option => option.id));
      const optionsById = new Map(question.options.map(option => [option.id, option]));
      return [{
      id: question.sourceQuestionId, type: question.type, prompt: question.prompt, points: question.points, required: question.required,
      options: orderedOptions.flatMap(optionId => { const option = optionsById.get(optionId); return option ? [{ id: option.id, text: option.text }] : []; }),
      }];
    });
    return {
      room: { id: room.id, status: room.status, startedAt: room.startedAt, durationMinutes: room.durationMinutes, lobbyTarget: room.lobbyTarget, assignmentTitle: room.assignment.title, count: participantCount ?? room.participants?.length ?? room._count?.participants ?? 0 },
      submission: { id: submission.id, status: submission.status, score: submission.totalScore === null || submission.totalScore === undefined ? null : Number(submission.totalScore), correctCount: submission.answers?.filter((answer: any) => answer.isCorrect === true).length ?? null, proctorWarnings: submission.proctorWarnings ?? 0, finishReason: submission.finishReason ?? null, answers: submission.answers?.map((answer: any) => ({ questionId: answer.questionId, textValue: answer.textValue, numericValue: answer.numericValue, jsonValue: answer.jsonValue })) ?? [] },
      questions,
    };
  }

  private safeOrder(value: unknown, validIds: string[]) {
    if (!Array.isArray(value)) return validIds;
    const filtered = value.filter((id): id is string => typeof id === 'string' && validIds.includes(id));
    if (filtered.length !== validIds.length || new Set(filtered).size !== validIds.length) return validIds;
    return filtered;
  }

  async getStudentRoom(roomId: string, token: string) {
    if (!token || token.length > 128) throw new NotFoundException('Комната не найдена');
    const participant = await this.prisma.roomParticipant.findFirst({
      where: { roomId, sessionHash: sessionDigest(token) },
      include: { room: { include: { assignment: { select: { title: true } }, _count: { select: { participants: true } } } } },
    });
    if (!participant) throw new NotFoundException('Комната не найдена');
    const submission = await this.prisma.submission.findFirst({ where: { roomId, participantId: participant.id }, orderBy: { attemptNo: 'desc' }, include: { answers: true } });
    if (!submission) throw new NotFoundException('Попытка не найдена');
    return this.studentView(participant.room, submission);
  }

  private normalizeRoomAnswer(question: SnapshotQuestion, value: unknown): string | string[] {
    const options = new Set(question.options.map(option => option.id));
    if (question.type === 'SINGLE_CHOICE') {
      if (typeof value !== 'string' || !options.has(value)) throw new BadRequestException('Ответ содержит недопустимый вариант');
      return value;
    }
    if (!Array.isArray(value) || value.length > question.options.length || value.some(item => typeof item !== 'string' || !options.has(item)) || new Set(value).size !== value.length) {
      throw new BadRequestException('Ответ содержит недопустимые варианты');
    }
    return value as string[];
  }

  async saveRoomAnswers(roomId: string, token: string, dto: SaveRoomAnswersDto) {
    const tokenHash = sessionDigest(token);
    return this.prisma.$transaction(async tx => {
      const participant = await tx.roomParticipant.findFirst({ where: { roomId, sessionHash: tokenHash }, select: { id: true } });
      if (!participant) throw new NotFoundException('Комната не найдена');
      const submission = await tx.submission.findFirst({ where: { roomId, participantId: participant.id }, orderBy: { attemptNo: 'desc' }, select: { id: true, status: true } });
      if (!submission || submission.status !== SubmissionStatus.IN_PROGRESS) throw new NotFoundException('Активная попытка не найдена');
      await tx.$queryRaw`SELECT "id" FROM "Submission" WHERE "id" = ${submission.id} FOR UPDATE`;
      const room = await tx.testRoom.findUnique({ where: { id: roomId }, select: { status: true, startedAt: true, durationMinutes: true, snapshot: true } });
      if (!room || room.status !== RoomStatus.RUNNING) throw new BadRequestException('Тест уже завершён');
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
      const now = nowRows[0]?.now ?? new Date();
      const expired = !!room.startedAt && room.durationMinutes !== null && now.getTime() >= room.startedAt.getTime() + room.durationMinutes * 60_000;
      if (expired) {
        await this.finalizeRoomAttempt(tx, roomId, submission.id, room.snapshot as RoomSnapshot, now, 'TIME_LIMIT');
        return { saved: 0, finished: true, savedAt: now };
      }
      const snapshot = room.snapshot as RoomSnapshot | null;
      if (!snapshot) throw new BadRequestException('Снимок теста недоступен');
      if (new Set(dto.answers.map(answer => answer.questionId)).size !== dto.answers.length) throw new BadRequestException('Нельзя отправить два ответа на один вопрос');
      const questionMap = new Map(snapshot.questions.map(question => [question.sourceQuestionId, question]));
      for (const answer of dto.answers) {
        const question = questionMap.get(answer.questionId);
        if (!question) throw new BadRequestException('Ответ содержит неизвестный вопрос');
        const value = this.normalizeRoomAnswer(question, answer.value);
        await tx.answer.upsert({
          where: { submissionId_questionId: { submissionId: submission.id, questionId: answer.questionId } },
          create: { submissionId: submission.id, questionId: answer.questionId, jsonValue: value as Prisma.InputJsonValue },
          update: { jsonValue: value as Prisma.InputJsonValue, isCorrect: null, awardedPoints: null },
        });
      }
      await tx.roomParticipant.update({ where: { id: participant.id }, data: { lastSeenAt: now } });
      return { saved: dto.answers.length, finished: false, savedAt: now };
    }, { maxWait: 20_000, timeout: 20_000 });
  }

  private async finalizeRoomAttempt(tx: Prisma.TransactionClient, roomId: string, submissionId: string, snapshot: RoomSnapshot | null, submittedAt: Date, finishReason = 'STUDENT_SUBMITTED') {
    if (!snapshot) throw new BadRequestException('Снимок теста недоступен');
    const submission = await tx.submission.findFirst({ where: { id: submissionId, roomId, status: SubmissionStatus.IN_PROGRESS }, include: { answers: true } });
    if (!submission) throw new NotFoundException('Активная попытка не найдена');
    const saved = new Map(submission.answers.map(answer => [answer.questionId, answer]));
    let score = 0; let correctCount = 0;
    for (const question of snapshot.questions) {
      const answer = saved.get(question.sourceQuestionId);
      const selectedValue = answer?.jsonValue;
      const selected = question.type === 'SINGLE_CHOICE'
        ? (typeof selectedValue === 'string' ? [selectedValue] : [])
        : (Array.isArray(selectedValue) ? selectedValue.filter((id): id is string => typeof id === 'string') : []);
      const correct = question.options.filter(option => option.isCorrect).map(option => option.id).sort();
      const same = selected.length === correct.length && [...selected].sort().every((id, index) => id === correct[index]);
      const points = same ? question.points : 0;
      if (same) correctCount++;
      score += points;
      await tx.answer.upsert({
        where: { submissionId_questionId: { submissionId, questionId: question.sourceQuestionId } },
        create: { submissionId, questionId: question.sourceQuestionId, jsonValue: Prisma.DbNull, isCorrect: same, awardedPoints: points },
        update: { isCorrect: same, awardedPoints: points },
      });
    }
    await tx.submission.update({ where: { id: submissionId }, data: { status: SubmissionStatus.GRADED, submittedAt, gradedAt: submittedAt, totalScore: Math.round(score * 100) / 100, finishReason } });
    await enqueueResultExport(tx, submissionId);
    const remaining = await tx.submission.count({ where: { roomId, status: SubmissionStatus.IN_PROGRESS } });
    if (remaining === 0) await tx.testRoom.update({ where: { id: roomId }, data: { status: RoomStatus.FINISHED, finishedAt: submittedAt } });
    return { score: Math.round(score * 100) / 100, correctCount, totalQuestions: snapshot.questions.length, submittedAt };
  }

  async recordRoomProctorEvent(roomId: string, token: string, dto: RoomProctorEventDto) {
    const tokenHash = sessionDigest(token);
    return this.prisma.$transaction(async tx => {
      const participant = await tx.roomParticipant.findFirst({ where: { roomId, sessionHash: tokenHash }, select: { id: true } });
      if (!participant) throw new NotFoundException('Комната не найдена');
      const attempt = await tx.submission.findFirst({ where: { roomId, participantId: participant.id }, orderBy: { attemptNo: 'desc' }, select: { id: true } });
      if (!attempt) throw new NotFoundException('Попытка не найдена');
      await tx.$queryRaw`SELECT "id" FROM "Submission" WHERE "id" = ${attempt.id} FOR UPDATE`;
      const current = await tx.submission.findFirst({ where: { id: attempt.id, roomId }, select: { id: true, status: true, proctorWarnings: true } });
      if (!current || current.status !== SubmissionStatus.IN_PROGRESS) return { warnings: current?.proctorWarnings ?? 0, finished: current?.status === SubmissionStatus.GRADED };
      const room = await tx.testRoom.findUnique({ where: { id: roomId }, select: { status: true, snapshot: true, startedAt: true, durationMinutes: true } });
      if (!room || room.status !== RoomStatus.RUNNING) throw new BadRequestException('Тест уже завершён');
      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
      const authoritativeNow = clockRows[0]?.now ?? new Date();
      const deadlinePassed = !!room.startedAt && room.durationMinutes !== null
        && authoritativeNow.getTime() >= room.startedAt.getTime() + room.durationMinutes * 60_000;
      if (deadlinePassed) {
        const result = await this.finalizeRoomAttempt(tx, roomId, current.id, room.snapshot as RoomSnapshot | null, authoritativeNow, 'TIME_LIMIT');
        return { warnings: current.proctorWarnings, finished: true, ...result };
      }
      const episode = dto.eventType.startsWith('VISIBILITY_') ? 'VISIBILITY' : 'SCREEN_SHARE';
      const violationEvent = episode === 'VISIBILITY' ? 'VISIBILITY_HIDDEN' : 'SCREEN_SHARE_ENDED';
      const restoreEvent = episode === 'VISIBILITY' ? 'VISIBILITY_RESTORED' : 'SCREEN_SHARE_RESTORED';
      const latestInEpisode = await tx.proctorEvent.findFirst({
        where: { submissionId: current.id, eventType: { in: episode === 'VISIBILITY' ? ['VISIBILITY_HIDDEN', 'VISIBILITY_RESTORED'] : ['SCREEN_SHARE_ENDED', 'SCREEN_SHARE_RESTORED'] } },
        orderBy: { createdAt: 'desc' },
        select: { eventType: true },
      });
      if (dto.eventType === restoreEvent) {
        if (latestInEpisode?.eventType === violationEvent) {
          await tx.proctorEvent.create({ data: { submissionId: current.id, eventType: dto.eventType } });
        }
        return { warnings: current.proctorWarnings, finished: false };
      }
      if (latestInEpisode?.eventType === violationEvent) {
        return { warnings: current.proctorWarnings, finished: false, duplicate: true };
      }
      const warnings = current.proctorWarnings + 1;
      await tx.proctorEvent.create({ data: { submissionId: current.id, eventType: dto.eventType } });
      await tx.submission.update({ where: { id: current.id }, data: { proctorWarnings: warnings } });
      let result: any = null;
      if (warnings >= 3) result = await this.finalizeRoomAttempt(tx, roomId, current.id, room.snapshot as RoomSnapshot | null, authoritativeNow, 'PROCTORING_VIOLATION_LIMIT');
      await tx.auditLog.create({ data: { action: warnings >= 3 ? 'ROOM_PROCTOR_LIMIT_REACHED' : 'ROOM_PROCTOR_WARNING', entityType: 'Submission', entityId: current.id, metadata: { roomId, warnings, eventType: dto.eventType } } });
      return { warnings, finished: warnings >= 3, ...(result ?? {}) };
    }, { maxWait: 20_000, timeout: 20_000 });
  }

  async submitRoom(roomId: string, token: string) {
    const tokenHash = sessionDigest(token);
    const result = await this.prisma.$transaction(async tx => {
      const participant = await tx.roomParticipant.findFirst({ where: { roomId, sessionHash: tokenHash }, select: { id: true } });
      if (!participant) throw new NotFoundException('Комната не найдена');
      const submission = await tx.submission.findFirst({ where: { roomId, participantId: participant.id }, orderBy: { attemptNo: 'desc' }, select: { id: true, status: true } });
      if (!submission) throw new NotFoundException('Попытка не найдена');
      if (submission.status === SubmissionStatus.GRADED) return { submissionId: submission.id, alreadySubmitted: true };
      if (submission.status !== SubmissionStatus.IN_PROGRESS) throw new BadRequestException('Тест ещё не запущен');
      await tx.$queryRaw`SELECT "id" FROM "Submission" WHERE "id" = ${submission.id} FOR UPDATE`;
      const room = await tx.testRoom.findUnique({ where: { id: roomId }, select: { status: true, startedAt: true, durationMinutes: true, snapshot: true } });
      if (!room || room.status !== RoomStatus.RUNNING) throw new BadRequestException('Тест уже завершён');
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
      const now = nowRows[0]?.now ?? new Date();
      const expired = !!room.startedAt && room.durationMinutes !== null && now.getTime() >= room.startedAt.getTime() + room.durationMinutes * 60_000;
      const result = await this.finalizeRoomAttempt(tx, roomId, submission.id, room.snapshot as RoomSnapshot, now, expired ? 'TIME_LIMIT' : 'STUDENT_SUBMITTED');
      return { submissionId: submission.id, alreadySubmitted: false, ...result };
    }, { maxWait: 20_000, timeout: 20_000 });
    const rows = await this.prisma.submission.findMany({ where: { roomId, status: SubmissionStatus.GRADED, totalScore: { not: null } }, orderBy: [{ totalScore: 'desc' }, { submittedAt: 'asc' }], select: { id: true, studentFirstName: true, studentLastName: true, totalScore: true, submittedAt: true } });
    const rank = rows.findIndex(row => row.id === result.submissionId);
    return { ...result, rank: rank < 0 ? null : rank + 1, top: rows.slice(0, 10).map((row, index) => ({ rank: index + 1, firstName: row.studentFirstName, lastName: row.studentLastName, score: Number(row.totalScore) })) };
  }
}

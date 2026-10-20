import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, OnModuleInit, OnModuleDestroy,
} from '@nestjs/common';
import { AssignmentStatus, Prisma, QuestionType, SubmissionStatus, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  CreateAssignmentDto, GradeSubmissionDto, SubmitAnswersDto,
} from './assignments.dto';
import { enqueueResultExport } from './results-outbox.service';

const AUTO_GRADED = new Set<QuestionType>([
  QuestionType.SINGLE_CHOICE,
  QuestionType.MULTIPLE_CHOICE,
  QuestionType.NUMERIC,
]);
const TEXT_QUESTIONS = new Set<QuestionType>([QuestionType.SHORT_TEXT, QuestionType.LONG_TEXT]);
const MAX_TOTAL_POINTS = 999999.99;
const ROOM_HEARTBEAT_TTL_MS = 20_000;

function roundedScore(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class AssignmentsService implements OnModuleInit, OnModuleDestroy {
  private deadlineTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.deadlineTimer = setInterval(() => { void this.finishElapsedAttempts(); }, 5000).unref();
  }
  onModuleDestroy() { if (this.deadlineTimer) clearInterval(this.deadlineTimer); }
  async finishElapsedAttempts() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; assignmentId: string }>>`
        SELECT s.id, s."assignmentId" FROM "Submission" s JOIN "Assignment" a ON a.id = s."assignmentId"
        WHERE s.status = 'IN_PROGRESS'::"SubmissionStatus" AND
          ((a."timeLimitMinutes" IS NOT NULL AND s."startedAt" + a."timeLimitMinutes" * INTERVAL '1 minute' <= NOW()) OR a."dueAt" <= NOW())
        ORDER BY s."startedAt" LIMIT 100`;
      for (let offset = 0; offset < rows.length; offset += 5) await Promise.all(rows.slice(offset, offset + 5).map(row => this.finalize(row.assignmentId, row.id, { answers: [] }).catch(error => {
        if (!(error instanceof NotFoundException)) console.error('Deadline finalization failed; retrying on next sweep');
      })));
    } catch { console.error('Deadline sweep unavailable; retrying in 5 seconds'); }
    finally { this.sweeping = false; }
  }

  private requireStaff(user: AuthenticatedUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.TEACHER) {
      throw new ForbiddenException('Доступ только для преподавателя');
    }
  }

  private requireStudent(user: AuthenticatedUser) {
    if (user.role !== UserRole.STUDENT || !user.firstName || !user.lastName ||
        (!user.studentProfileId && user.kind !== 'shared_student')) {
      throw new ForbiddenException('Войдите по общему коду школы, имени и фамилии');
    }
  }

  private studentIdentityKey(user: AuthenticatedUser) {
    return createHash('sha256').update(`student:${user.sub}`).digest('hex');
  }

  private shuffledIds(ids: string[], shouldShuffle: boolean) {
    const result = [...ids];
    if (!shouldShuffle) return result;
    for (let i = result.length - 1; i > 0; i--) {
      const j = randomBytes(4).readUInt32BE(0) % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  private attemptOrder(assignment: { questions: Array<{ id: string; options: Array<{ id: string }> }>; shuffleQuestions: boolean; shuffleOptions: boolean }) {
    const questionOrder = this.shuffledIds(assignment.questions.map(question => question.id), assignment.shuffleQuestions);
    const optionOrder: Record<string, string[]> = {};
    for (const question of assignment.questions) {
      optionOrder[question.id] = this.shuffledIds(question.options.map(option => option.id), assignment.shuffleOptions);
    }
    return { questionOrder, optionOrder };
  }

  private studentAssignmentPayload(assignment: any, submission: any) {
    const order = Array.isArray(submission.questionOrder) ? submission.questionOrder.filter((id: unknown): id is string => typeof id === 'string') : [];
    const optionOrder = submission.optionOrder && typeof submission.optionOrder === 'object' ? submission.optionOrder as Record<string, unknown> : {};
    const questionIndex = new Map<string, number>(order.map((id: string, index: number) => [id, index]));
    const questions = [...assignment.questions].sort((a: any, b: any) =>
      (questionIndex.get(a.id) ?? a.position - 1) - (questionIndex.get(b.id) ?? b.position - 1));
    const savedAnswers = (submission.answers ?? []).map((answer: any) => ({
      questionId: answer.questionId,
      textValue: answer.textValue,
      numericValue: answer.numericValue === null ? null : Number(answer.numericValue),
      jsonValue: answer.jsonValue,
    }));
    return {
      submission: { id: submission.id, status: submission.status, attemptNo: submission.attemptNo, startedAt: submission.startedAt },
      assignment: {
        id: assignment.id, title: assignment.title, description: assignment.description,
        timeLimitMinutes: assignment.timeLimitMinutes, dueAt: assignment.dueAt, totalPoints: assignment.totalPoints,
        questions: questions.map((question: any) => {
          const ids = Array.isArray(optionOrder[question.id]) ? optionOrder[question.id] as string[] : [];
          const optionIndex = new Map<string, number>(ids.map((id, index) => [id, index]));
          return {
            id: question.id, type: question.type, prompt: question.prompt, position: question.position, points: question.points, required: question.required,
            options: [...question.options].sort((a: any, b: any) => (optionIndex.get(a.id) ?? a.position - 1) - (optionIndex.get(b.id) ?? b.position - 1))
              .map((option: any) => ({ id: option.id, text: option.text, position: option.position })),
          };
        }),
      },
      answers: savedAnswers,
    };
  }

  private staffScope(user: AuthenticatedUser): Prisma.AssignmentWhereInput {
    return user.role === UserRole.ADMIN ? {} : { creatorId: user.sub };
  }

  private async studentScope(user: AuthenticatedUser): Promise<Prisma.AssignmentWhereInput> {
    const profile = user.studentProfileId
      ? await this.prisma.studentProfile.findUnique({ where: { id: user.studentProfileId }, select: { classId: true } })
      : null;
    return profile?.classId ? { OR: [{ classId: null }, { classId: profile.classId }] } : { classId: null };
  }

  async listForStaff(user: AuthenticatedUser) {
    this.requireStaff(user);
    const assignments = await this.prisma.assignment.findMany({
      where: this.staffScope(user),
      orderBy: { updatedAt: 'desc' },
      include: {
        subject: true,
        questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } },
        _count: { select: { submissions: true } },
      },
    });
    if (!assignments.length) return assignments;
    const waiting = await this.prisma.submission.groupBy({
      by: ['assignmentId'], where: { assignmentId: { in: assignments.map(item => item.id) }, status: SubmissionStatus.WAITING, lastSeenAt: { gte: new Date(Date.now() - ROOM_HEARTBEAT_TTL_MS) } },
      _count: { assignmentId: true },
    });
    const counts = new Map(waiting.map(item => [item.assignmentId, item._count.assignmentId]));
    return assignments.map(item => ({ ...item, waitingCount: counts.get(item.id) ?? 0 }));
  }

  async roomSummaries(user: AuthenticatedUser) {
    this.requireStaff(user);
    const assignments = await this.prisma.assignment.findMany({
      where: { ...this.staffScope(user), lobbyTarget: { not: null } },
      select: { id: true, roomStartedAt: true },
    });
    if (!assignments.length) return [];
    const waiting = await this.prisma.submission.groupBy({
      by: ['assignmentId'],
      where: {
        assignmentId: { in: assignments.map(item => item.id) },
        status: SubmissionStatus.WAITING,
        lastSeenAt: { gte: new Date(Date.now() - ROOM_HEARTBEAT_TTL_MS) },
      },
      _count: { assignmentId: true },
    });
    const counts = new Map(waiting.map(item => [item.assignmentId, item._count.assignmentId]));
    return assignments.map(item => ({ id: item.id, roomStartedAt: item.roomStartedAt, waitingCount: counts.get(item.id) ?? 0 }));
  }

  async create(dto: CreateAssignmentDto, user: AuthenticatedUser) {
    this.requireStaff(user);
    const subjectName = dto.subjectName.trim();
    if (!subjectName || !dto.title.trim()) throw new BadRequestException('Введите предмет и название задания');
    const availableFrom = dto.availableFrom ? new Date(dto.availableFrom) : null;
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
    if (availableFrom && dueAt && dueAt <= availableFrom) throw new BadRequestException('Срок сдачи должен быть позже даты открытия задания');
    const questions = dto.questions.map((q, position) => {
      if (!AUTO_GRADED.has(q.type) && !TEXT_QUESTIONS.has(q.type)) throw new BadRequestException('Этот тип вопроса пока не поддерживается');
      if (!q.prompt.trim() || q.options?.some(o => !o.text.trim())) throw new BadRequestException('Текст вопроса и вариантов не может быть пустым');
      const points = TEXT_QUESTIONS.has(q.type) ? 0 : q.points ?? 1;
      if (!Number.isFinite(points) || points < (TEXT_QUESTIONS.has(q.type) ? 0 : 0.01) || points > 10000 || Math.abs(points - roundedScore(points)) > 1e-8) {
        throw new BadRequestException('Укажите баллы от 0.01 до 10000, не более двух знаков после запятой');
      }
      if ((q.type === QuestionType.SINGLE_CHOICE || q.type === QuestionType.MULTIPLE_CHOICE) &&
          (!q.options || q.options.length < 2)) {
        throw new BadRequestException('Для вопросов с выбором нужно минимум два варианта');
      }
      if (q.type === QuestionType.SINGLE_CHOICE && q.options?.filter(o => o.isCorrect).length !== 1) {
        throw new BadRequestException('В вопросе с одним вариантом должен быть ровно один правильный ответ');
      }
      if (q.type === QuestionType.MULTIPLE_CHOICE && !q.options?.some(o => o.isCorrect)) {
        throw new BadRequestException('Отметьте хотя бы один правильный вариант');
      }
      if (q.type === QuestionType.NUMERIC &&
          (typeof q.config?.correctValue !== 'number' || !Number.isFinite(q.config.correctValue))) {
        throw new BadRequestException('Для числового вопроса укажите правильное число в config.correctValue');
      }
      if (q.type === QuestionType.NUMERIC && (Math.abs(q.config!.correctValue as number) > 9999999999.9999 ||
          Math.abs((q.config!.correctValue as number) - Math.round((q.config!.correctValue as number) * 10000) / 10000) > 1e-10)) {
        throw new BadRequestException('Числовой ответ должен быть в пределах 9999999999.9999 и иметь не более четырёх знаков после запятой');
      }
      if (q.type === QuestionType.NUMERIC && q.config?.tolerance !== undefined &&
          (typeof q.config.tolerance !== 'number' || !Number.isFinite(q.config.tolerance) || q.config.tolerance < 0)) {
        throw new BadRequestException('Погрешность должна быть конечным неотрицательным числом');
      }
      const hasChoices = q.type === QuestionType.SINGLE_CHOICE || q.type === QuestionType.MULTIPLE_CHOICE;
      if (!hasChoices && q.options?.length) throw new BadRequestException('Варианты ответа допустимы только для вопросов с выбором');
      return {
        type: q.type,
        prompt: q.prompt.trim(),
        position: position + 1,
        points,
        required: q.required ?? true,
        config: q.type === QuestionType.NUMERIC
          ? { correctValue: q.config!.correctValue, tolerance: q.config!.tolerance ?? 0 } as Prisma.InputJsonValue
          : undefined,
        options: q.options?.length ? {
          create: q.options.map((o, optionPosition) => ({
            text: o.text.trim(), position: optionPosition + 1, isCorrect: !!o.isCorrect,
          })),
        } : undefined,
      };
    });
    const totalPoints = roundedScore(questions.reduce((sum, q) => sum + q.points, 0));
    if (totalPoints > MAX_TOTAL_POINTS) throw new BadRequestException('Сумма баллов не может превышать 999999.99');
    return this.prisma.$transaction(async tx => {
      if (dto.classId && !(await tx.schoolClass.findUnique({ where: { id: dto.classId }, select: { id: true } }))) {
        throw new BadRequestException('Класс не найден');
      }
      const subject = await tx.subject.upsert({ where: { name: subjectName }, update: {}, create: { name: subjectName } });
      return tx.assignment.create({
        data: {
          title: dto.title.trim(),
          description: dto.description?.trim(),
          creatorId: user.sub,
          subjectId: subject.id,
          classId: dto.classId || null,
          timeLimitMinutes: dto.timeLimitMinutes ?? null,
          availableFrom,
          dueAt,
          maxAttempts: dto.maxAttempts ?? 1,
          joinCode: randomBytes(6).toString('hex').toUpperCase(),
          lobbyTarget: dto.lobbyTarget ?? null,
          shuffleQuestions: dto.shuffleQuestions ?? true,
          shuffleOptions: dto.shuffleOptions ?? true,
          totalPoints,
          questions: { create: questions },
        },
        include: { subject: true, questions: { orderBy: { position: 'asc' }, include: { options: true } } },
      });
    });
  }

  async publish(id: string, user: AuthenticatedUser) {
    this.requireStaff(user);
    const assignment = await this.prisma.assignment.findFirst({ where: { id, ...this.staffScope(user) }, include: { questions: true } });
    if (!assignment) throw new NotFoundException('Задание не найдено');
    if (!assignment.questions.length) throw new BadRequestException('Нельзя опубликовать задание без вопросов');
    return this.prisma.assignment.update({ where: { id }, data: { status: AssignmentStatus.PUBLISHED } });
  }

  async delete(id: string, user: AuthenticatedUser) {
    if (user.role !== UserRole.ADMIN) throw new ForbiddenException('Удалять тесты может только администратор');
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${id} FOR UPDATE`;
      const assignment = await tx.assignment.findUnique({ where: { id }, select: { id: true } });
      if (!assignment) throw new NotFoundException('Задание не найдено');
      await tx.submission.deleteMany({ where: { assignmentId: id } });
      await tx.assignment.delete({ where: { id } });
    });
    return { message: 'Тест и все его попытки удалены' };
  }

  async listAvailable(user: AuthenticatedUser) {
    this.requireStudent(user);
    const now = new Date();
    return this.prisma.assignment.findMany({
      where: {
        ...await this.studentScope(user),
        status: AssignmentStatus.PUBLISHED,
        AND: [
          { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
          { OR: [{ dueAt: null }, { dueAt: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, description: true, timeLimitMinutes: true, maxAttempts: true,
        availableFrom: true, dueAt: true, totalPoints: true, subject: { select: { name: true } },
        _count: { select: { questions: true } },
      },
    });
  }

  async start(id: string, user: AuthenticatedUser, code?: string, ipAddress = 'unknown') {
    this.requireStudent(user);
    if (!code) throw new BadRequestException('Для входа в комнату нужен код теста');
    return this.joinRoom(code, ipAddress, user, id);
  }

  private async rejectRoomCode(ipKey: string, actorId: string | null, now = new Date()) {
    const state = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`room-code:${ipKey}`}, 0))::text`;
      const previous = await tx.roomJoinAttempt.findUnique({ where: { ipKey } });
      if (previous?.blockedUntil && previous.blockedUntil > now) {
        await tx.auditLog.create({ data: { actorId, action: 'ROOM_CODE_REJECTED', entityType: 'AssignmentRoom', metadata: { blocked: true }, ipAddress: ipKey } });
        return { blocked: true, failures: previous.failures };
      }
      const withinWindow = previous && now.getTime() - previous.windowStartedAt.getTime() < 15 * 60_000;
      const failures = withinWindow ? previous.failures + 1 : 1;
      const blockedUntil = failures >= 3 ? new Date(now.getTime() + 15 * 60_000) : null;
      await tx.roomJoinAttempt.upsert({
        where: { ipKey },
        create: { ipKey, failures, windowStartedAt: now, blockedUntil },
        update: { failures, windowStartedAt: withinWindow ? previous.windowStartedAt : now, blockedUntil },
      });
      await tx.auditLog.create({ data: { actorId, action: 'ROOM_CODE_REJECTED', entityType: 'AssignmentRoom', metadata: { failures, blocked: !!blockedUntil }, ipAddress: ipKey } });
      return { blocked: !!blockedUntil, failures };
    });
    if (state.blocked) throw new HttpException('Слишком много неверных кодов. Попробуйте через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
    throw new BadRequestException('Код комнаты не найден или тест недоступен');
  }

  async joinRoom(code: string, ipAddress: string, user: AuthenticatedUser, expectedAssignmentId?: string) {
    this.requireStudent(user);
    const normalizedCode = code.trim().toUpperCase();
    const normalizedIp = String(ipAddress || 'unknown').trim().slice(0, 128) || 'unknown';
    const identityKey = this.studentIdentityKey(user);
    const ipKey = createHash('sha256').update(`room-ip:${normalizedIp}:${identityKey}`).digest('hex');
    const now = new Date();
    const blocked = await this.prisma.roomJoinAttempt.findUnique({ where: { ipKey }, select: { blockedUntil: true } });
    if (blocked?.blockedUntil && blocked.blockedUntil > now) throw new HttpException('Слишком много неверных кодов. Попробуйте через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
    const scope = await this.studentScope(user);
    const assignment = /^[A-Z0-9]{6,16}$/u.test(normalizedCode)
      ? await this.prisma.assignment.findFirst({
        where: { joinCode: normalizedCode, ...scope, ...(expectedAssignmentId ? { id: expectedAssignmentId } : {}), status: AssignmentStatus.PUBLISHED },
        include: { questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } } },
      })
      : null;
    if (!assignment) return this.rejectRoomCode(ipKey, user.studentProfileId ? user.sub : null, now);
    if (assignment.availableFrom && assignment.availableFrom > now) throw new BadRequestException('Задание ещё недоступно');
    if (assignment.dueAt && assignment.dueAt < now) throw new BadRequestException('Срок выполнения задания истёк');

    const joined = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attempt:${assignment.id}:${identityKey}`}, 0))::text`;
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${assignment.id} FOR KEY SHARE`;
      const active = await tx.submission.findFirst({
        where: { assignmentId: assignment.id, studentIdentityKey: identityKey, status: { in: [SubmissionStatus.WAITING, SubmissionStatus.IN_PROGRESS] } },
        orderBy: { attemptNo: 'desc' }, include: { answers: true },
      });
      const waiting = !!assignment.lobbyTarget && !assignment.roomStartedAt;
      if (!active && assignment.lobbyTarget && assignment.roomStartedAt) throw new BadRequestException('Комната уже запущена, вход закрыт');
      if (!active && waiting) {
        const waitingCount = await tx.submission.count({ where: { assignmentId: assignment.id, status: SubmissionStatus.WAITING, lastSeenAt: { gte: new Date(now.getTime() - ROOM_HEARTBEAT_TTL_MS) } } });
        if (waitingCount >= assignment.lobbyTarget!) throw new BadRequestException('Лобби уже заполнено');
      }
      const previous = await tx.submission.count({ where: { assignmentId: assignment.id, studentIdentityKey: identityKey } });
      if (!active && previous >= assignment.maxAttempts) throw new BadRequestException('Вы использовали все попытки для этого задания');
      const firstName = user.firstName!.trim().normalize('NFKC');
      const lastName = user.lastName!.trim().normalize('NFKC');
      const questionOrder = this.attemptOrder(assignment);
      const submission = active ?? await tx.submission.create({
        data: {
          assignmentId: assignment.id, studentId: user.studentProfileId ?? null,
          studentFirstName: firstName, studentLastName: lastName, studentIdentityKey: identityKey,
          attemptNo: previous + 1, status: waiting ? SubmissionStatus.WAITING : SubmissionStatus.IN_PROGRESS,
          startedAt: now,
          lastSeenAt: now,
          questionOrder: questionOrder.questionOrder,
          optionOrder: questionOrder.optionOrder as Prisma.InputJsonValue,
        },
        include: { answers: true },
      });
      if (active?.status === SubmissionStatus.WAITING) await tx.submission.update({ where: { id: active.id }, data: { lastSeenAt: now } });
      await tx.roomJoinAttempt.deleteMany({ where: { ipKey } });
      await tx.auditLog.create({ data: { actorId: user.kind === 'shared_student' ? null : user.sub, action: 'ROOM_JOINED', entityType: 'AssignmentRoom', entityId: assignment.id, metadata: { waiting: submission.status === SubmissionStatus.WAITING }, ipAddress: ipKey } });
      return { submission, waitingCount: submission.status === SubmissionStatus.WAITING
        ? await tx.submission.count({ where: { assignmentId: assignment.id, status: SubmissionStatus.WAITING, lastSeenAt: { gte: new Date(now.getTime() - ROOM_HEARTBEAT_TTL_MS) } } }) : undefined };
    });
    if (joined.submission.status === SubmissionStatus.WAITING) {
      return { ...this.studentAssignmentPayload(assignment, joined.submission), room: { waiting: true, count: joined.waitingCount, target: assignment.lobbyTarget } };
    }
    return { ...this.studentAssignmentPayload(assignment, joined.submission), room: { waiting: false, target: assignment.lobbyTarget } };
  }

  async roomStatus(submissionId: string, user: AuthenticatedUser) {
    this.requireStudent(user);
    const submission = await this.prisma.submission.findFirst({
      where: { id: submissionId, studentIdentityKey: this.studentIdentityKey(user) },
      select: {
        id: true, status: true, attemptNo: true, startedAt: true, assignmentId: true,
        assignment: { select: { id: true, title: true, timeLimitMinutes: true, lobbyTarget: true } },
      },
    });
    if (!submission) throw new NotFoundException('Попытка не найдена');
    if (submission.status === SubmissionStatus.WAITING) {
      const now = new Date();
      await this.prisma.submission.updateMany({ where: { id: submission.id, status: SubmissionStatus.WAITING }, data: { lastSeenAt: now } });
      const count = await this.prisma.submission.count({ where: { assignmentId: submission.assignmentId, status: SubmissionStatus.WAITING, lastSeenAt: { gte: new Date(now.getTime() - ROOM_HEARTBEAT_TTL_MS) } } });
      return { submission: { id: submission.id, status: submission.status, attemptNo: submission.attemptNo, startedAt: submission.startedAt }, assignment: { id: submission.assignment.id, title: submission.assignment.title, timeLimitMinutes: submission.assignment.timeLimitMinutes, questions: [] }, answers: [], room: { waiting: true, count, target: submission.assignment.lobbyTarget } };
    }
    const activeSubmission = await this.prisma.submission.findFirst({
      where: { id: submission.id, studentIdentityKey: this.studentIdentityKey(user) },
      include: { assignment: { include: { questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } } } }, answers: true },
    });
    if (!activeSubmission) throw new NotFoundException('Попытка не найдена');
    return { ...this.studentAssignmentPayload(activeSubmission.assignment, activeSubmission), room: { waiting: false, target: activeSubmission.assignment.lobbyTarget } };
  }

  async startRoom(id: string, user: AuthenticatedUser) {
    this.requireStaff(user);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${id} FOR UPDATE`;
      const assignment = await tx.assignment.findFirst({ where: { id, ...this.staffScope(user) }, select: { id: true, lobbyTarget: true, status: true } });
      if (!assignment) throw new NotFoundException('Задание не найдено');
      if (assignment.status !== AssignmentStatus.PUBLISHED || !assignment.lobbyTarget) throw new BadRequestException('Для этого задания лобби не настроено');
      const cutoff = new Date(Date.now() - ROOM_HEARTBEAT_TTL_MS);
      const count = await tx.submission.count({ where: { assignmentId: id, status: SubmissionStatus.WAITING, lastSeenAt: { gte: cutoff } } });
      if (count < assignment.lobbyTarget) throw new BadRequestException(`В лобби ${count} из ${assignment.lobbyTarget} учеников`);
      const startedAt = new Date();
      await tx.submission.deleteMany({ where: { assignmentId: id, status: SubmissionStatus.WAITING, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] } });
      const result = await tx.submission.updateMany({ where: { assignmentId: id, status: SubmissionStatus.WAITING, lastSeenAt: { gte: cutoff } }, data: { status: SubmissionStatus.IN_PROGRESS, startedAt } });
      if (result.count < assignment.lobbyTarget) throw new BadRequestException(`В лобби ${result.count} из ${assignment.lobbyTarget} учеников`);
      await tx.assignment.update({ where: { id }, data: { roomStartedAt: startedAt } });
      await tx.auditLog.create({ data: { actorId: user.sub, action: 'ROOM_STARTED', entityType: 'AssignmentRoom', entityId: id, metadata: { students: result.count } } });
      return { startedAt, students: result.count };
    });
  }

  async saveAnswers(submissionId: string, dto: SubmitAnswersDto, user: AuthenticatedUser) {
    this.requireStudent(user);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
      const submission = await tx.submission.findFirst({
        where: { id: submissionId, studentIdentityKey: this.studentIdentityKey(user), status: SubmissionStatus.IN_PROGRESS },
        include: { assignment: { include: { questions: { include: { options: true } } } } },
      });
      if (!submission) throw new NotFoundException('Активная попытка не найдена');
      const elapsed = Date.now() - submission.startedAt.getTime();
      if ((submission.assignment.timeLimitMinutes !== null && elapsed >= submission.assignment.timeLimitMinutes * 60_000) ||
          (submission.assignment.dueAt !== null && submission.assignment.dueAt.getTime() < Date.now())) {
        throw new BadRequestException('Время теста вышло');
      }
      if (new Set(dto.answers.map(answer => answer.questionId)).size !== dto.answers.length) throw new BadRequestException('Нельзя отправить несколько ответов на один вопрос');
      const questions = new Map(submission.assignment.questions.map(question => [question.id, question]));
      for (const answer of dto.answers) {
        const question = questions.get(answer.questionId);
        if (!question) throw new BadRequestException('Ответ содержит неизвестный вопрос');
        this.validateAnswer(question, answer);
        await tx.answer.upsert({
          where: { submissionId_questionId: { submissionId, questionId: answer.questionId } },
          create: { submissionId, questionId: answer.questionId, textValue: answer.textValue ?? null, numericValue: answer.numericValue ?? null, jsonValue: answer.jsonValue as Prisma.InputJsonValue | undefined },
          update: { textValue: answer.textValue ?? null, numericValue: answer.numericValue ?? null, jsonValue: answer.jsonValue as Prisma.InputJsonValue | undefined, isCorrect: null, awardedPoints: null },
        });
      }
      return { saved: dto.answers.length, savedAt: new Date() };
    });
  }

  async proctorEvent(submissionId: string, dto: { eventType: string }, user: AuthenticatedUser) {
    this.requireStudent(user);
    if (!['VISIBILITY_HIDDEN', 'PAGE_HIDDEN', 'VISIBILITY_RESTORED'].includes(dto.eventType)) throw new BadRequestException('Неизвестное событие наблюдения');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
      const submission = await tx.submission.findFirst({
        where: { id: submissionId, studentIdentityKey: this.studentIdentityKey(user), status: SubmissionStatus.IN_PROGRESS },
        select: {
          id: true, assignmentId: true, proctorWarnings: true,
          answers: { select: { questionId: true, textValue: true, numericValue: true, jsonValue: true } },
        },
      });
      if (!submission) throw new NotFoundException('Активная попытка не найдена');
      const latest = await tx.proctorEvent.findFirst({ where: { submissionId }, orderBy: { createdAt: 'desc' }, select: { eventType: true } });
      if (dto.eventType === 'VISIBILITY_RESTORED') {
        if (latest && ['VISIBILITY_HIDDEN', 'PAGE_HIDDEN'].includes(latest.eventType)) await tx.proctorEvent.create({ data: { submissionId, eventType: dto.eventType } });
        return { warnings: submission.proctorWarnings, expired: false };
      }
      if (latest && ['VISIBILITY_HIDDEN', 'PAGE_HIDDEN'].includes(latest.eventType)) return { warnings: submission.proctorWarnings, expired: false, duplicate: true };
      const warnings = submission.proctorWarnings + 1;
      await tx.proctorEvent.create({ data: { submissionId, eventType: dto.eventType, metadata: { warning: warnings } } });
      await tx.submission.update({ where: { id: submissionId }, data: { proctorWarnings: warnings } });
      if (warnings < 3) return { warnings, expired: false };
      await tx.auditLog.create({ data: { action: 'PROCTORING_VIOLATION_LIMIT', entityType: 'Submission', entityId: submissionId, metadata: { warnings } } });
      const answers = submission.answers.map(answer => ({
        questionId: answer.questionId,
        ...(answer.textValue === null ? {} : { textValue: answer.textValue }),
        ...(answer.numericValue === null ? {} : { numericValue: Number(answer.numericValue) }),
        ...(answer.jsonValue === null ? {} : { jsonValue: answer.jsonValue }),
      }));
      const finalized = await this.finalizeInTransaction(
        tx, submission.assignmentId, submissionId, { answers }, user, 'PROCTORING_VIOLATION_LIMIT',
      );
      return { warnings, expired: true, finished: true, ...finalized, finishReason: finalized.finishReason ?? 'PROCTORING_VIOLATION_LIMIT' };
    });
  }

  async submit(id: string, submissionId: string, dto: SubmitAnswersDto, user: AuthenticatedUser) {
    this.requireStudent(user);
    return this.finalize(id, submissionId, dto, user);
  }

  private async finalize(id: string, submissionId: string, dto: SubmitAnswersDto, user?: AuthenticatedUser, finishReason?: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
      return this.finalizeInTransaction(tx, id, submissionId, dto, user, finishReason);
    });
  }

  private async finalizeInTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    submissionId: string,
    dto: SubmitAnswersDto,
    user?: AuthenticatedUser,
    finishReason?: string,
  ) {
    const submission = await tx.submission.findFirst({
      where: {
        id: submissionId, assignmentId: id,
        ...(user ? { studentId: user.studentProfileId ?? null, studentIdentityKey: this.studentIdentityKey(user) } : {}), status: SubmissionStatus.IN_PROGRESS,
      },
      include: { assignment: { include: { questions: { include: { options: true } } } }, answers: true },
    });
    if (!submission) throw new NotFoundException('Активная попытка не найдена');
    const elapsedMs = Date.now() - submission.startedAt.getTime();
    const timedOut = (submission.assignment.timeLimitMinutes !== null &&
      elapsedMs >= submission.assignment.timeLimitMinutes * 60_000) ||
      (submission.assignment.dueAt !== null && submission.assignment.dueAt.getTime() < Date.now());
    if (!user && !timedOut) throw new BadRequestException('Срок попытки ещё не истёк');
    const questionMap = new Map(submission.assignment.questions.map(q => [q.id, q]));
    const submittedAnswers = timedOut ? submission.answers.map(answer => ({
      questionId: answer.questionId, textValue: answer.textValue ?? undefined,
      numericValue: answer.numericValue === null ? undefined : Number(answer.numericValue),
      jsonValue: answer.jsonValue ?? undefined,
    })) : dto.answers;
    const inputMap = new Map(submittedAnswers.map(a => [a.questionId, a]));
    if (inputMap.size !== submittedAnswers.length) throw new BadRequestException('Нельзя отправить несколько ответов на один вопрос');
    for (const answer of submittedAnswers) {
      if (!questionMap.has(answer.questionId)) throw new BadRequestException('Ответ содержит неизвестный вопрос');
    }

    let autoScore = 0;
    let allAuto = true;
    const answerRows = submission.assignment.questions.map(question => {
      const input = inputMap.get(question.id);
      this.validateAnswer(question, input);
      let isCorrect: boolean | null = null;
      let awardedPoints: number | null = null;
      if (AUTO_GRADED.has(question.type)) {
        const points = Number(question.points);
        isCorrect = this.isCorrect(question.type, question.options, question.config, input);
        awardedPoints = isCorrect ? points : 0;
        autoScore += awardedPoints;
      } else {
        allAuto = false;
      }
      return {
        questionId: question.id,
        textValue: input?.textValue ?? null,
        numericValue: input?.numericValue ?? null,
        jsonValue: input?.jsonValue as Prisma.InputJsonValue | undefined,
        isCorrect,
        awardedPoints,
      };
    });
    await tx.answer.deleteMany({ where: { submissionId: submission.id } });
    await tx.answer.createMany({ data: answerRows.map(row => ({ ...row, submissionId: submission.id })) });
    const saved = await tx.submission.update({
      where: { id: submission.id },
      data: {
        status: timedOut ? SubmissionStatus.EXPIRED : allAuto ? SubmissionStatus.GRADED : SubmissionStatus.UNDER_REVIEW,
        submittedAt: timedOut ? new Date(Math.min(
          submission.assignment.timeLimitMinutes !== null ? submission.startedAt.getTime() + submission.assignment.timeLimitMinutes * 60000 : Infinity,
          submission.assignment.dueAt?.getTime() ?? Infinity,
        )) : new Date(),
        totalScore: allAuto ? roundedScore(autoScore) : null,
        gradedAt: allAuto ? new Date() : null,
        finishReason: timedOut ? 'TIME_LIMIT' : finishReason ?? 'STUDENT_SUBMITTED',
      },
      select: { id: true, status: true, submittedAt: true, totalScore: true, attemptNo: true, finishReason: true },
    });
    await enqueueResultExport(tx, submission.id);
    return { ...saved, timedOut, message: timedOut ? 'Время вышло. Ответы сохранены, но попытка отмечена как просроченная.' : allAuto ? 'Ответы проверены автоматически.' : 'Ответы отправлены преподавателю на проверку.' };
  }

  async listStudentResults(user: AuthenticatedUser) {
    this.requireStudent(user);
    const rows = await this.prisma.submission.findMany({
      where: {
        studentIdentityKey: this.studentIdentityKey(user),
        status: { notIn: [SubmissionStatus.WAITING, SubmissionStatus.IN_PROGRESS] },
      },
      orderBy: [{ submittedAt: 'desc' }, { startedAt: 'desc' }],
      take: 100,
      select: {
        id: true, status: true, totalScore: true, submittedAt: true, startedAt: true,
        feedback: true, finishReason: true, attemptNo: true,
        assignment: { select: { id: true, title: true, subject: { select: { name: true } } } },
      },
    });
    return rows.map(row => ({
      submissionId: row.id,
      assignmentId: row.assignment.id,
      assignmentTitle: row.assignment.title,
      subjectName: row.assignment.subject.name,
      status: row.status,
      score: row.totalScore === null ? null : Number(row.totalScore),
      submittedAt: row.submittedAt,
      startedAt: row.startedAt,
      feedback: row.feedback,
      finishReason: row.finishReason,
      attemptNo: row.attemptNo,
    }));
  }

  async studentResult(submissionId: string, user: AuthenticatedUser) {
    this.requireStudent(user);
    const identityKey = this.studentIdentityKey(user);
    const submission = await this.prisma.submission.findFirst({
      where: { id: submissionId, studentIdentityKey: identityKey },
      select: {
        id: true, assignmentId: true, status: true, totalScore: true, submittedAt: true, startedAt: true,
        finishReason: true, feedback: true,
        assignment: { select: { title: true } },
        answers: {
          orderBy: { question: { position: 'asc' } },
          select: {
            textValue: true, numericValue: true, jsonValue: true, awardedPoints: true,
            teacherComment: true, isCorrect: true,
            question: {
              select: {
                id: true, prompt: true, type: true, points: true,
                options: { orderBy: { position: 'asc' }, select: { id: true, text: true, position: true } },
              },
            },
          },
        },
      },
    });
    if (!submission || submission.status === SubmissionStatus.WAITING || submission.status === SubmissionStatus.IN_PROGRESS) throw new NotFoundException('Завершённый результат не найден');
    type Leader = { id: string; rank: bigint; firstName: string; lastName: string; score: number; durationMs: number; correctCount: number };
    const rows = await this.prisma.$queryRaw<Leader[]>`
      SELECT ranked."id", ranked."rank", ranked."firstName", ranked."lastName", ranked."score", ranked."durationMs", ranked."correctCount"
      FROM (
        SELECT s."id", s."studentFirstName" AS "firstName", s."studentLastName" AS "lastName",
          s."totalScore"::float8 AS "score",
          GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s."submittedAt", s."startedAt") - s."startedAt")) * 1000)::float8 AS "durationMs",
          (SELECT COUNT(*)::int FROM "Answer" a WHERE a."submissionId" = s."id" AND a."isCorrect" = true) AS "correctCount",
          ROW_NUMBER() OVER (ORDER BY s."totalScore" DESC,
            (COALESCE(s."submittedAt", s."startedAt") - s."startedAt") ASC,
            COALESCE(s."submittedAt", s."startedAt") ASC, s."studentLastName" ASC, s."studentFirstName" ASC) AS "rank"
        FROM "Submission" s
        WHERE s."assignmentId" = ${submission.assignmentId}
          AND s."status" IN ('GRADED'::"SubmissionStatus", 'EXPIRED'::"SubmissionStatus")
          AND s."totalScore" IS NOT NULL
      ) ranked
      WHERE ranked."rank" <= 10 OR ranked."id" = ${submissionId}
      ORDER BY ranked."rank" ASC
    `;
    const mine = rows.find(row => row.id === submissionId);
    return {
      submissionId: submission.id,
      assignmentTitle: submission.assignment.title,
      status: submission.status,
      finishReason: submission.finishReason,
      score: submission.totalScore === null ? null : Number(submission.totalScore),
      submittedAt: submission.submittedAt,
      feedback: submission.feedback,
      answers: submission.answers.map(answer => ({
        question: {
          id: answer.question.id,
          prompt: answer.question.prompt,
          type: answer.question.type,
          points: Number(answer.question.points),
          // Student review may show option labels, but never correctness flags or answer-key config.
          options: answer.question.options.map(option => ({ id: option.id, text: option.text })),
        },
        textValue: answer.textValue,
        numericValue: answer.numericValue === null ? null : Number(answer.numericValue),
        jsonValue: answer.jsonValue,
        awardedPoints: answer.awardedPoints === null ? null : Number(answer.awardedPoints),
        teacherComment: answer.teacherComment,
        isCorrect: answer.isCorrect,
      })),
      rank: mine ? Number(mine.rank) : null,
      correctCount: mine?.correctCount ?? 0,
      durationMs: mine?.durationMs ?? Math.max(0, (submission.submittedAt?.getTime() ?? Date.now()) - submission.startedAt.getTime()),
      top: rows.filter(row => Number(row.rank) <= 10).map(row => ({
        rank: Number(row.rank), firstName: row.firstName, lastName: row.lastName,
        score: row.score, correctCount: row.correctCount, durationMs: row.durationMs,
      })),
    };
  }

  private validateAnswer(question: { type: QuestionType; options: { id: string }[] }, input?: SubmitAnswersDto['answers'][number]) {
    if (!input) return;
    const hasText = input.textValue != null;
    const hasNumeric = input.numericValue != null;
    const hasJson = input.jsonValue != null;
    if (question.type === QuestionType.SINGLE_CHOICE) {
      const choice = hasJson ? input.jsonValue : input.textValue;
      if (hasNumeric || (hasText && hasJson) || (choice != null && (typeof choice !== 'string' || (choice !== '' && !question.options.some(o => o.id === choice))))) {
        throw new BadRequestException('Выбран недопустимый вариант ответа');
      }
    } else if (question.type === QuestionType.MULTIPLE_CHOICE) {
      const choices = input.jsonValue;
      if (hasText || hasNumeric || (hasJson && (!Array.isArray(choices) || choices.length > question.options.length || new Set(choices).size !== choices.length || choices.some(value => typeof value !== 'string' || !question.options.some(o => o.id === value))))) {
        throw new BadRequestException('Выбраны недопустимые варианты ответа');
      }
    } else if (question.type === QuestionType.NUMERIC) {
      if (hasText || hasJson || (hasNumeric && (!Number.isFinite(input.numericValue) || Math.abs(input.numericValue!) > 9999999999.9999))) {
        throw new BadRequestException('Укажите допустимый числовой ответ');
      }
    } else if (TEXT_QUESTIONS.has(question.type)) {
      if (hasNumeric || hasJson) throw new BadRequestException('Для текстового вопроса отправьте текст');
    }
  }

  private isCorrect(type: QuestionType, options: { id: string; isCorrect: boolean }[], config: Prisma.JsonValue | null, input?: { textValue?: string; numericValue?: number; jsonValue?: unknown }) {
    if (type === QuestionType.SINGLE_CHOICE) {
      const selected = typeof input?.jsonValue === 'string' ? input.jsonValue : input?.textValue;
      return !!selected && options.some(o => o.id === selected && o.isCorrect);
    }
    if (type === QuestionType.MULTIPLE_CHOICE) {
      const raw = input?.jsonValue;
      if (!Array.isArray(raw)) return false;
      const selected = [...new Set(raw.filter((v): v is string => typeof v === 'string'))].sort();
      const correct = options.filter(o => o.isCorrect).map(o => o.id).sort();
      return selected.length === correct.length && selected.every((id, i) => id === correct[i]);
    }
    if (type === QuestionType.NUMERIC) {
      if (typeof input?.numericValue !== 'number' || !Number.isFinite(input.numericValue)) return false;
      const target = typeof config === 'object' && config !== null && 'correctValue' in config
        ? Number((config as Prisma.JsonObject).correctValue) : NaN;
      const tolerance = typeof config === 'object' && config !== null && 'tolerance' in config
        ? Number((config as Prisma.JsonObject).tolerance) : 0;
      return Number.isFinite(target) && Math.abs(input.numericValue - target) <= Math.max(0, tolerance);
    }
    return false;
  }

  async results(id: string, user: AuthenticatedUser) {
    this.requireStaff(user);
    const assignment = await this.prisma.assignment.findFirst({ where: { id, ...this.staffScope(user) }, select: { id: true, title: true, questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } } } });
    if (!assignment) throw new NotFoundException('Задание не найдено');
    const submissions = await this.prisma.submission.findMany({
      where: { assignmentId: id },
      orderBy: [{ startedAt: 'desc' }, { attemptNo: 'desc' }],
      include: {
        reviewer: { select: { firstName: true, lastName: true } },
        proctorEvents: { orderBy: { createdAt: 'asc' } },
        answers: {
          orderBy: { question: { position: 'asc' } },
          include: { question: { include: { options: { orderBy: { position: 'asc' } } } } },
        },
      },
    });
    return { assignment, submissions };
  }

  async returnSubmission(submissionId: string, feedback: string | undefined, user: AuthenticatedUser) {
    this.requireStaff(user);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
      const submission = await tx.submission.findFirst({ where: { id: submissionId, assignment: this.staffScope(user) }, select: { id: true, status: true, assignmentId: true } });
      if (!submission) throw new NotFoundException('Работа не найдена');
      const returnableStatuses: SubmissionStatus[] = [SubmissionStatus.UNDER_REVIEW, SubmissionStatus.GRADED, SubmissionStatus.EXPIRED];
      if (!returnableStatuses.includes(submission.status)) {
        throw new BadRequestException('Можно вернуть только отправленную на проверку или проверенную работу');
      }
      const updated = await tx.submission.update({ where: { id: submissionId }, data: {
        status: SubmissionStatus.RETURNED, feedback: feedback?.trim() || 'Исправьте работу и отправьте повторно',
        totalScore: null, gradedAt: null, reviewerId: user.sub,
      }});
      await tx.auditLog.create({ data: { actorId: user.sub, action: 'SUBMISSION_RETURNED', entityType: 'Submission', entityId: submissionId, metadata: { assignmentId: submission.assignmentId } } });
      await enqueueResultExport(tx, submissionId);
      return updated;
    });
  }

  async reopenReturned(submissionId: string, user: AuthenticatedUser) {
    this.requireStudent(user);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
      const current = await tx.submission.findFirst({ where: { id: submissionId, studentIdentityKey: this.studentIdentityKey(user), status: SubmissionStatus.RETURNED }, select: { id: true } });
      if (!current) throw new NotFoundException('Работа не найдена или не возвращена на исправление');
      const submission = await tx.submission.update({
        where: { id: submissionId },
        data: { status: SubmissionStatus.IN_PROGRESS, startedAt: new Date(), submittedAt: null, totalScore: null, gradedAt: null, finishReason: 'RESUBMISSION' },
        include: { assignment: { include: { questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } } }, answers: true },
      });
      return this.studentAssignmentPayload(submission.assignment, submission);
    });
  }

  async grade(submissionId: string, dto: GradeSubmissionDto, user: AuthenticatedUser) {
    this.requireStaff(user);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
      const submission = await tx.submission.findFirst({
        where: { id: submissionId, assignment: this.staffScope(user) }, include: { answers: { include: { question: true } } },
      });
      if (!submission) throw new NotFoundException('Работа не найдена');
      if (!submission.submittedAt || submission.status === SubmissionStatus.IN_PROGRESS) {
        throw new BadRequestException('Нельзя оценить незавершённую попытку');
      }
      if (new Set(dto.answers.map(a => a.answerId)).size !== dto.answers.length) throw new BadRequestException('Ответ повторяется в оценке');
      const known = new Map(submission.answers.map(a => [a.id, a]));
      if (dto.answers.some(a => !known.has(a.answerId))) throw new BadRequestException('Передан ответ из другой работы');
      for (const grade of dto.answers) {
        const answer = known.get(grade.answerId)!;
        if (!Number.isFinite(grade.awardedPoints) || grade.awardedPoints < 0 || grade.awardedPoints > 10000 || Math.abs(grade.awardedPoints - roundedScore(grade.awardedPoints)) > 1e-8) {
          throw new BadRequestException('Укажите баллы от 0 до 10000, не более двух знаков после запятой');
        }
        if (!TEXT_QUESTIONS.has(answer.question.type) && grade.awardedPoints > Number(answer.question.points)) {
          throw new BadRequestException(`Баллы за вопрос не могут превышать ${Number(answer.question.points)}`);
        }
      }
      const oldScore = submission.totalScore === null ? null : Number(submission.totalScore);
      const submittedGrades = new Map(dto.answers.map(a => [a.answerId, a.awardedPoints]));
      if (submission.answers.some(a => a.awardedPoints === null && !submittedGrades.has(a.id))) {
        throw new BadRequestException('Оцените каждый ответ перед сохранением');
      }
      const score = roundedScore(submission.answers.reduce((sum, answer) => {
        const updatedPoints = submittedGrades.get(answer.id);
        return sum + (updatedPoints ?? (answer.awardedPoints === null ? 0 : Number(answer.awardedPoints)));
      }, 0));
      if (score > MAX_TOTAL_POINTS) throw new BadRequestException('Сумма баллов не может превышать 999999.99');
      for (const answer of dto.answers) {
        const question = known.get(answer.answerId)!.question;
        await tx.answer.update({
          where: { id: answer.answerId },
          data: {
            awardedPoints: answer.awardedPoints,
            isCorrect: TEXT_QUESTIONS.has(question.type) ? answer.awardedPoints > 0 : answer.awardedPoints === Number(question.points),
            teacherComment: answer.teacherComment ?? null,
          },
        });
      }
      const updated = await tx.submission.update({
        where: { id: submissionId },
        data: { totalScore: score, feedback: dto.feedback ?? null, status: SubmissionStatus.GRADED, gradedAt: new Date(), reviewerId: user.sub },
      });
      await tx.gradeHistory.create({
        data: { submissionId, changedById: user.sub, oldScore, newScore: score, reason: dto.feedback ?? null },
      });
      await enqueueResultExport(tx, submissionId);
      return updated;
    });
  }

  async dashboard(user: AuthenticatedUser) {
    this.requireStaff(user);
    const scope = this.staffScope(user);
    const [activeAssignments, submissionsAwaitingReview, gradedSubmissions, totalSubmissions] = await Promise.all([
      this.prisma.assignment.count({ where: { ...scope, status: AssignmentStatus.PUBLISHED } }),
      this.prisma.submission.count({ where: {
        assignment: scope, status: { in: [SubmissionStatus.UNDER_REVIEW, SubmissionStatus.EXPIRED] },
        submittedAt: { not: null }, totalScore: null,
      } }),
      this.prisma.submission.count({ where: { assignment: scope, status: SubmissionStatus.GRADED } }),
      this.prisma.submission.count({ where: { assignment: scope } }),
    ]);
    return { activeAssignments, submissionsAwaitingReview, gradedSubmissions, totalSubmissions };
  }
}

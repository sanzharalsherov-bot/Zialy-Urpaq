import { HttpException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class ResultsExportService {
  private active = 0;
  constructor(private readonly prisma: PrismaService) {}
  async sqlite(id: string, user: AuthenticatedUser): Promise<Buffer> {
    if (user.role !== 'ADMIN' && user.role !== 'TEACHER') throw new ForbiddenException();
    if (this.active >= 2) throw new HttpException('Уже создаются два архива. Повторите позже.', 429);
    this.active++;
    try {
      const data = await this.prisma.$transaction(async tx => {
        const assignment = await tx.assignment.findFirst({ where: { id, ...(user.role === 'ADMIN' ? {} : { creatorId: user.sub }) }, select: { id: true, title: true, questions: { orderBy: { position: 'asc' }, include: { options: true } } } });
        if (!assignment) throw new NotFoundException('Задание не найдено');
        if (await tx.submission.count({ where: { assignmentId: id } }) > 2000 || await tx.answer.count({ where: { submission: { assignmentId: id } } }) > 100000) throw new HttpException('Архив слишком большой. Используйте резервную копию PostgreSQL.', 413);
        const submissions = await tx.submission.findMany({ where: { assignmentId: id }, select: {
          id: true, studentFirstName: true, studentLastName: true, attemptNo: true, status: true, totalScore: true, startedAt: true, submittedAt: true, proctorWarnings: true,
          answers: { select: { questionId: true, textValue: true, numericValue: true, jsonValue: true, isCorrect: true, awardedPoints: true, teacherComment: true } },
          proctorEvents: { select: { id: true, eventType: true, createdAt: true } },
        } });
        return { assignment, submissions };
      }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
      // SQLite work runs off the request thread; quiz answers can still be saved.
      return await new Promise<Buffer>((resolve, reject) => {
        const worker = new Worker(join(__dirname, 'results-export.worker.js'), { workerData: JSON.parse(JSON.stringify(data)), resourceLimits: { maxOldGenerationSizeMb: 128 } });
        const timer = setTimeout(() => { void worker.terminate(); reject(new HttpException('Время создания архива истекло', 503)); }, 30000);
        worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.buffer ? resolve(Buffer.from(result.buffer)) : reject(new HttpException(result.error, 500)); });
        worker.once('error', () => { clearTimeout(timer); reject(new HttpException('Не удалось создать архив результатов', 500)); });
        worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new HttpException('Создание архива прервано', 503)); });
      });
    } finally { this.active--; }
  }
}

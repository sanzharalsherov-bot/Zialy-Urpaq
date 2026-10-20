import { BadRequestException, ConflictException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateClassDto, CreateStudentDto, CreateSubjectDto } from './school.dto';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';

@Injectable()
export class SchoolService {
  constructor(private readonly prisma: PrismaService) {}

  private requireAdmin(user: AuthenticatedUser) {
    if (user.role !== UserRole.ADMIN) throw new ForbiddenException('Управлять классами и списком учеников может только администратор');
  }

  async listClasses(user: AuthenticatedUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.TEACHER) throw new ForbiddenException('Недостаточно прав');
    return this.prisma.schoolClass.findMany({
      orderBy: [{ academicYear: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { students: true, assignments: true } } },
    });
  }

  async createClass(dto: CreateClassDto, user: AuthenticatedUser) {
    this.requireAdmin(user);
    try {
      return await this.prisma.schoolClass.create({
        data: { name: dto.name, academicYear: dto.academicYear },
        include: { _count: { select: { students: true, assignments: true } } },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('Класс с таким названием уже существует');
      }
      throw error;
    }
  }

  async listSubjects(user: AuthenticatedUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.TEACHER) {
      throw new ForbiddenException('Недостаточно прав');
    }
    return this.prisma.subject.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
  }

  async createSubject(dto: CreateSubjectDto, user: AuthenticatedUser) {
    this.requireAdmin(user);
    try {
      return await this.prisma.subject.create({ data: { name: dto.name, description: dto.description || null } });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('Предмет с таким названием уже существует');
      }
      throw error;
    }
  }

  async listStudents(user: AuthenticatedUser, classId?: string) {
    this.requireAdmin(user);
    return this.prisma.studentProfile.findMany({
      where: classId ? { classId } : {},
      orderBy: [{ schoolClass: { name: 'asc' } }, { user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }],
      include: {
        user: { select: { id: true, firstName: true, lastName: true, isActive: true, createdAt: true } },
        schoolClass: { select: { id: true, name: true, academicYear: true } },
      },
      take: 2000,
    });
  }

  async listAssignmentRoster(user: AuthenticatedUser, classId?: string) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.TEACHER) {
      throw new ForbiddenException('Недостаточно прав');
    }
    if (!classId?.trim()) throw new BadRequestException('Для списка учеников выберите класс');
    const schoolClass = await this.prisma.schoolClass.findUnique({ where: { id: classId }, select: { id: true } });
    if (!schoolClass) throw new NotFoundException('Класс не найден');
    return this.prisma.studentProfile.findMany({
      where: { classId, user: { isActive: true } },
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }],
      select: {
        id: true,
        studentNo: true,
        user: { select: { firstName: true, lastName: true } },
      },
      take: 500,
    });
  }

  async createStudent(dto: CreateStudentDto, user: AuthenticatedUser) {
    this.requireAdmin(user);
    const schoolClass = await this.prisma.schoolClass.findUnique({ where: { id: dto.classId }, select: { id: true } });
    if (!schoolClass) throw new NotFoundException('Класс не найден');
    const studentNo = dto.studentNo?.trim() || null;
    if (studentNo && await this.prisma.studentProfile.findUnique({ where: { studentNo }, select: { id: true } })) {
      throw new ConflictException('Ученик с таким табельным номером уже существует');
    }
    const email = 'student-' + randomUUID() + '@students.zailyurpaq.local';
    const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
    try {
      return await this.prisma.user.create({
        data: {
          email, passwordHash, firstName: dto.firstName, lastName: dto.lastName, role: UserRole.STUDENT,
          studentProfile: { create: { classId: dto.classId, studentNo } },
        },
        select: {
          id: true, firstName: true, lastName: true, role: true, isActive: true,
          studentProfile: { select: { id: true, studentNo: true, classId: true, schoolClass: { select: { name: true, academicYear: true } } } },
        },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('Не удалось создать ученика: проверьте табельный номер');
      }
      throw error;
    }
  }
}

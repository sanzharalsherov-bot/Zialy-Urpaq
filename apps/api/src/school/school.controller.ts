import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateClassDto, CreateStudentDto, CreateSubjectDto } from './school.dto';
import { SchoolService } from './school.service';

@Controller('school')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SchoolController {
  constructor(private readonly school: SchoolService) {}

  @Get('classes')
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  listClasses(@CurrentUser() user: AuthenticatedUser) {
    return this.school.listClasses(user);
  }

  @Post('classes')
  @Roles(UserRole.ADMIN)
  createClass(@Body() dto: CreateClassDto, @CurrentUser() user: AuthenticatedUser) {
    return this.school.createClass(dto, user);
  }

  @Get('subjects')
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  listSubjects(@CurrentUser() user: AuthenticatedUser) {
    return this.school.listSubjects(user);
  }

  @Post('subjects')
  @Roles(UserRole.ADMIN)
  createSubject(@Body() dto: CreateSubjectDto, @CurrentUser() user: AuthenticatedUser) {
    return this.school.createSubject(dto, user);
  }

  @Get('students')
  @Roles(UserRole.ADMIN)
  listStudents(@CurrentUser() user: AuthenticatedUser, @Query('classId') classId?: string) {
    return this.school.listStudents(user, classId);
  }

  @Post('students')
  @Roles(UserRole.ADMIN)
  createStudent(@Body() dto: CreateStudentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.school.createStudent(dto, user);
  }
}

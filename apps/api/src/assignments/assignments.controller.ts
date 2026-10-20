import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  CreateAssignmentDto, GradeSubmissionDto, ProctorEventDto, RoomJoinDto, SubmitAnswersDto, ReturnSubmissionDto,
} from './assignments.dto';
import { AssignmentsService } from './assignments.service';
import { parseWordQuizTemplate } from './word-template.parser';
import { ResultsExportService } from './results-export.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService, private readonly exports: ResultsExportService) {}

  @Get('assignments/:id/results.sqlite')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  async exportSqlite(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return new StreamableFile(await this.exports.sqlite(id, user), { type: 'application/vnd.sqlite3', disposition: 'attachment; filename="test-results.sqlite"' });
  }

  @Get('dashboard')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.assignments.dashboard(user);
  }

  @Get('assignments')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  listForStaff(@CurrentUser() user: AuthenticatedUser) {
    return this.assignments.listForStaff(user);
  }

  @Get('assignment-rooms')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  roomSummaries(@CurrentUser() user: AuthenticatedUser) {
    return this.assignments.roomSummaries(user);
  }

  @Post('assignments')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  create(@Body() dto: CreateAssignmentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.create(dto, user);
  }

  @Post('assignments/import-template')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
    fileFilter: (_request, file, callback) => {
      if (!file.originalname.toLowerCase().endsWith('.docx')) return callback(new BadRequestException('Загрузите документ .docx'), false);
      callback(null, true);
    },
  }))
  importTemplate(@UploadedFile() file?: { buffer: Buffer }) {
    if (!file?.buffer) throw new BadRequestException('Выберите заполненный шаблон Word (.docx)');
    return parseWordQuizTemplate(file.buffer);
  }

  @Patch('assignments/:id/publish')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  publish(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.publish(id, user);
  }

  @Delete('assignments/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  delete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.delete(id, user);
  }

  @Get('student/assignments')
  listAvailable(@CurrentUser() user: AuthenticatedUser) {
    return this.assignments.listAvailable(user);
  }

  @Get('student/results')
  listStudentResults(@CurrentUser() user: AuthenticatedUser) {
    return this.assignments.listStudentResults(user);
  }

  @Post('student/assignments/:id/start')
  start(
    @Param('id') id: string,
    @Body() dto: RoomJoinDto,
    @Req() request: { ip?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.start(id, user, dto.code, request.ip);
  }

  @Post('student/rooms/join')
  joinRoom(@Body() dto: RoomJoinDto, @Req() request: { ip?: string }, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.joinRoom(dto.code, request.ip ?? 'unknown', user);
  }

  @Get('student/rooms/:submissionId')
  roomStatus(@Param('submissionId') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.roomStatus(id, user);
  }

  @Post('assignments/:id/room/start')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  startRoom(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.startRoom(id, user);
  }

  @Patch('student/submissions/:submissionId/answers')
  saveAnswers(@Param('submissionId') id: string, @Body() dto: SubmitAnswersDto, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.saveAnswers(id, dto, user);
  }

  @Post('student/submissions/:submissionId/proctor-events')
  proctorEvent(@Param('submissionId') id: string, @Body() dto: ProctorEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.proctorEvent(id, dto, user);
  }

  @Get('student/submissions/:submissionId/result')
  studentResult(@Param('submissionId') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.studentResult(id, user);
  }

  @Post('student/assignments/:id/submissions/:submissionId/submit')
  submit(
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Body() dto: SubmitAnswersDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.submit(id, submissionId, dto, user);
  }

  @Get('assignments/:id/results')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  results(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.results(id, user);
  }

  @Patch('submissions/:id/return')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  returnSubmission(@Param('id') id: string, @Body() dto: ReturnSubmissionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.returnSubmission(id, dto.feedback, user);
  }

  @Post('student/submissions/:id/reopen')
  reopenReturned(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assignments.reopenReturned(id, user);
  }

  @Patch('submissions/:id/grade')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  grade(
    @Param('id') id: string,
    @Body() dto: GradeSubmissionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.grade(id, dto, user);
  }
}

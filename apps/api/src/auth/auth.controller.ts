import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { BootstrapAdminDto, CreateTeacherDto, CreateUserDto, LoginDto, SharedStudentLoginDto, UpdateStudentAccessCodeDto } from './auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser } from './auth.types';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('bootstrap-admin')
  @HttpCode(HttpStatus.CREATED)
  bootstrapAdmin(@Body() dto: BootstrapAdminDto) {
    return this.auth.bootstrapAdmin(dto);
  }

  @Post('teachers')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createTeacher(@Body() dto: CreateTeacherDto) {
    return this.auth.createTeacher(dto);
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listUsers() {
    return this.auth.listUsers();
  }

  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createUser(@Body() dto: CreateUserDto) {
    return this.auth.createUser(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() request: { ip?: string }) {
    return this.auth.login(dto, request.ip);
  }

  @Post('student-access')
  @HttpCode(HttpStatus.OK)
  loginStudent(@Body() dto: SharedStudentLoginDto, @Req() request: { ip?: string }) {
    return this.auth.loginSharedStudent(dto, request.ip);
  }

  @Get('student-access-code')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getStudentAccessCodeStatus() {
    return this.auth.getStudentAccessCodeStatus();
  }

  @Post('student-access-code')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateStudentAccessCode(@Body() dto: UpdateStudentAccessCodeDto) {
    return this.auth.updateStudentAccessCode(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    if (user.kind === 'shared_student') {
      return { id: user.sub, email: '', firstName: user.firstName, lastName: user.lastName, role: UserRole.STUDENT, isActive: true };
    }
    return this.auth.me(user.sub);
  }

  @Get('admin-check')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  adminCheck(@CurrentUser() user: AuthenticatedUser) {
    return { ok: true, userId: user.sub, role: user.role };
  }
}

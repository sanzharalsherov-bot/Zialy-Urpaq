import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { MonitorService } from './monitor.service';

export class MonitorHeartbeatDto {
  @IsBoolean() visible!: boolean;
  @IsBoolean() sharing!: boolean;
  @IsOptional() @IsString() @MaxLength(100) questionId?: string;
}
export class MonitorFrameDto { @IsString() @MaxLength(140000) frame!: string; }
@Controller()
@UseGuards(JwtAuthGuard)
export class MonitorController {
  constructor(private readonly monitor: MonitorService) {}
  @Post('student/submissions/:id/monitor')
  heartbeat(@Param('id') id: string, @Body() dto: MonitorHeartbeatDto, @CurrentUser() user: AuthenticatedUser) { return this.monitor.heartbeat(id, dto, user); }
  @Post('student/submissions/:id/screen')
  frame(@Param('id') id: string, @Body() dto: MonitorFrameDto, @CurrentUser() user: AuthenticatedUser) { return this.monitor.uploadFrame(id, dto.frame, user); }
  @Get('assignments/:id/monitor')
  list(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.monitor.list(id, user); }
  @Get('submissions/:id/monitor')
  watch(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.monitor.watch(id, user); }
}

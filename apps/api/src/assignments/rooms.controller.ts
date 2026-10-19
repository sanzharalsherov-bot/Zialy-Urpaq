import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateRoomDto, JoinRoomV2Dto, RoomProctorEventDto, SaveRoomAnswersDto } from './rooms.dto';
import { RoomSessionGuard } from './room-session.guard';
import { RoomsService } from './rooms.service';
import { LiveKitService } from './livekit.service';

@Controller()
export class RoomsController {
  constructor(private readonly rooms: RoomsService, private readonly liveKit: LiveKitService) {}

  @Post('assignments/:assignmentId/rooms')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  createRoom(@Param('assignmentId') assignmentId: string, @Body() dto: CreateRoomDto, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.createRoom(assignmentId, dto, user);
  }

  @Get('assignments/:assignmentId/rooms')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  listRooms(@Param('assignmentId') assignmentId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.listRooms(user, assignmentId);
  }

  @Get('rooms/:roomId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  getRoom(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.getRoom(roomId, user);
  }

  @Get('rooms/:roomId/analytics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  roomAnalytics(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.roomAnalytics(roomId, user);
  }

  @Post('rooms/:roomId/start')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  startRoom(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.startRoom(roomId, user);
  }

  @Post('rooms/:roomId/livekit-token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TEACHER)
  staffLiveKitToken(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.liveKit.staffToken(roomId, user);
  }

  @Post('student/rooms/join-v2')
  joinRoom(@Body() dto: JoinRoomV2Dto, @Req() request: { ip?: string }) {
    return this.rooms.joinRoom(dto.code, dto.firstName, dto.lastName, dto.sessionToken, request.ip);
  }

  @Get('student/rooms/:roomId/v2')
  @UseGuards(RoomSessionGuard)
  getStudentRoom(@Param('roomId') roomId: string, @Req() request: { roomToken?: string }) {
    return this.rooms.getStudentRoom(roomId, request.roomToken ?? '');
  }

  @Patch('student/rooms/:roomId/v2/answers')
  @UseGuards(RoomSessionGuard)
  saveAnswers(@Param('roomId') roomId: string, @Body() dto: SaveRoomAnswersDto, @Req() request: { roomToken?: string }) {
    return this.rooms.saveRoomAnswers(roomId, request.roomToken ?? '', dto);
  }

  @Post('student/rooms/:roomId/v2/submit')
  @UseGuards(RoomSessionGuard)
  submit(@Param('roomId') roomId: string, @Req() request: { roomToken?: string }) {
    return this.rooms.submitRoom(roomId, request.roomToken ?? '');
  }

  @Post('student/rooms/:roomId/v2/proctor-events')
  @UseGuards(RoomSessionGuard)
  proctorEvent(@Param('roomId') roomId: string, @Body() dto: RoomProctorEventDto, @Req() request: { roomToken?: string }) {
    return this.rooms.recordRoomProctorEvent(roomId, request.roomToken ?? '', dto);
  }

  @Post('student/rooms/:roomId/v2/livekit-token')
  @UseGuards(RoomSessionGuard)
  studentLiveKitToken(@Param('roomId') roomId: string, @Req() request: { roomToken?: string }) {
    return this.liveKit.studentToken(roomId, request.roomToken ?? '');
  }
}

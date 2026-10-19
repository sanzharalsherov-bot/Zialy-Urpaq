import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { MonitorService } from './monitor.service';
import { MonitorController } from './monitor.controller';
import { ResultsExportService } from './results-export.service';
import { ResultsOutboxService } from './results-outbox.service';
import { LiveKitService } from './livekit.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { RoomSessionGuard } from './room-session.guard';

@Module({
  imports: [AuthModule],
  controllers: [AssignmentsController, MonitorController, RoomsController],
  providers: [AssignmentsService, MonitorService, ResultsExportService, ResultsOutboxService, LiveKitService, RoomsService, RoomSessionGuard],
})
export class AssignmentsModule {}

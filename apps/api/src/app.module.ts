import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AssignmentsModule } from './assignments/assignments.module';

@Module({
  imports: [PrismaModule, AuthModule, AssignmentsModule],
  controllers: [HealthController],
})
export class AppModule {}

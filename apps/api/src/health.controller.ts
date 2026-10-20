import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { ResultsOutboxService } from './assignments/results-outbox.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resultsOutbox: ResultsOutboxService,
  ) {}

  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    const resultsDelivery = await this.resultsOutbox.healthStatus();
    return {
      status: 'ok',
      database: 'connected',
      resultsDelivery,
      service: 'school-crm-api',
    };
  }
}

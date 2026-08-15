import { Controller, Get, Inject } from '@nestjs/common';

import { HealthService } from './health.service';
import type { HealthStatus } from './health.service';

@Controller('health')
export class HealthController {
  // Explicit @Inject token so DI does not depend on emitted design:paramtypes
  // metadata (esbuild, used by Vitest, does not emit emitDecoratorMetadata).
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthStatus {
    return this.healthService.getHealth();
  }
}

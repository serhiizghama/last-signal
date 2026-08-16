import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { AccountDocument } from '../schemas/account.schema';
import { ListReportsQueryDto } from './dto/list-reports.query.dto';
import { ReportsService } from './reports.service';
import type { ReportsPageView, ReportView } from './reports.view';

// Every route here is scoped to the caller's own account (§8: reports are strictly
// per-account) — `ReportsService` never takes an `accountId` from anywhere but
// `@CurrentAccount()`.
@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(ReportsService) private readonly reportsService: ReportsService) {}

  @Get()
  async list(
    @CurrentAccount() account: AccountDocument,
    @Query() query: ListReportsQueryDto,
  ): Promise<ReportsPageView> {
    return this.reportsService.listMine(account._id, query.cursor, query.limit, Date.now());
  }

  // Read-on-open (§8): fetching a report is what marks it read — see
  // `ReportsService.getAndMarkRead`'s own comment for why no separate mark-read route exists.
  @Get(':id')
  async getOne(
    @CurrentAccount() account: AccountDocument,
    @Param('id') id: string,
  ): Promise<ReportView> {
    return this.reportsService.getAndMarkRead(id, account._id, Date.now());
  }
}

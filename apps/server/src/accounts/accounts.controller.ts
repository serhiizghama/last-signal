import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';

import type { AccountView } from './account.view';
import { buildAccountView } from './account.view';
import { AccountsService } from './accounts.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { AccountDocument } from '../schemas/account.schema';
import { RegisterDto } from './dto/register.dto';

@Controller('accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(AccountsService) private readonly accountsService: AccountsService) {}

  // 200, not the Nest POST default of 201: this mutates the caller's existing (guest)
  // account in place — the response body is that account's current state, not a
  // representation of a newly-created resource at a new URL (same rationale as
  // `SettlementsController.startBuild`).
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(
    @CurrentAccount() account: AccountDocument,
    @Body() dto: RegisterDto,
  ): Promise<AccountView> {
    const updated = await this.accountsService.register(account._id, dto);
    return buildAccountView(updated);
  }
}

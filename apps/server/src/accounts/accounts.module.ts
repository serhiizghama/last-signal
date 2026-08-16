import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  // DatabaseModule for `@InjectModel(Account.name)`; AuthModule for `AuthGuard` +
  // `CurrentAccount` on `AccountsController`.
  imports: [DatabaseModule, AuthModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}

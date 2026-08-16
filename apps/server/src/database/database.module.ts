import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Account,
  AccountSchema,
  GameEvent,
  GameEventSchema,
  Movement,
  MovementSchema,
  Oasis,
  OasisSchema,
  Report,
  ReportSchema,
  Session,
  SessionSchema,
  Settlement,
  SettlementSchema,
  World,
  WorldSchema,
} from '../schemas';

// Local single-node replica set started by the repo-root docker-compose.yml.
const DEFAULT_MONGODB_URI =
  'mongodb://localhost:27117/last-signal?replicaSet=rs0&directConnection=true';
// Short on purpose: a missing/unreachable Mongo should fail bootstrap fast
// and loudly, not hang.
const SERVER_SELECTION_TIMEOUT_MS = 5_000;

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI', DEFAULT_MONGODB_URI),
        // Off in production: index builds should be an explicit migration
        // step there, not an implicit side effect of booting the server.
        autoIndex: configService.get<string>('NODE_ENV', 'development') !== 'production',
        serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
        // Fail on the first attempt instead of @nestjs/mongoose's default of
        // silently retrying for ~30s (9 attempts x 3s) before giving up.
        retryAttempts: 0,
      }),
    }),
    // Registered here, once, for the whole app. Feature modules (accounts,
    // settlements, ...) land in later steps and will just import
    // DatabaseModule to `@InjectModel(...)` these.
    MongooseModule.forFeature([
      { name: Account.name, schema: AccountSchema },
      { name: Settlement.name, schema: SettlementSchema },
      { name: GameEvent.name, schema: GameEventSchema },
      { name: World.name, schema: WorldSchema },
      { name: Oasis.name, schema: OasisSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Movement.name, schema: MovementSchema },
      { name: Report.name, schema: ReportSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './api/app.controller';
import { CredentialVaultService } from './auth/credential-vault.service';
import { AutonomousService, CHECK_DISPATCHER } from './autonomous/autonomous.service';
import { TelegramBotService } from './bot/telegram-bot.service';
import { DatabaseModule } from './database/database.module';
import { ACADEMIC_REPOSITORY } from './persistence/academic.repository';
import { PostgresAcademicRepository } from './persistence/postgres-academic.repository';
import { BullMqCheckDispatcher, COURSE_CHECK_QUEUE, LEGACY_DEBT_QUEUE } from './queue/check-queue.dispatcher';
import { CourseCheckProcessor } from './queue/course-check.processor';
import { SyncService } from './sync/sync.service';
import { AdaptiveAisNavigator } from './university/adaptive-ais-navigator';
import { AisContentExtractor } from './university/ais-content-extractor';
import { AbuUniversityAdapter } from './university/abu-university.adapter';
import { UNIVERSITY_ADAPTER } from './university/university-adapter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ connection: { url: config.get('REDIS_URL') ?? 'redis://localhost:6379' } }),
    }),
    BullModule.registerQueue({ name: COURSE_CHECK_QUEUE }, { name: LEGACY_DEBT_QUEUE }),
  ],
  controllers: [AppController],
  providers: [
    CredentialVaultService,
    AdaptiveAisNavigator,
    AisContentExtractor,
    AbuUniversityAdapter,
    PostgresAcademicRepository,
    SyncService,
    AutonomousService,
    TelegramBotService,
    BullMqCheckDispatcher,
    CourseCheckProcessor,
    { provide: UNIVERSITY_ADAPTER, useExisting: AbuUniversityAdapter },
    { provide: ACADEMIC_REPOSITORY, useExisting: PostgresAcademicRepository },
    { provide: CHECK_DISPATCHER, useExisting: BullMqCheckDispatcher },
  ],
})
export class AppModule {}

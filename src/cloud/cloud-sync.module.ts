import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { CredentialVaultService } from '../auth/credential-vault.service';
import { PostgresAcademicRepository } from '../persistence/postgres-academic.repository';
import { ACADEMIC_REPOSITORY } from '../persistence/academic.repository';
import { AdaptiveAisNavigator } from '../university/adaptive-ais-navigator';
import { AisContentExtractor } from '../university/ais-content-extractor';
import { AbuUniversityAdapter } from '../university/abu-university.adapter';
import { UNIVERSITY_ADAPTER } from '../university/university-adapter';
import { SyncService } from '../sync/sync.service';

/**
 * GitHub Actions runner only: no API controllers, Telegram polling or Redis.
 * Never imports the full AppModule or a queue worker.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
  providers: [
    CredentialVaultService,
    PostgresAcademicRepository,
    AdaptiveAisNavigator,
    AisContentExtractor,
    AbuUniversityAdapter,
    SyncService,
    { provide: ACADEMIC_REPOSITORY, useExisting: PostgresAcademicRepository },
    { provide: UNIVERSITY_ADAPTER, useExisting: AbuUniversityAdapter },
  ],
})
export class CloudSyncModule {}

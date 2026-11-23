import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CloudSyncModule } from './cloud-sync.module';
import { SyncService } from '../sync/sync.service';

async function main() {
  const accountRef = process.env.AISORA_SYNC_ACCOUNT_REF;
  if (!accountRef || !/^telegram:\d{1,20}$/.test(accountRef)) {
    throw new Error('Expected AISORA_SYNC_ACCOUNT_REF=telegram:<numeric-id>');
  }
  if (process.env.AIS_AUTOMATION_APPROVED !== 'true') {
    throw new Error('AIS_AUTOMATION_APPROVED=true is required for read-only AIS access');
  }
  if (!process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY) {
    throw new Error('Neon connection and encryption key must be configured in Actions secrets');
  }

  const app = await NestFactory.createApplicationContext(CloudSyncModule, { logger: ['error', 'warn'] });
  try {
    const sync = app.get(SyncService);
    // Public Actions logs must not contain student data, course titles,
    // account references, screenshots, submission details or passwords.
    await sync.synchronize(accountRef);
    console.log('Read-only AIS sync finished successfully; results stored in Neon');
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  // Timeout stages in AbuUniversityAdapter are static developer-authored labels,
  // not extracted student page content. Never print raw error messages/stacks.
  const knownStages = new Set([
    'запуск браузерной сессии',
    'открытие AIS',
    'ожидание загрузки главной страницы',
    'автоматический вход',
    'чтение списка дисциплин',
    'открытие электронного журнала',
    'чтение заданий и отправок',
    'возврат на главную страницу',
    'ожидание главной страницы',
    'чтение расписания',
  ]);
  const stage = error && typeof error === 'object' && 'stage' in error
    && typeof error.stage === 'string' && knownStages.has(error.stage) ? error.stage : undefined;
  console.error('AIS cloud sync failed:', error instanceof Error ? error.name : 'unknown', stage ? `at stage: ${stage}` : '');
  process.exitCode = 1;
});

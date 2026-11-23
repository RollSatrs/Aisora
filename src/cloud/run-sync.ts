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
  console.error('AIS cloud sync failed:', error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});

import { describe, expect, it } from 'vitest';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VercelController } from '../src/vercel/vercel.controller';
import { VercelTelegramService } from '../src/vercel/vercel-telegram.service';
import type { CloudAcademicReader } from '../src/vercel/cloud-academic.reader';
import type { AccountState, StoredAssignment } from '../src/domain/models';

function stubReader(account?: AccountState, tasks: StoredAssignment[] = []) {
  return {
    readAccount: async (_accountRef: string) => account,
    readTasks: async (_accountRef: string) => tasks,
  } as CloudAcademicReader;
}

function makeService(token = '', secret = ''): VercelTelegramService {
  return new VercelTelegramService(new ConfigService({
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_WEBHOOK_SECRET: secret,
  }), stubReader());
}

describe('Vercel HTTP-only deployment', () => {
  it('keeps cloud Telegram tests independent of real Postgres and AIS credentials', () => {
    const reader = stubReader();
    expect(reader).toBeDefined();
    const service = makeService();
    expect(service.configured()).toBe(false);
  });

  it('exposes a safe health endpoint without secrets or a database', () => {
    const controller = new VercelController(makeService());
    expect(controller.health()).toMatchObject({
      status: 'ok',
      mode: 'webhook-smoke-test',
      telegramConfigured: false,
      aisSyncEnabled: false,
      submissionEnabled: false,
    });
  });

  it('does not accept Telegram requests when no token and webhook secret are configured', async () => {
    await expect(makeService().handle(undefined, { update_id: 100 })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(makeService('test-token').handle(undefined, { update_id: 100 })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects invalid Telegram secret before initializing any bot', async () => {
    const webhook = makeService('123:testing', 'a_secret');
    expect(webhook.configured()).toBe(true);
    await expect(webhook.handle(undefined, { update_id: 100 })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(webhook.handle('wrong', { update_id: 100 })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reports a missing Neon DATABASE_URL without attempting a connection', async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const controller = new VercelController(makeService());
      expect(await controller.databaseHealth()).toEqual({
        status: 'not_configured',
        database: 'postgresql',
        tablesChecked: false,
      });
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('never registers a webhook without a correct shared secret', async () => {
    const service = makeService('123:testing', 'a_secret');
    await expect(service.registerWebhook(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.registerWebhook('wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(makeService().registerWebhook('a_secret')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('exposes a phone-friendly setup page without embedding credentials', () => {
    const controller = new VercelController(makeService());
    const html = controller.setupPage();
    expect(html).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(html).toContain("fetch('/telegram/setup'");
    expect(html).not.toContain('123:testing');
  });

  it('rejects malformed Telegram updates before any external request', async () => {
    const webhook = makeService('123:testing', 'a_secret');
    await expect(webhook.handle('a_secret', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

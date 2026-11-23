import { describe, expect, it } from 'vitest';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VercelController } from '../src/vercel/vercel.controller';
import { VercelTelegramService } from '../src/vercel/vercel-telegram.service';

function makeService(token = '', secret = ''): VercelTelegramService {
  return new VercelTelegramService(new ConfigService({
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_WEBHOOK_SECRET: secret,
  }));
}

describe('Vercel HTTP-only deployment', () => {
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

  it('rejects malformed Telegram updates before any external request', async () => {
    const webhook = makeService('123:testing', 'a_secret');
    await expect(webhook.handle('a_secret', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

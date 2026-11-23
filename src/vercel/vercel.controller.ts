import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { VercelTelegramService } from './vercel-telegram.service';

@Controller()
export class VercelController {
  constructor(private readonly telegram: VercelTelegramService) {}

  @Get()
  root() {
    return { project: 'aisora', runtime: 'vercel', message: 'Aisora cloud test API', health: '/health' };
  }

  @Get('health')
  health() {
    return {
      status: 'ok',
      runtime: 'vercel',
      mode: 'webhook-smoke-test',
      telegramConfigured: this.telegram.configured(),
      aisSyncEnabled: false,
      submissionEnabled: false,
    };
  }

  @Post('telegram/webhook')
  async telegramWebhook(
    @Headers('x-telegram-bot-api-secret-token') providedSecret: string | undefined,
    @Body() update: unknown,
  ) {
    return this.telegram.handle(providedSecret, update);
  }
}

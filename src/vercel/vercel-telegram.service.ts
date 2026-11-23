import { timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';

/**
 * Stateless Telegram webhook smoke test. It deliberately doesn't use
 * TelegramBotService because the full bot relies on persistent processes,
 * Redis workers, Playwright, and a Postgres-backed credential vault.
 *
 * Register a *separate testing bot* before routing Telegram updates here.
 * Never use a token that is still being polled by the local Aisora process.
 */
@Injectable()
export class VercelTelegramService {
  private bot?: Bot;
  private initialized?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  configured(): boolean {
    return Boolean(this.config.get<string>('TELEGRAM_BOT_TOKEN')
      && this.config.get<string>('TELEGRAM_WEBHOOK_SECRET'));
  }

  async handle(secretHeader: string | undefined, update: unknown): Promise<{ ok: true }> {
    const expectedSecret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? '';
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    if (!token || !expectedSecret) {
      throw new ServiceUnavailableException('Telegram webhook is not configured');
    }

    // Telegram sets this header when setWebhook has a secret_token.
    // Never accept unauthenticated updates or reveal either secret.
    const supplied = Buffer.from(secretHeader ?? '', 'utf8');
    const expected = Buffer.from(expectedSecret, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new UnauthorizedException();
    }
    if (!update || typeof update !== 'object' || !('update_id' in update)) {
      throw new BadRequestException('Invalid Telegram update');
    }

    const bot = this.getBot(token);
    if (!this.initialized) {
      this.initialized = bot.init().catch((error: unknown) => {
        this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
    await bot.handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
    return { ok: true };
  }

  private getBot(token: string): Bot {
    if (this.bot) return this.bot;
    const bot = new Bot(token);
    bot.command('start', async (ctx) => {
      await ctx.reply('✅ Aisora работает в облаке! Сейчас это тестовый Telegram webhook. Синхронизация АИС пока отключена.');
    });
    bot.command('ping', async (ctx) => {
      await ctx.reply('🏓 Pong! Aisora отвечает с Vercel.');
    });
    bot.on('message:text', async (ctx) => {
      await ctx.reply('☁️ Облачная тестовая версия Aisora. Доступны /start и /ping. Команды /sync, /connect и /tasks подключим после настройки хранилища и фоновой синхронизации.');
    });
    this.bot = bot;
    return bot;
  }
}

import { timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, type Context } from 'grammy';
import { CloudAcademicReader } from './cloud-academic.reader';
import { formatTaskOverview, formatTaskType, formatTaskCategory, type TaskCategory } from '../bot/task-report';
import type { AssignmentType, StoredAssignment } from '../domain/models';

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

  constructor(private readonly config: ConfigService, private readonly academic: CloudAcademicReader) {}

  configured(): boolean {
    return Boolean(this.config.get<string>('TELEGRAM_BOT_TOKEN')
      && this.config.get<string>('TELEGRAM_WEBHOOK_SECRET'));
  }

  /**
   * Register this project's webhook without copying the Telegram bot token
   * into a browser URL, external HTTP client or repository.
   * The operator supplies the existing webhook secret over same-origin HTTPS.
   */
  async registerWebhook(providedSecret: string | undefined): Promise<{ ok: true; webhookUrl: string }> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? '';
    if (!token || !secret) throw new ServiceUnavailableException('Telegram webhook is not configured');
    if (!this.matchesSecret(providedSecret, secret)) throw new UnauthorizedException();

    const domain = this.config.get<string>('AISORA_PUBLIC_URL')
      ?? (this.config.get<string>('VERCEL_PROJECT_PRODUCTION_URL')
        ? `https://${this.config.get<string>('VERCEL_PROJECT_PRODUCTION_URL')}`
        : 'https://aisora-teal.vercel.app');
    const url = new URL('/telegram/webhook', domain).toString();
    if (!url.startsWith('https://')) throw new ServiceUnavailableException('HTTPS required');

    const bot = this.getBot(token);
    await bot.api.setWebhook(url, {
      secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    return { ok: true, webhookUrl: url };
  }

  private matchesSecret(provided: string | undefined, expectedSecret: string): boolean {
    const supplied = Buffer.from(provided ?? '', 'utf8');
    const expected = Buffer.from(expectedSecret, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async handle(secretHeader: string | undefined, update: unknown): Promise<{ ok: true }> {
    const expectedSecret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? '';
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    if (!token || !expectedSecret) {
      throw new ServiceUnavailableException('Telegram webhook is not configured');
    }

    // Telegram sets this header when setWebhook has a secret_token.
    // Never accept unauthenticated updates or reveal either secret.
    if (!this.matchesSecret(secretHeader, expectedSecret)) {
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

  private accountRef(ctx: Context): string | undefined {
    // Reject groups and channel messages to keep academic records private.
    if (ctx.chat?.type !== 'private' || !ctx.from?.id) return undefined;
    return `telegram:${ctx.from.id}`;
  }

  private async withAcademicData(
    ctx: Context,
    callback: (accountRef: string, currentWeek: number, tasks: StoredAssignment[]) => Promise<void>,
  ): Promise<void> {
    const accountRef = this.accountRef(ctx);
    if (!accountRef) {
      await ctx.reply('🔒 Учебные данные доступны только в личном чате с ботом.');
      return;
    }
    try {
      const account = await this.academic.readAccount(accountRef);
      if (!account?.initialSyncCompletedAt) {
        await ctx.reply('📭 Облачная база подключена, но синхронизация АИС для этого аккаунта ещё не выполнялась. Данных о заданиях пока нет; это не означает, что задолженностей нет. /sync появится после настройки отдельного облачного исполнителя.');
        return;
      }
      const tasks = await this.academic.readTasks(accountRef);
      await callback(accountRef, account.currentWeek ?? 1, tasks);
    } catch {
      this.logger.warn('Cloud academic read failed; user data not exposed');
      await ctx.reply('⚠️ Не удалось прочитать данные из Neon. Попробуйте позже; проверьте подключение PostgreSQL.');
    }
  }

  private async status(ctx: Context): Promise<void> {
    const accountRef = this.accountRef(ctx);
    if (!accountRef) {
      await ctx.reply('🔒 Статус доступен только в личном чате.');
      return;
    }
    try {
      const account = await this.academic.readAccount(accountRef);
      if (!account?.initialSyncCompletedAt) {
        await ctx.reply('☁️ Aisora Cloud: PostgreSQL подключена. Первичная синхронизация АИС ещё не выполнена. Реальная отправка файлов отключена.');
        return;
      }
      await ctx.reply([
        '☁️ Aisora Cloud · данные Neon',
        `Учебная неделя: ${account.currentWeek ?? 'неизвестна'}`,
        `Последняя синхронизация: ${account.lastSyncAt?.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) ?? 'нет'}`,
        `Автономный режим: ${account.autonomousStatus}`,
        'Отправка файлов в АИС: отключена',
      ].join('\\n'));
    } catch {
      this.logger.warn('Cloud account status read failed');
      await ctx.reply('⚠️ Ошибка чтения статуса из Neon. Попробуйте позже.');
    }
  }

  private async sroCheck(ctx: Context): Promise<void> {
    await this.withAcademicData(ctx, async (_accountRef, _currentWeek, tasks) => {
      const pending = tasks.filter((task) => task.type === 'SRO' && !task.submitted && task.grade === undefined);
      if (!pending.length) {
        await ctx.reply('✅ В сохранённых данных нет СРО, ожидающих сдачи. Статус зависит от последней синхронизации АИС.');
        return;
      }
      for (const task of pending) {
        const parts = task.content.split('Условие из журнала:');
        const condition = parts.length > 1 ? parts.slice(1).join('Условие из журнала:').trim() : '';
        const label = `📘 ${task.courseName ?? task.courseRef}\\n📝 СРО, неделя ${task.weekNumber}`;
        const result = condition
          ? `✅ Условие сопоставлено с карточкой сдачи.\\n${condition.slice(0, 1100)}${condition.length > 1100 ? '…' : ''}`
          : '⚠️ Условие пока не удалось однозначно сопоставить.';
        await ctx.reply(`${label}\\n${result}\\n\\n🔒 Только чтение сохранённых данных; отправка файлов отключена.`);
      }
    });
  }

  private getBot(token: string): Bot {
    if (this.bot) return this.bot;
    const bot = new Bot(token);
    bot.command('start', async (ctx) => {
      await ctx.reply('✅ Aisora Cloud работает на Vercel!\\n/ping — проверка webhook\\n/status — статус АИС\\n/tasks — сохранённые задания\\n/srocheck — проверка СРО\\n/sync — пока недоступна в облачном режиме.');
    });
    bot.command('ping', async (ctx) => {
      await ctx.reply('🏓 Pong! Aisora отвечает с Vercel.');
    });
    bot.command('status', async (ctx) => this.status(ctx));
    bot.command('tasks', async (ctx) => this.withAcademicData(ctx, async (_ref, week, tasks) => {
      await ctx.reply(formatTaskOverview(tasks, week));
    }));
    bot.command('srocheck', async (ctx) => this.sroCheck(ctx));
    const categories: Record<string, TaskCategory> = {
      debts: 'DEBT', current: 'CURRENT', upcoming: 'UPCOMING', completed: 'COMPLETED', clarification: 'CLARIFICATION',
    };
    for (const [command, category] of Object.entries(categories)) {
      bot.command(command, async (ctx) => this.withAcademicData(ctx, async (_ref, week, tasks) => {
        for (const message of formatTaskCategory(tasks, week, category)) await ctx.reply(message);
      }));
    }
    const types: Record<string, AssignmentType> = { sro: 'SRO', srsp: 'SRSP', labs: 'LAB' };
    for (const [command, type] of Object.entries(types)) {
      bot.command(command, async (ctx) => this.withAcademicData(ctx, async (_ref, week, tasks) => {
        for (const message of formatTaskType(tasks, week, type)) await ctx.reply(message);
      }));
    }
    bot.command('sync', async (ctx) => {
      await ctx.reply('⏳ /sync пока не подключена. Длительный Playwright-запуск будет выполняться отдельным облачным заданием, не внутри webhook Vercel.');
    });
    bot.command('connect', async (ctx) => {
      await ctx.reply('🔒 Подключение учётной записи АИС в облаке пока отключено. Не присылайте логин или пароль в этот чат.');
    });
    bot.on('message:text', async (ctx) => {
      await ctx.reply('☁️ Aisora Cloud. Доступны /ping, /status, /tasks, /srocheck. Синхронизация АИС пока отключена.');
    });
    this.bot = bot;
    return bot;
  }
}

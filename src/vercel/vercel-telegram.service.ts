import { timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, type Context } from 'grammy';
import { CloudAcademicReader } from './cloud-academic.reader';
import { CloudCredentialService } from './cloud-credential.service';
import { CloudSyncDispatcher } from './cloud-sync.dispatcher';
import { formatTaskOverview, formatTaskType, formatTaskCategory, type TaskCategory } from '../bot/task-report';
import type { AssignmentType, StoredAssignment } from '../domain/models';

/**
 * Serverless Telegram webhook with read-only PostgreSQL commands. It deliberately doesn't use
 * TelegramBotService because the full bot relies on persistent processes,
 * Redis workers, Playwright, and a Postgres-backed credential vault.
 *
 * Register a *separate testing bot* before routing Telegram updates here.
 * Never use a token that is still being polled by the local Aisora process.
 */
@Injectable()
export class VercelTelegramService {
  private readonly logger = new Logger(VercelTelegramService.name);
  private bot?: Bot;
  private initialized?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly academic: CloudAcademicReader,
    private readonly credentials: CloudCredentialService,
    private readonly cloudSync: CloudSyncDispatcher,
  ) {}

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
      ].join('\n'));
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
        const label = `📘 ${task.courseName ?? task.courseRef}\n📝 СРО, неделя ${task.weekNumber}`;
        const result = condition
          ? `✅ Условие сопоставлено с карточкой сдачи.\n${condition.slice(0, 1100)}${condition.length > 1100 ? '…' : ''}`
          : '⚠️ Условие пока не удалось однозначно сопоставить.';
        await ctx.reply(`${label}\n${result}\n\n🔒 Только чтение сохранённых данных; отправка файлов отключена.`);
      }
    });
  }

  private async beginConnect(ctx: Context): Promise<void> {
    const accountRef = this.accountRef(ctx);
    if (!accountRef) {
      await ctx.reply('🔒 Подключение АИС доступно только в личном чате.');
      return;
    }
    if (!this.credentials.configured()) {
      await ctx.reply('🔒 Подключение пока недоступно: администратор должен настроить ключ шифрования.');
      return;
    }
    try {
      await this.credentials.begin(accountRef);
      await ctx.reply('🔒 Подключение АИС. Введите ваш 5-значный логин. Затем бот запросит пароль. Для отмены: /cancel. Данные будут зашифрованы; Telegram может хранить отправленные сообщения в своей инфраструктуре.');
    } catch {
      this.logger.warn('Connect initialization failed');
      await ctx.reply('⚠️ Не удалось начать подключение к АИС. Повторите позже.');
    }
  }

  private async handleConnectInput(ctx: Context & { message: { text: string } }): Promise<boolean> {
    const accountRef = this.accountRef(ctx);
    if (!accountRef) return false;
    if (!this.credentials.configured()) return false;
    const draft = await this.credentials.getDraft(accountRef).catch(() => undefined);
    if (!draft) return false;
    const value = ctx.message.text.trim();
    // Best effort only: Telegram deletion may fail and is not a guarantee
    // that the message is purged from Telegram's systems.
    await ctx.deleteMessage().catch(() => undefined);
    if (!draft.login) {
      if (!/^\\d{5}$/.test(value)) {
        await ctx.reply('Логин должен состоять из 5 цифр. Повторите ввод или /cancel.');
      } else {
        await this.credentials.setLogin(accountRef, value);
        await ctx.reply('Введите пароль от АИС. Сообщение с паролем будет удалено ботом при возможности. Для отмены: /cancel.');
      }
      return true;
    }
    if (value.length < 6 || value.length > 128) {
      await ctx.reply('Пароль должен содержать от 6 до 128 символов. Повторите ввод или /cancel.');
      return true;
    }
    try {
      await this.credentials.finish(accountRef, value);
      await ctx.reply('✅ Данные АИС зашифрованы и сохранены в Neon. Авторизацию ещё нужно подтвердить первой синхронизацией. Для неё потребуется настроенный облачный исполнитель.');
    } catch {
      this.logger.warn('Connect completion failed');
      await ctx.reply('⚠️ Не удалось сохранить учётные данные. Попробуйте /connect снова.');
    }
    return true;
  }

  private async beginSync(ctx: Context): Promise<void> {
    const accountRef = this.accountRef(ctx);
    if (!accountRef) {
      await ctx.reply('🔒 Синхронизация доступна только в личном чате.');
      return;
    }
    if (!this.cloudSync.configured()) {
      await ctx.reply('⏳ Облачный исполнитель ещё не настроен. Требуется GitHub Actions token и доступ к Neon в Actions.');
      return;
    }
    try {
      await this.cloudSync.dispatch(accountRef);
      await ctx.reply('✅ Облачная синхронизация запрошена в GitHub Actions. Запуск может занять несколько минут. Данные появятся в /tasks после завершения.');
    } catch {
      await ctx.reply('⚠️ Не удалось запустить облачную синхронизацию. Проверьте /connect и настройки GitHub Actions.');
    }
  }

  private getBot(token: string): Bot {
    if (this.bot) return this.bot;
    const bot = new Bot(token);
    bot.command('start', async (ctx) => {
      await ctx.reply('✅ Aisora Cloud работает на Vercel!\n/ping — проверка webhook\n/status — статус АИС\n/tasks — сохранённые задания\n/srocheck — проверка СРО\n/sync — пока недоступна в облачном режиме.');
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
    bot.command('sync', async (ctx) => this.beginSync(ctx));
    bot.command('connect', async (ctx) => this.beginConnect(ctx));
    bot.command('cancel', async (ctx) => {
      const ref = this.accountRef(ctx);
      if (!ref) return;
      if (this.credentials.configured()) await this.credentials.cancel(ref).catch(() => undefined);
      await ctx.reply('Подключение отменено.');
    });
    bot.on('message:text', async (ctx) => {
      if (await this.handleConnectInput(ctx)) return;
      await ctx.reply('☁️ Aisora Cloud. Доступны /ping, /connect, /sync, /status, /tasks и /srocheck.');
    });
    this.bot = bot;
    return bot;
  }
}

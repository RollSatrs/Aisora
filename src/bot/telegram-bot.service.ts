import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InlineKeyboard, Keyboard } from 'grammy';
import { CredentialVaultService } from '../auth/credential-vault.service';
import { AutonomousService, InitialSyncRequiredError } from '../autonomous/autonomous.service';
import { SyncService } from '../sync/sync.service';
import type { AssignmentType } from '../domain/models';
import { AisNavigationDecisionError } from '../university/adaptive-ais-navigator';
import {
  AbuCredentialsRejectedError,
  AbuReadTimeoutError,
  AbuSessionRequiredError,
  AutomationPermissionRequiredError,
} from '../university/abu-university.adapter';
import { formatTaskCategory, formatTaskOverview, formatTaskType, type TaskCategory } from './task-report';

const keyboard = new Keyboard()
  .text('Синхронизировать').text('Мои задания').row()
  .text('Долги').text('Текущая неделя').row()
  .text('Будущие задания').text('Выполненные').row()
  .text('📝 СРО').text('📚 СРСП').text('🧪 Лабораторные').row()
  .text('Настроить лабораторные').row()
  .text('Запустить автономный режим').text('Остановить агента').row()
  .text('Требуют проверки').resized();

type ConnectionStep = { step: 'login' } | { step: 'password'; login: string };

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly connectionSteps = new Map<number, ConnectionStep>();
  private readonly syncingAccounts = new Set<string>();
  private bot?: Bot;

  constructor(
    private readonly config: ConfigService,
    private readonly credentialVault: CredentialVaultService,
    private readonly syncService: SyncService,
    private readonly autonomousService: AutonomousService,
  ) {}

  onModuleInit(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.log('TELEGRAM_BOT_TOKEN is empty; bot polling is disabled');
      return;
    }
    this.bot = new Bot(token);
    this.registerHandlers(this.bot);
    this.bot.catch(async (botError) => {
      const error = botError.error;
      const name = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(`Telegram update failed safely: ${name}`);
      await botError.ctx.reply('Произошла внутренняя ошибка. Бот продолжает работать; попробуйте ещё раз.').catch(() => undefined);
    });
    void this.bot.start({ onStart: () => this.logger.log('Telegram bot started') });
  }

  onModuleDestroy(): void { this.bot?.stop(); }

  private accountId(ctx: { from?: { id: number } }): string { return `telegram:${ctx.from?.id ?? 'unknown'}`; }

  private registerHandlers(bot: Bot): void {
    bot.command('start', async (ctx) => ctx.reply('Aisora готова. Выполните /connect один раз, затем бот будет входить в ABU AIS и синхронизироваться автоматически.', { reply_markup: keyboard }));
    bot.command('connect', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) {
        await ctx.reply('Подключение AIS доступно только в личном чате с ботом.');
        return;
      }
      this.connectionSteps.set(ctx.from.id, { step: 'login' });
      await ctx.reply('Введите логин ABU AIS. Сообщение будет сразу удалено после обработки. Для отмены: /cancel');
    });
    bot.command('cancel', async (ctx) => {
      if (ctx.from) this.connectionSteps.delete(ctx.from.id);
      await ctx.reply('Подключение отменено.');
    });
    bot.command('sync', async (ctx) => this.replySync(ctx, this.accountId(ctx)));
    bot.command('tasks', async (ctx) => this.replyOverview(ctx, this.accountId(ctx)));
    bot.command('debts', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'DEBT'));
    bot.command('current', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'CURRENT'));
    bot.command('upcoming', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'UPCOMING'));
    bot.command('completed', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'COMPLETED'));
    bot.command('clarification', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'CLARIFICATION'));
    bot.command('labfocus', async (ctx) => this.replyLabFocus(ctx, this.accountId(ctx)));
    bot.command('sro', async (ctx) => this.replyTaskType(ctx, this.accountId(ctx), 'SRO'));
    bot.command('srocheck', async (ctx) => this.replySroReadiness(ctx, this.accountId(ctx)));
    bot.command('srsp', async (ctx) => this.replyTaskType(ctx, this.accountId(ctx), 'SRSP'));
    bot.command('labs', async (ctx) => this.replyTaskType(ctx, this.accountId(ctx), 'LAB'));
    bot.command('status', async (ctx) => {
      const state = await this.autonomousService.status(this.accountId(ctx));
      await ctx.reply(`Подключение: ABU AIS\nУчебная неделя: ${state.currentWeek ?? 'ещё не определена'}\nАвтономный режим: ${state.autonomousStatus}\nInitial sync: ${state.initialSyncCompletedAt ? 'готов' : 'не выполнен'}`);
    });
    bot.command('settings', async (ctx) => ctx.reply('Часовой пояс: Asia/Almaty\nАвтоматический вход: /connect\nРеальная отправка в AIS: отключена'));
    bot.hears('Синхронизировать', async (ctx) => this.replySync(ctx, this.accountId(ctx)));
    bot.hears('Мои задания', async (ctx) => this.replyOverview(ctx, this.accountId(ctx)));
    bot.hears('Долги', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'DEBT'));
    bot.hears('Текущая неделя', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'CURRENT'));
    bot.hears('Будущие задания', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'UPCOMING'));
    bot.hears('Выполненные', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'COMPLETED'));
    bot.hears('📝 СРО', async (ctx) => this.replyTaskType(ctx, this.accountId(ctx), 'SRO'));
    bot.hears('📚 СРСП', async (ctx) => this.replyTaskType(ctx, this.accountId(ctx), 'SRSP'));
    bot.hears('🧪 Лабораторные', async (ctx) => this.replyTaskType(ctx, this.accountId(ctx), 'LAB'));
    bot.hears('Настроить лабораторные', async (ctx) => this.replyLabFocus(ctx, this.accountId(ctx)));
    bot.hears('Требуют проверки', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'CLARIFICATION'));
    bot.hears('Требуют уточнения', async (ctx) => this.replyTaskCategory(ctx, this.accountId(ctx), 'CLARIFICATION'));
    bot.callbackQuery(/^labfocus:(on|off):(.+)$/, async (ctx) => {
      const enabled = ctx.match[1] === 'on';
      const courseRef = ctx.match[2]!;
      await this.syncService.setCourseLabFocus(this.accountId(ctx), courseRef, enabled);
      await ctx.answerCallbackQuery(enabled ? 'Акцент на лабораторные включён' : 'Акцент на лабораторные выключен');
      const view = await this.labFocusView(this.accountId(ctx));
      await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
    });
    bot.hears('Запустить автономный режим', async (ctx) => {
      try {
        const checks = await this.autonomousService.start(this.accountId(ctx));
        await ctx.reply(`Автономный режим запущен. Запланировано проверок: ${checks.length}`);
      } catch (error) {
        if (error instanceof InitialSyncRequiredError) await ctx.reply('Сначала выполните первоначальную синхронизацию.');
        else throw error;
      }
    });
    bot.hears('Остановить агента', async (ctx) => {
      await this.autonomousService.stop(this.accountId(ctx));
      await ctx.reply('Автономный режим остановлен.');
    });
    bot.on('message:text', async (ctx) => this.handleConnectionInput(ctx));
  }

  private async handleConnectionInput(ctx: Context & { message: { text: string } }): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== 'private') return;
    const state = this.connectionSteps.get(ctx.from.id);
    if (!state) return;
    const value = ctx.message.text.trim();
    await ctx.deleteMessage().catch(() => undefined);

    if (state.step === 'login') {
      if (!/^\d{5}$/.test(value)) {
        await ctx.reply('Логин должен состоять из 5 цифр. Введите ещё раз или используйте /cancel.');
        return;
      }
      this.connectionSteps.set(ctx.from.id, { step: 'password', login: value });
      await ctx.reply('Теперь введите пароль ABU AIS. Сообщение будет сразу удалено и не попадёт в журналы Aisora.');
      return;
    }

    if (value.length < 6 || value.length > 128) {
      await ctx.reply('Пароль имеет неожиданную длину. Введите ещё раз или используйте /cancel.');
      return;
    }
    await this.credentialVault.save(this.accountId(ctx), { login: state.login, password: value });
    this.connectionSteps.delete(ctx.from.id);
    await ctx.reply('ABU AIS подключён. Данные зашифрованы; теперь запустите /sync. После истечения сессии Aisora войдёт повторно автоматически.');
  }

  private async replySync(ctx: Context, accountId: string): Promise<void> {
    if (this.syncingAccounts.has(accountId)) {
      await ctx.reply('Синхронизация уже выполняется. Дождитесь результата текущего запроса.');
      return;
    }
    this.syncingAccounts.add(accountId);
    try {
      const progress = await ctx.reply('⏳ Синхронизация: запускаю процесс');
      let lastStage = '';
      const updateProgress = async (stage: string): Promise<void> => {
        if (stage === lastStage) return;
        lastStage = stage;
        await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, `⏳ Синхронизация: ${stage}`).catch(() => undefined);
      };
      const result = await this.syncService.synchronize(accountId, new Date(), updateProgress);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        progress.message_id,
        `✅ Синхронизация завершена: ${result.assignments} заданий, долгов: ${result.debts}, требуют проверки: ${result.clarification}.`,
      );
    } catch (error) {
      if (error instanceof AbuCredentialsRejectedError) {
        await ctx.reply('AIS не подтвердил вход. Проверьте логин и пароль через /connect и повторите /sync.');
        return;
      }
      if (error instanceof AbuSessionRequiredError) {
        await ctx.reply('Сначала подключите аккаунт AIS командой /connect.');
        return;
      }
      if (error instanceof AutomationPermissionRequiredError) {
        await ctx.reply('Read-only автоматизация AIS отключена в настройках сервера.');
        return;
      }
      if (error instanceof AbuReadTimeoutError) {
        await ctx.reply(`AIS не ответил вовремя. Этап: ${error.stage}. Бот продолжает работать; повторите /sync.`);
        return;
      }
      if (error instanceof AisNavigationDecisionError) {
        await ctx.reply(`Агент не нашёл безопасный переход для цели «${error.goal}». Никакое действие не выполнено.`);
        return;
      }
      throw error;
    } finally {
      this.syncingAccounts.delete(accountId);
    }
  }

  private async replyOverview(ctx: Context, accountId: string): Promise<void> {
    const { tasks, currentWeek } = await this.syncService.taskContext(accountId);
    await ctx.reply(formatTaskOverview(tasks, currentWeek), { reply_markup: keyboard });
  }

  private async replyTaskCategory(ctx: Context, accountId: string, category: TaskCategory): Promise<void> {
    const { tasks, currentWeek } = await this.syncService.taskContext(accountId);
    for (const message of formatTaskCategory(tasks, currentWeek, category)) await ctx.reply(message);
  }

  private async replyTaskType(ctx: Context, accountId: string, type: AssignmentType): Promise<void> {
    const { tasks, currentWeek } = await this.syncService.taskContext(accountId);
    for (const message of formatTaskType(tasks, currentWeek, type)) await ctx.reply(message);
  }

  /** Read-only diagnostics for the SRO matcher; does not open a file picker. */
  private async replySroReadiness(ctx: Context, accountId: string): Promise<void> {
    const { tasks } = await this.syncService.taskContext(accountId);
    const pending = tasks.filter((task) => task.type === 'SRO' && !task.submitted && task.grade === undefined);
    if (!pending.length) {
      await ctx.reply('Не найдено СРО, ожидающих сдачи.');
      return;
    }
    for (const task of pending) {
      const parts = task.content.split('Условие из журнала:');
      const condition = parts.length > 1 ? parts.slice(1).join('Условие из журнала:').trim() : '';
      const label = `📘 ${task.courseName ?? task.courseRef}\n📝 СРО, неделя ${task.weekNumber}`;
      const result = condition
        ? `✅ Условие сопоставлено с карточкой сдачи.\n${condition.slice(0, 1100)}${condition.length > 1100 ? '…' : ''}`
        : '⚠️ Условие не удалось однозначно сопоставить; автоматическая отправка запрещена.';
      await ctx.reply(`${label}\n${result}\n\n🔒 Режим проверки: без отправки файлов.`);
    }
  }

  private async replyLabFocus(ctx: Context, accountId: string): Promise<void> {
    const view = await this.labFocusView(accountId);
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  }

  private async labFocusView(accountId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const settings = await this.syncService.listCourseFocus(accountId);
    const keyboard = new InlineKeyboard();
    for (const setting of settings) {
      const icon = setting.labFocus ? '⭐' : '○';
      const action = setting.labFocus ? 'off' : 'on';
      keyboard.text(`${icon} ${setting.courseName.slice(0, 45)}`, `labfocus:${action}:${setting.courseRef}`).row();
    }
    const text = settings.length
      ? 'Выберите дисциплины, где нужно глубоко открывать и анализировать лабораторные. ⭐ — включено. СРСП и СРО проверяются всегда.'
      : 'Сначала выполните /sync, чтобы получить список дисциплин.';
    return { text, keyboard };
  }
}

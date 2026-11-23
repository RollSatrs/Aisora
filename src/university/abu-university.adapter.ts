import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  RequestTimeoutException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { CredentialVaultService } from '../auth/credential-vault.service';
import type {
  AssignmentSnapshot,
  CourseSnapshot,
  ScheduleEventSnapshot,
  UniversitySnapshot,
  WeekSnapshot,
} from '../domain/models';
import { AdaptiveAisNavigator } from './adaptive-ais-navigator';
import {
  contentType,
  futureSroWeeks,
  independentWorkType,
  isRelevantSentSubject,
  normalizeText,
  parseContentAssignments,
  parseSentMessageRows,
  parseSroText,
  stableExternalRef,
  type SentMessageObservation,
} from './abu-parsers';
import { AisContentExtractor } from './ais-content-extractor';
import { extractSroRequirements, matchSroBrief, type WeeklySroBrief } from './sro-assignment-matcher';
import { classifySroHistory } from './sro-history';
import { AisHtmlDiagnostics } from './ais-html-diagnostics';
import { SyncDiagnosticsRecorder } from './sync-diagnostics';
import type { SyncProgress, UniversityAdapter, UniversityReadOptions } from './university-adapter';

const AIS_URL = 'https://ais.semuniver.kz/login.php';
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

export function activePeriodWeeks(currentWeek: number): number[] {
  const start = currentWeek <= 8 ? 1 : 9;
  return Array.from({ length: currentWeek - start + 1 }, (_, index) => currentWeek - index);
}

export class AbuSessionRequiredError extends UnauthorizedException {
  constructor() {
    super('ABU AIS session is missing or expired and no saved credentials are available. Use /connect first.');
  }
}

export class AbuCredentialsRejectedError extends UnauthorizedException {
  constructor() {
    super('ABU AIS rejected the saved credentials. Use /connect to update them.');
  }
}

export class AutomationPermissionRequiredError extends ForbiddenException {
  constructor() {
    super('ABU AIS read-only automation requires explicit authorization. Set AIS_AUTOMATION_APPROVED=true only after approval.');
  }
}

export class AbuReadTimeoutError extends RequestTimeoutException {
  constructor(readonly stage: string) {
    super(`ABU AIS did not respond during stage: ${stage}`);
  }
}

export class AbuAccessDeniedError extends ForbiddenException {
  constructor() {
    super('ABU AIS denied access to the cloud runner (HTTP 403). Ask the university about approved remote access.');
  }
}

@Injectable()
export class AbuUniversityAdapter implements UniversityAdapter, OnModuleDestroy {
  readonly key = 'abu-ais';
  private readonly logger = new Logger(AbuUniversityAdapter.name);
  private get htmlDiagnostics(): AisHtmlDiagnostics { return new AisHtmlDiagnostics(this.config); }
  private readonly contexts = new Map<string, BrowserContext>();
  private operation = Promise.resolve();
  private lastRequestAt = 0;
  private syncDiagnostics?: SyncDiagnosticsRecorder;

  constructor(
    private readonly config: ConfigService,
    private readonly credentialVault: CredentialVaultService,
    private readonly navigator: AdaptiveAisNavigator,
    private readonly contentExtractor: AisContentExtractor,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.contexts.values()].map((context) => context.close()));
    this.contexts.clear();
  }

  async readSnapshot(
    accountId: string,
    onProgress?: SyncProgress,
    options: UniversityReadOptions = {},
  ): Promise<UniversitySnapshot> {
    if (this.config.get<string>('AIS_AUTOMATION_APPROVED') !== 'true') {
      throw new AutomationPermissionRequiredError();
    }
    return this.serialized(async () => {
      await onProgress?.('Запускаю браузер AIS');
      const page = await this.withStage('запуск браузерной сессии', () => this.page(accountId));
      await this.throttle();
      await onProgress?.('Открываю главную страницу AIS');
      const initialResponse = await this.withStage('открытие AIS', () => page.goto(AIS_URL, { waitUntil: 'domcontentloaded' }));
      if (this.config.get<string>('AIS_CLOUD_PAGE_DIAGNOSTICS') === 'true') {
        this.logger.warn(`AIS initial navigation: HTTP ${initialResponse?.status() ?? 'no-response'}; ${this.safeAisLocation(page)}`);
      }
      if (initialResponse?.status() === 403) {
        throw new AbuAccessDeniedError();
      }
      await this.withStage('ожидание загрузки главной страницы', () => this.waitForHomeReady(page));
      if (await page.getByRole('button', { name: 'Войти', exact: true }).isVisible().catch(() => false)) {
        await onProgress?.('Выполняю автоматический вход');
        await this.withStage('автоматический вход', () => this.login(page, accountId));
      }

      // Start AFTER login, excluding credentials from the trace.
      if (this.config.get<string>('AIS_SYNC_DIAGNOSTICS_ENABLED') === 'true') {
        try {
          this.syncDiagnostics = await SyncDiagnosticsRecorder.start(page);
          this.logger.log('Local sync diagnostics started after authentication');
        } catch {
          this.logger.warn('Sync diagnostics unavailable; normal sync continues');
        }
      }
      try {
      await onProgress?.('Читаю список дисциплин');
      const dashboardCourses = await this.withStage('чтение списка дисциплин', () => this.readDashboardCourses(page));
      await onProgress?.('Открываю электронный журнал');
      await this.withStage('открытие электронного журнала', () => this.openJournal(page, onProgress));
      await onProgress?.('Читаю задания, оценки и отправки');
      const journal = await this.withStage(
        'чтение заданий и отправок',
        () => this.readJournal(page, dashboardCourses, onProgress, options, accountId),
      );
      await this.throttle();
      await onProgress?.('Читаю расписание');
      await this.withStage('возврат на главную страницу', () => page.goto(AIS_URL, { waitUntil: 'domcontentloaded' }));
      await this.withStage('ожидание главной страницы', () => this.waitForHomeReady(page));
      const schedule = await this.withStage('чтение расписания', () => this.readSchedule(page, journal.courses, journal.currentWeek));
      return {
        session: 'ACTIVE',
        currentWeek: journal.currentWeek,
        courses: journal.courses,
        weeks: journal.weeks,
        assignments: journal.assignments,
        schedule,
      };
      } finally {
        const recorder = this.syncDiagnostics;
        this.syncDiagnostics = undefined;
        if (recorder) {
          try {
            const outputDir = await recorder.finish();
            this.logger.log(`Local sync diagnostic files saved in ${outputDir}`);
          } catch {
            this.logger.warn('Failed to save optional sync diagnostics');
          }
        }
      }
    });
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  private async withStage<T>(stage: string, action: () => Promise<T>): Promise<T> {
    try {
      return this.syncDiagnostics ? await this.syncDiagnostics.stage(stage, action) : await action();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new AbuReadTimeoutError(stage);
      throw error;
    }
  }

  /**
   * The login page can change its markup without changing the AIS origin.
   * Report only bounded structural counters and HTTP status (no URL paths,
   * page titles, content, screenshots, cookies or credentials).
   */
  private safeAisLocation(page: Page): string {
    try {
      const location = new URL(page.url());
      return location.origin === 'https://ais.semuniver.kz' ? 'AIS origin' : 'non-AIS origin';
    } catch {
      return 'unknown origin';
    }
  }

  private async safeInitialPageDiagnostics(page: Page): Promise<void> {
    try {
      const [loginInputs, passwordInputs, profileCards, visibleInputs, frameCount] = await Promise.all([
        page.locator('input[name="login"]').count(),
        page.locator('input[type="password"]').count(),
        page.locator('.box-body.box-profile').count(),
        page.locator('input:visible').count(),
        Promise.resolve(page.frames().length),
      ]);
      this.logger.warn(`AIS page structure: ${this.safeAisLocation(page)}, loginInputs=${Math.min(loginInputs, 20)}, passwordInputs=${Math.min(passwordInputs, 20)}, profileCards=${Math.min(profileCards, 20)}, visibleInputs=${Math.min(visibleInputs, 20)}, frames=${Math.min(frameCount, 20)}`);
    } catch {
      this.logger.warn('AIS page structure inspection unavailable');
    }
  }

  private async waitForHomeReady(page: Page): Promise<void> {
    try {
      await page.locator('.box-body.box-profile, input[name="login"]').first().waitFor({ state: 'visible' });
    } catch (error) {
      if (this.config.get<string>('AIS_CLOUD_PAGE_DIAGNOSTICS') === 'true') {
        await this.safeInitialPageDiagnostics(page);
      }
      throw error;
    }
  }

  private async page(accountId: string): Promise<Page> {
    let context = this.contexts.get(accountId);
    if (!context) {
      const profileRoot = this.config.get<string>('AIS_BROWSER_PROFILE_DIR') || join(homedir(), '.aisora', 'abu-browser-profile');
      const profileName = createHash('sha256').update(accountId).digest('hex').slice(0, 16);
      const browserChannel = this.config.get<string>('AIS_BROWSER_CHANNEL');
      context = await chromium.launchPersistentContext(join(profileRoot, profileName), {
        ...(browserChannel === 'chromium' ? {} : { channel: browserChannel || 'chrome' }),
        headless: this.config.get<string>('AIS_BROWSER_HEADLESS') === 'true',
        viewport: null,
        args: [
          '--disable-save-password-bubble',
          '--disable-features=PasswordLeakDetection,PasswordManagerOnboarding',
        ],
      });
      context.setDefaultTimeout(Number(this.config.get<string>('AIS_PAGE_TIMEOUT_MS') ?? 300_000));
      context.setDefaultNavigationTimeout(Number(this.config.get<string>('AIS_NAVIGATION_TIMEOUT_MS') ?? 300_000));
      this.contexts.set(accountId, context);
    }
    return context.pages()[0] ?? context.newPage();
  }

  private async login(page: Page, accountId: string): Promise<void> {
    const credentials = await this.credentialVault.get(accountId);
    if (!credentials) throw new AbuSessionRequiredError();
    await page.locator('input[name="login"]').fill(credentials.login);
    await page.locator('input[name="password"]').fill(credentials.password);
    await this.throttle();
    await page.locator('button[type="submit"]').click();
    const loginTimeout = Number(this.config.get<string>('AIS_LOGIN_TIMEOUT_MS') ?? 90_000);
    const authenticated = await page.locator('.box-body.box-profile')
      .waitFor({ state: 'visible', timeout: loginTimeout })
      .then(() => true)
      .catch(() => false);
    if (!authenticated) {
      throw new AbuCredentialsRejectedError();
    }
  }

  private async diagnosticClick<T>(label: string, locator: import('playwright').Locator, action: () => Promise<T>): Promise<T> {
    return this.syncDiagnostics ? this.syncDiagnostics.click(label, locator, action) : action();
  }

  private async throttle(): Promise<void> {
    const started = Date.now();
    const minimum = Number(this.config.get<string>('AIS_MIN_REQUEST_INTERVAL_MS') ?? 1200);
    const wait = Math.max(0, this.lastRequestAt + minimum - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    this.syncDiagnostics?.recordThrottle(started);
  }

  private async readDashboardCourses(page: Page): Promise<CourseSnapshot[]> {
    const names = await page.locator('table td[colspan="10"]').allTextContents();
    return names.map(normalizeText).filter((name) => /\([A-ZА-Я0-9]+\s*\d+\)$/i.test(name)).map((name) => ({
      externalRef: `dashboard-${stableExternalRef([name])}`,
      name,
    }));
  }

  private async readSchedule(page: Page, courses: CourseSnapshot[], currentWeek: number): Promise<ScheduleEventSnapshot[]> {
    const events: ScheduleEventSnapshot[] = [];
    const weekButton = page.getByRole('button', { name: String(currentWeek), exact: true });
    if (!(await weekButton.count())) return events;
    await this.throttle();
    await weekButton.click();
    await page.waitForTimeout(350);
    const monday = new Date();
    const day = monday.getDay() || 7;
    monday.setDate(monday.getDate() - day + 1);
    monday.setHours(0, 0, 0, 0);
    for (let dayIndex = 0; dayIndex < WEEKDAYS.length; dayIndex += 1) {
      const dayLink = page.getByRole('link', { name: WEEKDAYS[dayIndex], exact: true }).last();
      if (!(await dayLink.count())) continue;
      await this.throttle();
      await dayLink.click();
      await page.waitForTimeout(250);
      const rows = await page.locator('table tr').allTextContents();
      for (const row of rows) {
        const text = normalizeText(row);
        const match = text.match(/^\d+\s+(\d{2}:\d{2})\s+-\s+(\d{2}:\d{2})\s+(.+?)\s+\([A-ZА-Я]\)/i);
        if (!match) continue;
        const course = courses.find((candidate) => text.includes(candidate.name.replace(/\s*\([^)]*\)$/, '')));
        if (!course) continue;
        const date = new Date(monday);
        date.setDate(monday.getDate() + dayIndex);
        const [startHour, startMinute] = match[1]!.split(':').map(Number);
        const [endHour, endMinute] = match[2]!.split(':').map(Number);
        const startsAt = new Date(date); startsAt.setHours(startHour!, startMinute!, 0, 0);
        const endsAt = new Date(date); endsAt.setHours(endHour!, endMinute!, 0, 0);
        events.push({
          externalRef: `schedule-${stableExternalRef([course.externalRef, startsAt.toISOString(), endsAt.toISOString()])}`,
          courseRef: course.externalRef,
          startsAt,
          endsAt,
        });
      }
    }
    return events;
  }

  private async openJournal(page: Page, onProgress?: SyncProgress): Promise<void> {
    const disciplineSelector = page.getByText('Выберите Вашу дисциплину', { exact: true }).first();
    if (await disciplineSelector.isVisible().catch(() => false)) {
      this.logger.log('AIS journal header is visible; checking course menu readiness');
      await this.waitForJournalReady(page, onProgress);
      return;
    }

    const interactiveTargets = page.locator('a, button, [role="link"], [role="button"]');
    const journalTargets = interactiveTargets.filter({ hasText: /Электронный журнал/i });
    const journalLink = journalTargets
      .filter({ visible: true })
      .first();
    if (!(await journalLink.isVisible().catch(() => false))) {
      const studyLink = interactiveTargets.filter({ hasText: /^\s*Обучение\s*$/i })
        .filter({ visible: true })
        .first();
      if (await studyLink.isVisible().catch(() => false)) {
        await this.throttle();
        await this.diagnosticClick('study-menu-open', studyLink, () => studyLink.click());
        await journalLink.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
      }
    }

    if (await journalLink.isVisible().catch(() => false)) {
      await onProgress?.('Открываю электронный журнал');
      await this.throttle();
      const started = Date.now();
      await this.diagnosticClick('journal-open', journalLink, () => journalLink.click());
      await disciplineSelector.waitFor({
        state: 'visible',
        timeout: Number(this.config.get<string>('AIS_PAGE_TIMEOUT_MS') ?? 300_000),
      });
      this.logger.log(`AIS journal header appeared after ${Date.now() - started}ms`);
      await this.waitForJournalReady(page, onProgress);
      return;
    }

    // The submenu is server-rendered but Platonus sometimes ignores the
    // expand animation click. Invoking the already matched read-only journal
    // target is deterministic and does not touch any form or mutation action.
    if (await journalTargets.count()) {
      await onProgress?.('Открываю электронный журнал');
      await this.throttle();
      const started = Date.now();
      await journalTargets.first().evaluate((element) => (element as HTMLElement).click());
      await disciplineSelector.waitFor({
        state: 'visible',
        timeout: Number(this.config.get<string>('AIS_PAGE_TIMEOUT_MS') ?? 300_000),
      });
      this.logger.log(`AIS journal header appeared after ${Date.now() - started}ms (fallback navigation)`);
      await this.waitForJournalReady(page, onProgress);
      return;
    }

    await this.navigator.navigate(page, {
      goal: 'Открыть электронный журнал обучения',
      expected: disciplineSelector,
      semanticHints: ['Электронный журнал', 'Обучение'],
      onProgress,
    });
    await this.waitForJournalReady(page, onProgress);
  }

  /**
   * The AIS journal header can render while its course dropdown is still
   * being hydrated. Wait for the menu trigger to be enabled instead of
   * treating a visible heading as a fully ready journal.
   */
  private async waitForJournalReady(page: Page, onProgress?: SyncProgress): Promise<void> {
    const started = Date.now();
    const selector = page.getByRole('link', { name: 'Выберите Вашу дисциплину' }).first();
    await onProgress?.('Ожидаю список дисциплин в журнале');
    await selector.waitFor({
      state: 'visible',
      timeout: Number(this.config.get<string>('AIS_JOURNAL_READY_TIMEOUT_MS') ?? 45_000),
    });
    await page.waitForFunction(() => {
      const element = [...document.querySelectorAll('a')].find((a) =>
        (a.textContent ?? '').replace(/\s+/g, ' ').trim() === 'Выберите Вашу дисциплину',
      );
      return Boolean(element && element.getAttribute('aria-disabled') !== 'true' &&
        !element.hasAttribute('disabled'));
    }, undefined, { timeout: Number(this.config.get<string>('AIS_JOURNAL_READY_TIMEOUT_MS') ?? 45_000) });
    this.logger.log(`AIS journal course selector ready after ${Date.now() - started}ms`);
  }

  private async readJournal(
    page: Page,
    dashboardCourses: CourseSnapshot[],
    onProgress: SyncProgress | undefined,
    options: UniversityReadOptions,
    diagnosticAccountId: string,
  ): Promise<{
    currentWeek: number;
    courses: CourseSnapshot[];
    weeks: WeekSnapshot[];
    assignments: AssignmentSnapshot[];
  }> {
    const menuStarted = Date.now();
    await onProgress?.('Получаю дисциплины из журнала');
    await this.diagnosticClick('course-menu-toggle', page.getByRole('link', { name: 'Выберите Вашу дисциплину' }), () => page.getByRole('link', { name: 'Выберите Вашу дисциплину' }).click());
    const courseMenu = page.getByRole('menuitem');
    await courseMenu.first().waitFor({
      state: 'visible',
      timeout: Number(this.config.get<string>('AIS_JOURNAL_READY_TIMEOUT_MS') ?? 45_000),
    });
    const menuNames = (await courseMenu.allTextContents()).map(normalizeText).filter(Boolean);
    this.logger.log(`AIS course dropdown populated: ${menuNames.length} entries in ${Date.now() - menuStarted}ms`);
    await this.diagnosticClick('course-menu-toggle', page.getByRole('link', { name: 'Выберите Вашу дисциплину' }), () => page.getByRole('link', { name: 'Выберите Вашу дисциплину' }).click());
    const discoveredNames = menuNames.length ? menuNames : dashboardCourses.map((course) => course.name.replace(/\s*\([^)]*\)$/, ''));
    const courseNames = this.orderCourseNames(discoveredNames);
    const courses: CourseSnapshot[] = [];
    const assignments: AssignmentSnapshot[] = [];
    let currentWeek = 1;
    let weeks: WeekSnapshot[] = [];

    for (const [courseIndex, name] of courseNames.entries()) {
      await onProgress?.(`Читаю дисциплину ${courseIndex + 1} из ${courseNames.length}`);
      await this.throttle();
      await this.diagnosticClick('course-menu-toggle', page.getByRole('link', { name: 'Выберите Вашу дисциплину' }), () => page.getByRole('link', { name: 'Выберите Вашу дисциплину' }).click());
      const courseStarted = Date.now();
      await this.diagnosticClick('course-select-menuitem', page.getByRole('menuitem', { name, exact: true }), () => page.getByRole('menuitem', { name, exact: true }).click());
      await page.locator('#journaltabletab').waitFor({ state: 'visible' });
      await page.waitForFunction((courseName) => {
        const text = (document.querySelector('#main')?.textContent ?? '').replace(/\s+/g, ' ');
        return text.includes(String(courseName));
      }, name);
      this.logger.log(`AIS course ${courseIndex + 1}/${courseNames.length} loaded after ${Date.now() - courseStarted}ms`);
      const mainText = await page.locator('#main').innerText();
      const journalMatch = mainText.match(/([^\n]+)\s+журнал №\s*(\d+)/i);
      const dashboardCourse = dashboardCourses.find((course) => course.name.replace(/\s*\([^)]*\)$/, '') === name);
      const courseRef = dashboardCourse?.externalRef ?? `course-${stableExternalRef([name])}`;
      const ratingMatch = mainText.match(/Рейтинг\s+(\d+)\s+недели/i);
      currentWeek = ratingMatch ? Number(ratingMatch[1]) : currentWeek;
      const weekNumbers = (await page.locator('#weeknumber li').allTextContents()).map((value) => Number(normalizeText(value))).filter(Boolean);
      weeks = weekNumbers.map((number) => ({ externalRef: `week-${number}`, number, current: number === currentWeek }));
      courses.push({
        externalRef: courseRef,
        name,
        teacherRef: journalMatch?.[1] ? `teacher-${stableExternalRef([normalizeText(journalMatch[1])])}` : undefined,
      });

      const contentObservations: Array<{ week: number; titles: string[]; details: Map<string, string> }> = [];
      const sroBriefs: WeeklySroBrief[] = [];
      for (const week of activePeriodWeeks(currentWeek)) {
        await onProgress?.(`Дисциплина ${courseIndex + 1} из ${courseNames.length}: проверяю ${week}-ю неделю`);
        const weekLink = page.locator(`#li-${week} a`);
        if (!(await weekLink.count())) continue;
        await this.throttle();
        await this.navigator.navigate(page, {
          goal: 'Вернуться в журнал дисциплины',
          expected: page.locator('#journaltabletab').first(),
          semanticHints: ['Журнал'],
          onProgress,
        });
        await this.throttle();
        await this.diagnosticClick('week-select', weekLink, () => weekLink.click());
        await this.waitForWeekContent(page, week);
        // The journal keeps old/hidden AJAX fragments in the DOM. Reading every
        // <strong> used to attach an assignment from another week (or course) to
        // the currently requested week. Only visible linked content belongs to
        // the week whose heading was verified by waitForWeekContent().
        // SRO items are not guaranteed to wrap their title in <strong>.
        // Only inspect visible links inside the verified week panel: hidden
        // AJAX fragments from previous weeks must never be matched.
        const contentTitles = [...new Set(
          (await page.locator('#journaltabletab a:visible').allTextContents())
            .map(normalizeText)
            .filter((title) => contentType(title) !== undefined || independentWorkType(title) === 'SRO'),
        )];
        this.logger.log(`SRO discovery course=${courseIndex + 1} week=${week}: links=${contentTitles.length}, sro=${contentTitles.filter((title) => independentWorkType(title) === 'SRO').length}`);
        if (!contentTitles.some((title) => independentWorkType(title) === 'SRO')) {
          await this.htmlDiagnostics.capture(diagnosticAccountId, courseRef, week, 'weekly-content', page.locator('#journaltabletab'));
        }
        const details = await this.readContentDetails(
          page,
          week,
          contentTitles,
          !options.disabledLabCourseRefs?.has(courseRef),
        );
        contentObservations.push({ week, titles: contentTitles, details });
        this.logger.log(`SRO detail reading course=${courseIndex + 1} week=${week}: opened=${details.size}`);
        for (const title of contentTitles.filter((value) => independentWorkType(value) === 'SRO')) {
          const content = details.get(title);
          if (content) sroBriefs.push({ courseRef, weekNumber: week, title, content });
        }
      }

      await this.throttle();
      const sentLink = page.getByText('Отправленные', { exact: true }).first();
      await this.navigator.navigate(page, {
        goal: 'Открыть раздел сообщений',
        expected: sentLink,
        semanticHints: ['Сообщения'],
        onProgress,
      });
      await this.throttle();
      await onProgress?.(`Дисциплина ${courseIndex + 1} из ${courseNames.length}: читаю отправленные сообщения`);
      // "Отправленные" is already visible while Inbox is active, so using the
      // link itself as an expected navigation result returns too early. Click
      // the folder explicitly and verify the sent-only "Получатель" column.
      await this.diagnosticClick('sent-folder-open', sentLink, () => sentLink.click());
      const sentTable = page.locator('#tab_3-2 table:visible').first();
      await sentTable.getByText('Получатель', { exact: true }).waitFor({
        state: 'visible',
        timeout: Number(this.config.get<string>('AIS_CONTENT_DETAIL_TIMEOUT_MS') ?? 120_000),
      });
      const sent = await this.readSentMessages(page);
      for (const observation of contentObservations) {
        assignments.push(...parseContentAssignments(
          courseRef,
          observation.week,
          observation.titles,
          sent,
          observation.details,
        ));
      }

      await this.throttle();
      await this.navigator.navigate(page, {
        goal: 'Открыть список самостоятельных работ СРО только для чтения',
        expected: page.locator('#tab_2-2').first(),
        semanticHints: ['СРО'],
        onProgress,
      });
      const sroAssignments = parseSroText(courseRef, await page.locator('#tab_2-2').innerText());

      // Future weeks can be published in AIS even when the current *rating*
      // week is still 12. Only scan future weeks with a real, ungraded SRO
      // destination card. This keeps additional requests targeted.
      const futureWeeks = futureSroWeeks(currentWeek, weekNumbers, sroAssignments);
      if (futureWeeks.length) {
        await this.navigator.navigate(page, {
          goal: 'Вернуться в журнал для чтения опубликованных СРО будущих недель',
          expected: page.locator('#journaltabletab').first(),
          semanticHints: ['Журнал'],
          onProgress,
        });
        for (const week of futureWeeks) {
          await onProgress?.(`Дисциплина ${courseIndex + 1} из ${courseNames.length}: проверяю СРО ${week}-й недели`);
          const weekLink = page.locator(`#li-${week} a`);
          if (!(await weekLink.count())) continue;
          await this.throttle();
          await this.diagnosticClick('week-select', weekLink, () => weekLink.click());
          await this.waitForWeekContent(page, week);
          const titles = [...new Set(
            (await page.locator('#journaltabletab a:visible').allTextContents())
              .map(normalizeText)
              .filter((title) => independentWorkType(title) === 'SRO'),
          )];
          const details = await this.readContentDetails(page, week, titles, false);
          for (const title of titles) {
            const content = details.get(title);
            if (content) sroBriefs.push({ courseRef, weekNumber: week, title, content });
          }
          this.logger.log(`SRO future course=${courseIndex + 1} week=${week}: discovered=${titles.length} read=${details.size}`);
        }
        await this.navigator.navigate(page, {
          goal: 'Вернуться в СРО для проверки карточек сдачи',
          expected: page.locator('#tab_2-2').first(),
          semanticHints: ['СРО'],
          onProgress,
        });
      }
      for (const assignment of sroAssignments) {
        const match = matchSroBrief(assignment, sroBriefs);
        if (match.status !== 'MATCHED') {
          this.logger.warn(`SRO condition mismatch course=${courseIndex + 1} week=${assignment.weekNumber}: ${match.status}; read_briefs=${sroBriefs.filter((brief) => brief.weekNumber === assignment.weekNumber).length}`);
        }
        if (match.status === 'MATCHED') {
          const requirements = extractSroRequirements(match.brief);
          // Keep the SRO_TAB identity/status; append the real condition so
          // downstream storage and the task report can expose its requirements.
          assignment.content = [assignment.content, 'Условие из журнала:', requirements.fullText].join('\n');
          assignment.assignmentNumber = Number(match.brief.title.match(/№\s*(\d+)/)?.[1]) || undefined;
        }
        // A missing or ambiguous brief is never assumed to belong to this card.
        // This does not change debt evidence or attempt an upload.
        if (assignment.grade !== undefined || assignment.weekNumber > currentWeek) continue;
        const detail = page.locator('#tab_2-2 a').filter({ hasText: `${assignment.weekNumber} неделя` });
        if ((await detail.count()) !== 1) continue;
        await this.throttle();
        try {
          const previousLinks = await page.locator('#myfiles a').allTextContents().catch(() => [] as string[]);
          await this.diagnosticClick('sro-history-open', detail, () => detail.click());
          const container = page.locator('#myfiles');
          const timeout = Number(this.config.get<string>('AIS_SRO_HISTORY_TIMEOUT_MS') ?? 10_000);
          await container.waitFor({ state: 'attached', timeout });
          await page.waitForFunction(() => {
            const node = document.querySelector('#myfiles');
            if (!node) return false;
            const modal = node.closest('.modal') ?? node.parentElement ?? node;
            return Boolean(modal.querySelector('input[type="file"]') ||
              [...node.querySelectorAll('a')].some((a) => /\.(?:docx?|pdf|xlsx?|pptx?|txt|rtf|zip|rar|7z)\b/i.test(a.textContent ?? '')));
          }, undefined, { timeout }).catch(() => undefined);
          const ready = await container.evaluate((node) => Boolean((node.closest('.modal') ?? node.parentElement ?? node).querySelector('input[type="file"]')));
          const before = await container.locator('a').allTextContents();
          await page.waitForTimeout(Number(this.config.get<string>('AIS_SRO_HISTORY_SETTLE_MS') ?? 600));
          const after = await container.locator('a').allTextContents();
          // Never attribute the previous modal's file list to the newly opened week.
          const stalePreviousFiles = previousLinks.length > 0 && JSON.stringify(previousLinks) === JSON.stringify(after);
          const evidence = classifySroHistory(after, ready, JSON.stringify(before) === JSON.stringify(after));
          if (stalePreviousFiles && evidence.status === 'CONFIRMED') {
            evidence.status = 'UNKNOWN';
            evidence.reason = 'previous file list did not refresh';
          }
          assignment.submissionState = evidence.status;
          assignment.submitted = evidence.status === 'CONFIRMED';
          this.logger.log(`SRO history course=${courseIndex + 1} week=${assignment.weekNumber}: ${evidence.status} files=${evidence.files.length}`);
          await this.htmlDiagnostics.capture(diagnosticAccountId, courseRef, assignment.weekNumber, 'sro-files', container);
        } catch (error) {
          assignment.submissionState = 'UNKNOWN';
          assignment.submitted = false;
          this.logger.warn(`SRO history unavailable course=${courseIndex + 1} week=${assignment.weekNumber}: ${error instanceof Error ? error.name : 'unknown'}`);
        } finally {
          await page.getByText('Close', { exact: true }).click({ timeout: 2_000 }).catch(() => undefined);
        }
      }
      assignments.push(...sroAssignments);
    }
    return { currentWeek, courses, weeks, assignments };
  }

  private async waitForWeekContent(page: Page, week: number): Promise<void> {
    const diagnosticStarted = Date.now();
    let completed = false;
    try {
    // Some courses have no weekly block and therefore no "N учебная неделя"
    // heading. The selected button is still painted with Bootstrap's primary
    // class, so accept either that marker or the matching visible heading.
    await page.waitForFunction((weekNumber) => {
      const item = document.querySelector(`#li-${weekNumber}`);
      const link = item?.querySelector('a');
      const marker = `${item?.className ?? ''} ${link?.className ?? ''}`.toLowerCase();
      const selected = /(?:active|selected|primary)/.test(marker)
        || link?.getAttribute('aria-selected') === 'true'
        || link?.getAttribute('aria-current') === 'true';
      const visibleText = (document.querySelector('#journaltabletab') as HTMLElement | null)?.innerText ?? '';
      const displayedWeek = visibleText.replace(/\s+/g, ' ')
        .match(/(?:^|\s)(\d{1,2})\s+учебная\s+неделя\b/i)?.[1];
      return selected || Number(displayedWeek) === weekNumber;
    }, week, {
      timeout: Number(this.config.get<string>('AIS_CONTENT_DETAIL_TIMEOUT_MS') ?? 120_000),
    });
    await page.waitForTimeout(Number(this.config.get<string>('AIS_AJAX_SETTLE_MS') ?? 3_000));

    const visibleText = normalizeText(await page.locator('#journaltabletab').innerText().catch(() => ''));
    const displayedWeek = Number(visibleText.match(/(?:^|\s)(\d{1,2})\s+учебная\s+неделя\b/i)?.[1]);
    if (displayedWeek && displayedWeek !== week) {
      throw new AbuReadTimeoutError(`переключение на ${week}-ю неделю (AIS показывает ${displayedWeek}-ю)`);
    }
    completed = true;
    } finally {
      this.syncDiagnostics?.recordWait('week-content-ready', diagnosticStarted, completed);
    }
  }

  private orderCourseNames(courseNames: string[]): string[] {
    const priority = (this.config.get<string>('AIS_PRIORITY_COURSE_NAMES') ?? 'Архитектура системы блокчейн')
      .split(',').map(normalizeText).filter(Boolean);
    return courseNames.map((name, index) => ({ name, index }))
      .sort((left, right) => {
        const leftPriority = priority.findIndex((value) => normalizeText(left.name).toLowerCase().includes(value.toLowerCase()));
        const rightPriority = priority.findIndex((value) => normalizeText(right.name).toLowerCase().includes(value.toLowerCase()));
        const leftRank = leftPriority === -1 ? Number.MAX_SAFE_INTEGER : leftPriority;
        const rightRank = rightPriority === -1 ? Number.MAX_SAFE_INTEGER : rightPriority;
        return leftRank - rightRank || left.index - right.index;
      }).map(({ name }) => name);
  }

  private async readSentMessages(page: Page): Promise<SentMessageObservation[]> {
    const startedAt = Date.now();
    const rows = page.locator('#tab_3-2 table tbody tr');
    const summaries = parseSentMessageRows(await rows.allTextContents());
    const limit = Math.min(summaries.length, Number(this.config.get<string>('AIS_SENT_MESSAGE_DETAIL_LIMIT') ?? 50));
    // Subject matching already requires СРСП/СРОП or Лаб in the subject.
    // Unrelated messages can stay as summaries and do not need a detail click.
    const relevant = summaries.slice(0, limit).filter((row) => isRelevantSentSubject(row.subject));
    const timeout = Number(this.config.get<string>('AIS_MESSAGE_DETAIL_TIMEOUT_MS') ?? 7_000);
    let visited = 0;
    let failed = 0;

    for (const [index, summary] of relevant.entries()) {
      const row = page.locator(`#mail-${summary.externalRef}`);
      if (!(await row.count())) continue;
      try {
        const before = normalizeText(await page.locator('#inboxmail').innerText().catch(() => ''));
        await this.diagnosticClick('sent-message-row-open', row.locator('td').first(), () => row.locator('td').first().click({ force: true, timeout }));
        await page.waitForFunction((previous) => {
          const text = (document.querySelector('#inboxmail')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
          return text.length > 0 && text !== previous;
        }, before, { timeout });
        const container = page.locator('#inboxmail');
        summary.body = normalizeText(await container.innerText());
        summary.resourceTexts = (await this.contentExtractor.extractLinkedResources(
          page, container, Number(this.config.get<string>('AIS_MESSAGE_ATTACHMENT_TIMEOUT_MS') ?? 15_000),
        )).map((resource) => resource.text);
        visited += 1;
      } catch {
        // Preserve the summary, but do not mistake a stale dialog for evidence.
        failed += 1;
      }
      if (index + 1 < relevant.length) {
        await this.diagnosticClick('return-to-sent-folder', page.getByText('Отправленные', { exact: true }), () => page.getByText('Отправленные', { exact: true }).click({ timeout }));
        await page.locator('#tab_3-2 table tbody tr').first()
          .waitFor({ state: 'visible', timeout }).catch(() => undefined);
      }
    }
    this.logger.log(`AIS sent messages total=${summaries.length} eligible=${relevant.length} read=${visited} failed=${failed} elapsed_ms=${Date.now() - startedAt}`);
    return summaries;
  }

  private async readContentDetails(
    page: Page,
    week: number,
    rawTitles: string[],
    analyzeLabs: boolean,
  ): Promise<Map<string, string>> {
    const titles = rawTitles.map(normalizeText).filter((title) => {
      const type = contentType(title);
      return type === 'SRSP' || type === 'SRO' || (type === 'LAB' && analyzeLabs) || independentWorkType(title) === 'SRO';
    });
    const details = new Map<string, string>();
    for (const title of titles) {
      const anchor = page.locator('#journaltabletab a:visible').filter({ hasText: title }).first();
      if (!(await anchor.count())) continue;
      const before = normalizeText(await page.locator('#contentdetdiv').innerText().catch(() => ''));
      const started = Date.now();
      await this.diagnosticClick('content-details-open', anchor, () => anchor.click());
      await page.waitForFunction((previous) => {
        const current = (document.querySelector('#contentdetdiv')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return current.length > 0 && current !== previous;
      }, before, { timeout: Number(this.config.get<string>('AIS_DETAIL_CHANGE_TIMEOUT_MS') ?? 8_000) })
        .catch(() => undefined);
      const container = page.locator('#contentdetdiv');
      const body = normalizeText(await container.innerText().catch(() => ''));
      // Do not attach stale content from a previous dialog to a new task.
      if (!body || body === before || body.length <= title.length) {
        this.logger.warn(`Content detail unavailable week=${week} elapsed_ms=${Date.now() - started}; skipping unchanged dialog`);
        const weekLink = page.locator(`#li-${week} a`);
        if (await weekLink.count()) { await this.diagnosticClick('week-select', weekLink, () => weekLink.click()); await this.waitForWeekContent(page, week); }
        continue;
      }
      const resources = await this.contentExtractor.extractLinkedResources(page, container);
      details.set(title, normalizeText([body, ...resources.map((resource) => resource.text)].join(' ')));
      this.logger.log(`Content detail read week=${week} elapsed_ms=${Date.now() - started}`);

      const weekLink = page.locator(`#li-${week} a`);
      if (await weekLink.count()) {
        await this.diagnosticClick('week-select', weekLink, () => weekLink.click());
        await this.waitForWeekContent(page, week);
      }
    }
    return details;
  }
}

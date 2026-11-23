import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';

/**
 * Static source-code locator patterns (never dynamic text from the AIS DOM).
 * These help correlate report rows with Playwright calls in the adapter.
 */
const SAFE_LOCATOR_PATTERNS: Record<string, string> = {
  'study-menu-open': 'visible link/button containing Обучение',
  'journal-open': 'visible link/button containing Электронный журнал',
  'course-menu-toggle': "getByRole('link', {name:'Выберите Вашу дисциплину'})",
  'course-select-menuitem': "getByRole('menuitem', {name:<course>})",
  'week-select': "locator('#li-<week> a')",
  'content-details-open': "locator('#journaltabletab a:visible') matching title",
  'sent-folder-open': "getByText('Отправленные', {exact:true})",
  'sent-message-row-open': "locator('#mail-<id> td').first()",
  'return-to-sent-folder': "getByText('Отправленные', {exact:true})",
  'sro-history-open': "locator('#tab_2-2 a') containing week",
};

type DiagnosticEvent = {
  atMs: number;
  durationMs: number;
  category: 'stage' | 'click' | 'wait' | 'throttle';
  label: string;
  status: 'ok' | 'failed';
  matches?: number;
  tag?: string;
  role?: string;
  errorType?: string;
  locatorPattern?: string;
};

type NetCounters = {
  responses: number;
  failedRequests: number;
  http4xx: number;
  http5xx: number;
  xhrOrFetch: number;
};

/**
 * Diagnostics are local-only. The JSON report contains no page text, HTML,
 * student names, account IDs, URLs, form values, cookies, or credentials.
 *
 * CAUTION: trace.zip is different: Playwright DOM snapshots and screenshots
 * can contain private academic data. Never commit or upload the trace file.
 */
export class SyncDiagnosticsRecorder {
  private readonly startedAt = Date.now();
  private readonly events: DiagnosticEvent[] = [];
  private readonly net: NetCounters = {
    responses: 0, failedRequests: 0, http4xx: 0, http5xx: 0, xhrOrFetch: 0,
  };
  private traceStarted = false;
  private readonly responseListener = (response: import('playwright').Response) => {
    this.net.responses += 1;
    if (response.status() >= 400 && response.status() < 500) this.net.http4xx += 1;
    if (response.status() >= 500) this.net.http5xx += 1;
    const type = response.request().resourceType();
    if (type === 'xhr' || type === 'fetch') this.net.xhrOrFetch += 1;
  };
  private readonly failedListener = (_request: import('playwright').Request) => {
    this.net.failedRequests += 1;
  };

  private constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    readonly outputDir: string,
  ) {}

  static async start(page: Page, options: { traceEnabled?: boolean } = {}): Promise<SyncDiagnosticsRecorder> {
    const directory = resolve(process.cwd(), 'artifacts', 'sync-diagnostics',
      `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const recorder = new SyncDiagnosticsRecorder(page, page.context(), directory);
    // Trace snapshots can take minutes to pack on small Macs. Disable them
    // during performance benchmarking with AIS_SYNC_TRACE_ENABLED=false.
    // Tracing always starts AFTER login; no password-typing actions captured.
    if (options.traceEnabled !== false) {
      await recorder.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      recorder.traceStarted = true;
    }
    page.on('response', recorder.responseListener);
    page.on('requestfailed', recorder.failedListener);
    return recorder;
  }

  private add(category: DiagnosticEvent['category'], label: string, started: number,
    status: DiagnosticEvent['status'], extra: Partial<DiagnosticEvent> = {}): void {
    if (this.events.length >= 10000) return;
    this.events.push({
      atMs: Math.max(0, started - this.startedAt),
      durationMs: Math.max(0, Date.now() - started),
      category, label, status, ...extra,
    });
  }

  async stage<T>(label: string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await action();
      this.add('stage', label, started, 'ok');
      return result;
    } catch (error) {
      this.add('stage', label, started, 'failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  async click<T>(label: string, locator: Locator, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    // Only structural metadata. Never read textContent, HTML, href, id,
    // values or data attributes (any of them may include student data).
    const matches = await locator.count().catch(() => undefined);
    const locatorPattern = SAFE_LOCATOR_PATTERNS[label];
    const structure = await locator.first().evaluate((element) => ({
      tag: element.tagName.toLowerCase().slice(0, 15),
      role: ['button', 'link', 'menuitem', 'tab'].includes(element.getAttribute('role') ?? '')
        ? element.getAttribute('role')! : 'unspecified',
    }), undefined, { timeout: 1500 }).catch(() => undefined);
    try {
      const result = await action();
      this.add('click', label, started, 'ok', {
        matches, tag: structure?.tag, role: structure?.role, locatorPattern,
      });
      return result;
    } catch (error) {
      this.add('click', label, started, 'failed', {
        matches, tag: structure?.tag, role: structure?.role, locatorPattern,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  recordWait(label: string, started: number, success = true): void {
    this.add('wait', label, started, success ? 'ok' : 'failed');
  }

  recordThrottle(started: number): void {
    this.add('throttle', 'request-spacing', started, 'ok');
  }

  async finish(): Promise<string> {
    this.page.off('response', this.responseListener);
    this.page.off('requestfailed', this.failedListener);
    // Distinguish real browser work from packaging screenshots + DOM traces.
    const browserElapsedMs = Date.now() - this.startedAt;
    let traceSaved = false;
    const traceStopStarted = Date.now();
    if (this.traceStarted) {
      try {
        await this.context.tracing.stop({ path: resolve(this.outputDir, 'trace.zip') });
        traceSaved = true;
      } catch {
        // Always preserve sanitized metadata even if trace archive fails.
      }
    }
    const traceStopMs = Date.now() - traceStopStarted;
    const report = {
      format: 'aisora-sync-diagnostics-v1',
      browserElapsedMs,
      traceStopMs,
      startedAt: new Date(this.startedAt).toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      traceSaved,
      networkCounts: this.net,
      events: this.events,
      privacy: 'No credentials, account identifiers, URLs, page text, or raw HTML are recorded in this JSON. trace.zip contains sensitive authenticated page snapshots; keep it local.',
    };
    await writeFile(resolve(this.outputDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return this.outputDir;
  }
}

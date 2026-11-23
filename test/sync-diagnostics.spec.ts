import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from 'playwright';
import { SyncDiagnosticsRecorder } from '../src/university/sync-diagnostics';

describe('local Aisora Playwright diagnostics', () => {
  it('records action metadata and timings without recording page text or secrets', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const page = {
      context: () => ({ tracing: { start, stop } }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page;
    const locator = {
      count: vi.fn(async () => 1),
      first: () => ({
        evaluate: vi.fn(async () => ({ tag: 'a', role: 'link' })),
      }),
    } as unknown as Locator;
    const recorder = await SyncDiagnosticsRecorder.start(page);
    expect(start).toHaveBeenCalledWith({ screenshots: true, snapshots: true, sources: true });

    await recorder.stage('read-journal', async () => {
      await recorder.click('week-select', locator, async () => undefined);
      recorder.recordWait('week-content-ready', Date.now(), true);
    });

    const outputDir = await recorder.finish();
    expect(stop).toHaveBeenCalledTimes(1);
    const report = JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')) as {
      format: string;
      events: Array<Record<string, unknown>>;
      networkCounts: Record<string, number>;
    };
    expect(report.format).toBe('aisora-sync-diagnostics-v1');
    expect(report.events.map((event) => event.label)).toEqual([
      'week-select', 'week-content-ready', 'read-journal',
    ]);
    expect(report.events[0]).toMatchObject({ tag: 'a', role: 'link', matches: 1 });
    expect(report.networkCounts.responses).toBe(0);
    expect(JSON.stringify(report)).not.toContain('password');
    expect(JSON.stringify(report)).not.toContain('https://ais.semuniver.kz/login.php');
  });

  it('supports JSON-only diagnostics without launching a heavy Trace Viewer recording', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const page = {
      context: () => ({ tracing: { start, stop } }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page;
    const recorder = await SyncDiagnosticsRecorder.start(page, { traceEnabled: false });
    await recorder.stage('read-week', async () => undefined);
    const outputDir = await recorder.finish();
    const report = JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')) as {
      traceSaved: boolean;
      traceStopMs: number;
      browserElapsedMs: number;
      events: Array<{ label: string }>;
    };
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(report.traceSaved).toBe(false);
    expect(report.traceStopMs).toBeGreaterThanOrEqual(0);
    expect(report.browserElapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.events[0]?.label).toBe('read-week');
  });

  it('does not swallow failures from Playwright actions', async () => {
    const page = {
      context: () => ({ tracing: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) } }),
      on: vi.fn(), off: vi.fn(),
    } as unknown as Page;
    const recorder = await SyncDiagnosticsRecorder.start(page);
    const locator = {
      count: async () => 0,
      first: () => ({ evaluate: async () => { throw new Error('not present'); } }),
    } as unknown as Locator;
    try {
      await expect(recorder.click('week-select', locator, async () => {
        throw new Error('playwright failure');
      })).rejects.toThrow('playwright failure');
    } finally {
      await recorder.finish();
    }
  });
});

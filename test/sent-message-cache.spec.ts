import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type { ConfigService } from '@nestjs/config';
import type { CredentialVaultService } from '../src/auth/credential-vault.service';
import type { AdaptiveAisNavigator } from '../src/university/adaptive-ais-navigator';
import type { AisContentExtractor } from '../src/university/ais-content-extractor';
import type { SentMessageObservation } from '../src/university/abu-parsers';
import { AbuUniversityAdapter } from '../src/university/abu-university.adapter';

type SentReadResult = { messages: SentMessageObservation[]; complete: boolean };

function fakeAdapter(): AbuUniversityAdapter {
  return new AbuUniversityAdapter(
    { get: () => undefined } as unknown as ConfigService,
    {} as CredentialVaultService,
    {} as AdaptiveAisNavigator,
    { extractLinkedResources: async () => [] } as unknown as AisContentExtractor,
  );
}

function fakePage(failToLoad: boolean): { page: Page; getClickCount(): number } {
  let content = '';
  let clicks = 0;
  const rowText = '1 2026-11-23 12:00:00 студент СРСП 12 неделя';
  const page = {
    locator: (selector: string) => {
      if (selector === '#tab_3-2 table tbody tr') {
        return { allTextContents: async () => [rowText] };
      }
      if (selector === '#inboxmail') return { innerText: async () => content };
      if (selector === '#mail-1') {
        return {
          count: async () => 1,
          locator: () => ({
            first: () => ({
              click: async () => {
                clicks += 1;
                if (!failToLoad) content = 'Новое подтверждённое сообщение';
              },
            }),
          }),
        };
      }
      throw new Error('Unexpected locator');
    },
    waitForFunction: async () => {
      if (failToLoad) throw new Error('TimeoutError');
      return undefined;
    },
  } as unknown as Page;
  return { page, getClickCount: () => clicks };
}

function read(
  adapter: AbuUniversityAdapter,
  page: Page,
  cache: Map<string, SentMessageObservation>,
  failedKeys: Set<string>,
): Promise<SentReadResult> {
  const testAdapter = adapter as unknown as {
    readSentMessages: (
      page: Page,
      cache: Map<string, SentMessageObservation>,
      failed: Set<string>,
    ) => Promise<SentReadResult>;
  };
  return testAdapter.readSentMessages(page, cache, failedKeys);
}

describe('per-synchronization sent message cache', () => {
  it('does not reopen successfully read message in another course', async () => {
    const adapter = fakeAdapter();
    const { page, getClickCount } = fakePage(false);
    const cache = new Map<string, SentMessageObservation>();
    const failures = new Set<string>();
    const first = await read(adapter, page, cache, failures);
    const second = await read(adapter, page, cache, failures);
    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
    expect(getClickCount()).toBe(1);
    expect(second.messages[0]?.body).toBe('Новое подтверждённое сообщение');
  });

  it('does not retry identical failed message once for each course', async () => {
    const adapter = fakeAdapter();
    const { page, getClickCount } = fakePage(true);
    const cache = new Map<string, SentMessageObservation>();
    const failures = new Set<string>();
    const first = await read(adapter, page, cache, failures);
    const second = await read(adapter, page, cache, failures);
    expect(first.complete).toBe(false);
    expect(second.complete).toBe(false);
    expect(getClickCount()).toBe(1);
    expect(second.messages[0]?.body).toBeUndefined();
  });
});

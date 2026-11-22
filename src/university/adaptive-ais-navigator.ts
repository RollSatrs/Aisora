import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Locator, Page } from 'playwright';
import type { SyncProgress } from './university-adapter';

export interface AisTargetSummary {
  id: number;
  name: string;
  role: string;
  href?: string;
}

interface ObservedTarget extends AisTargetSummary {
  locator: Locator;
}

export interface AdaptiveNavigationRequest {
  goal: string;
  expected: Locator;
  semanticHints: string[];
  onProgress?: SyncProgress;
  maxSteps?: number;
}

const FORBIDDEN_NAME = /(создать|добавить|изменить|редактировать|удалить|отправить|загрузить|прикрепить|сохранить|выйти|submit|upload|delete|edit|create|logout)/i;
const FORBIDDEN_HREF = /(logout|delete|remove|upload|submit|create|edit|message\/send)/i;

export class AisNavigationDecisionError extends Error {
  constructor(readonly goal: string) {
    super(`No safe navigation action found for goal: ${goal}`);
    this.name = 'AisNavigationDecisionError';
  }
}

export function isReadOnlyTarget(target: AisTargetSummary): boolean {
  if (!target.name || FORBIDDEN_NAME.test(target.name)) return false;
  if (target.href && FORBIDDEN_HREF.test(target.href)) return false;
  if (target.href && /^(data:|vbscript:)/i.test(target.href)) return false;
  if (target.href && /^javascript:/i.test(target.href) && !/^javascript:\s*void\s*\(\s*0\s*\)/i.test(target.href)) return false;
  if (target.href && /^(https?:)?\/\//i.test(target.href)) {
    try {
      if (new URL(target.href, 'https://ais.semuniver.kz').hostname !== 'ais.semuniver.kz') return false;
    } catch {
      return false;
    }
  }
  return target.role === 'link' || target.role === 'button';
}

export function parseModelTargetId(content: string, allowedIds: Set<number>): number | undefined {
  const normalized = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(normalized) as { targetId?: unknown };
    return typeof value.targetId === 'number' && allowedIds.has(value.targetId) ? value.targetId : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class AdaptiveAisNavigator {
  private readonly logger = new Logger(AdaptiveAisNavigator.name);

  constructor(private readonly config: ConfigService) {}

  async navigate(page: Page, request: AdaptiveNavigationRequest): Promise<void> {
    const maxSteps = request.maxSteps ?? 4;
    const attempted = new Set<string>();
    for (let step = 0; step < maxSteps; step += 1) {
      if (await request.expected.isVisible().catch(() => false)) return;
      const targets = await this.observe(page);
      const safeTargets = targets.filter(isReadOnlyTarget);
      let source = 'семантические правила';
      let target = this.chooseBySemantics(safeTargets, request.semanticHints, attempted);
      if (!target) {
        source = 'локальная модель';
        target = await this.chooseWithLocalModel(request.goal, safeTargets, attempted);
      }
      if (!target || !isReadOnlyTarget(target)) throw new AisNavigationDecisionError(request.goal);

      const fingerprint = this.fingerprint(target);
      attempted.add(fingerprint);
      await request.onProgress?.(`Навигация (${source}): выбираю «${target.name.slice(0, 80)}»`);
      await target.locator.click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(700);
    }
    if (!(await request.expected.isVisible().catch(() => false))) {
      throw new AisNavigationDecisionError(request.goal);
    }
  }

  private async observe(page: Page): Promise<ObservedTarget[]> {
    const locator = page.locator('a, button, [role="link"], [role="button"]');
    const count = Math.min(await locator.count(), 150);
    const targets: ObservedTarget[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const attributes = await item.evaluate((element) => ({
        name: (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim(),
        role: element.getAttribute('role') || (element.tagName.toLowerCase() === 'a' ? 'link' : 'button'),
        href: element instanceof HTMLAnchorElement ? element.getAttribute('href') || undefined : undefined,
      })).catch(() => undefined);
      if (!attributes?.name) continue;
      const name = attributes.name.slice(0, 160);
      const key = `${attributes.role}|${name}|${attributes.href ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ id: targets.length + 1, name, role: attributes.role, href: attributes.href, locator: item });
    }
    return targets;
  }

  private chooseBySemantics(
    targets: ObservedTarget[],
    semanticHints: string[],
    attempted: Set<string>,
  ): ObservedTarget | undefined {
    for (const hint of semanticHints) {
      const normalizedHint = this.normalize(hint);
      const matches = targets
        .filter((target) => !attempted.has(this.fingerprint(target)))
        .map((target) => ({ target, score: this.semanticScore(this.normalize(target.name), normalizedHint) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score);
      if (matches[0]) return matches[0].target;
    }
    return undefined;
  }

  private async chooseWithLocalModel(
    goal: string,
    targets: ObservedTarget[],
    attempted: Set<string>,
  ): Promise<ObservedTarget | undefined> {
    if (this.config.get<string>('AIS_AGENT_MODEL_ENABLED') !== 'true') return undefined;
    const available = targets.filter((target) => !attempted.has(this.fingerprint(target)));
    if (!available.length) return undefined;
    const endpoint = this.config.get<string>('AIS_AGENT_MODEL_URL') ?? 'http://127.0.0.1:11434/api/chat';
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(endpoint);
    if (!isLocal && this.config.get<string>('AIS_AGENT_REMOTE_DATA_APPROVED') !== 'true') {
      this.logger.warn('Remote AIS agent model is disabled because data sharing was not approved');
      return undefined;
    }

    const summaries = available.map((target) => ({
      id: target.id,
      name: target.name,
      role: target.role,
      href: target.href,
    }));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.get<string>('AIS_AGENT_MODEL') ?? 'qwen2.5:3b-instruct',
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content: 'You are a read-only university portal navigator. Select exactly one safe target from the supplied list. Never select create, edit, save, upload, submit, send, delete, logout, or settings actions. Return JSON only: {"targetId": number, "reason": "short"}.',
          },
          { role: 'user', content: JSON.stringify({ goal, visibleTargets: summaries }) },
        ],
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(Number(this.config.get<string>('AIS_AGENT_MODEL_TIMEOUT_MS') ?? 45_000)),
    }).catch(() => undefined);
    if (!response?.ok) return undefined;
    const payload = await response.json() as { message?: { content?: string } };
    const allowedIds = new Set(available.map((target) => target.id));
    const targetId = parseModelTargetId(payload.message?.content ?? '', allowedIds);
    return targetId === undefined ? undefined : available.find((target) => target.id === targetId);
  }

  private semanticScore(name: string, hint: string): number {
    if (name === hint) return 100;
    if (name.includes(hint)) return 80;
    if (hint.includes(name) && name.length > 3) return 50;
    const hintWords = hint.split(' ').filter((word) => word.length > 3);
    return hintWords.reduce((score, word) => score + (name.includes(word) ? 10 : 0), 0);
  }

  private normalize(value: string): string {
    return value.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
  }

  private fingerprint(target: AisTargetSummary): string {
    return `${target.role}|${this.normalize(target.name)}|${target.href ?? ''}`;
  }
}

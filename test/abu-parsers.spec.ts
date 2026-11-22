import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { CredentialVaultService } from '../src/auth/credential-vault.service';
import type { AdaptiveAisNavigator } from '../src/university/adaptive-ais-navigator';
import type { AisContentExtractor } from '../src/university/ais-content-extractor';
import { futureSroWeeks, independentWorkType, isRelevantSentSubject, parseContentAssignments, parseSentMessageRows, parseSroText } from '../src/university/abu-parsers';
import { AbuUniversityAdapter, AutomationPermissionRequiredError } from '../src/university/abu-university.adapter';

describe('ABU AIS observed DOM parsers', () => {
  it('refuses browser access unless the explicit authorization flag is enabled', async () => {
    const vault = { get: async () => undefined } as unknown as CredentialVaultService;
    const navigator = {} as AdaptiveAisNavigator;
    const extractor = {} as AisContentExtractor;
    const adapter = new AbuUniversityAdapter(
      new ConfigService({ AIS_AUTOMATION_APPROVED: 'false' }), vault, navigator, extractor,
    );
    await expect(adapter.readSnapshot('account')).rejects.toBeInstanceOf(AutomationPermissionRequiredError);
  });

  it('parses graded and pending SRO entries from the observed card text', () => {
    const tasks = parseSroText('journal-1', [
      'Самостоятельная работа 7 неделя 82 Срок сдачи работы до 2026-10-18 Рецензия отсутствует',
      'Самостоятельная работа 10 неделя --- Срок сдачи работы до 2026-11-08 Рецензия отсутствует',
    ].join(' '));
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ weekNumber: 7, submitted: true, grade: '82' });
    expect(tasks[1]).toMatchObject({ weekNumber: 10, submitted: false, submissionState: 'UNKNOWN', grade: undefined });
  });

  it('recognizes СРО and СРС independent of assignment ordinal or punctuation', () => {
    for (const name of ['СРО №4. Масштабирование', 'СРС 4', 'СРС4', 'СРС: Таблица IoT', 'Тема: СРО — робототехника']) {
      expect(independentWorkType(name)).toBe('SRO');
    }
    for (const name of ['СРСП 4', 'СРОП №6', 'Тема: СРОП — Деструктор']) {
      expect(independentWorkType(name)).toBe('SRSP');
    }
    expect(independentWorkType('Лекция 13')).toBeUndefined();
    expect(independentWorkType('СРОП 4')).not.toBe('SRO');
  });

  it('scans published future SRO-card weeks without scanning all future weeks', () => {
    const card = (weekNumber: number, source: 'SRO_TAB' | 'CONTENT' = 'SRO_TAB', grade?: string) =>
      ({ type: 'SRO' as const, source, weekNumber, grade });
    expect(futureSroWeeks(12, [9, 10, 11, 12, 13, 14, 15], [
      card(10), card(13), card(13), card(14, 'CONTENT'), card(15), card(14, 'SRO_TAB', '90'),
    ])).toEqual([13, 15]);
  });

  it('only opens sent-message bodies that can be evidence for SRSP/SROP or lab work', () => {
    expect(isRelevantSentSubject('СРСП 7 неделя')).toBe(true);
    expect(isRelevantSentSubject('СРОП №3')).toBe(true);
    expect(isRelevantSentSubject('Лабораторная работа №5')).toBe(true);
    expect(isRelevantSentSubject('СРО №3')).toBe(false);
    expect(isRelevantSentSubject('Лекция 8')).toBe(false);
    expect(isRelevantSentSubject('Оповещение о расписании')).toBe(false);
  });

  it('matches sent message evidence to SRSP and laboratory content', () => {
    const sent = parseSentMessageRows([
      '1001 2026-10-12 20:15:01 Преподаватель СРСП 7 неделя',
      '1002 2026-10-16 19:31:57 Преподаватель Лаб 5',
    ]);
    const srsp = parseContentAssignments('journal-1', 7, ['СРСП №4. Тема'], sent);
    const lab = parseContentAssignments('journal-1', 7, ['Лабораторная работа №5'], sent);
    expect(srsp[0]?.submitted).toBe(true);
    expect(lab[0]?.submitted).toBe(true);
  });

  it('treats recognized laboratory content without sent evidence as required and absent', () => {
    const [assignment] = parseContentAssignments('journal-1', 10, ['Лабораторная работа №8'], []);
    expect(assignment).toMatchObject({ requiredState: 'REQUIRED', submissionState: 'ABSENT', submitted: false });
  });

  it('ignores lectures and SRO links in weekly content', () => {
    const assignments = parseContentAssignments('journal-1', 11, [
      'Лабораторная работа 9. Структура проекта Solidity в VS Code',
      'СРО №3: Разработка децентрализованных приложений dApp',
      'Лекция №11 Тема: Развертывание собственного узла Ethereum',
    ], []);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ type: 'LAB', weekNumber: 11 });
  });
});

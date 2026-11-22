import { describe, expect, it } from 'vitest';
import { extractSroRequirements, matchSroBrief, type WeeklySroBrief } from '../src/university/sro-assignment-matcher';

const target = {
  courseRef: 'blockchain',
  weekNumber: 10,
  type: 'SRO' as const,
  source: 'SRO_TAB' as const,
};
const brief: WeeklySroBrief = {
  courseRef: 'blockchain',
  weekNumber: 10,
  title: 'СРО №3. Анализ блокчейн-платформ (задание)',
  content: [
    'СРО №3. Анализ блокчейн-платформ',
    'Задание: Написание реферата.',
    '1. Общие требования к реферату',
    '1.1. Объем: 10–15 страниц',
    'Шрифт Times New Roman, размер 12–14 pt.',
    'Межстрочный интервал: 1,5.',
    'Работа должна содержать титульный лист и список литературы.',
    'Минимум 5 источников. Оригинальность текста не менее 70%.',
    'Форма отчетности: Реферат',
  ].join(' '),
};

describe('SRO assignment matcher', () => {
  it('matches SRO №3 from weekly content to the week 10 SRO tab, not week 3', () => {
    expect(matchSroBrief(target, [brief])).toEqual({ status: 'MATCHED', brief });
    expect(matchSroBrief({ ...target, weekNumber: 3 }, [brief]).status).toBe('MISSING');
  });

  it('matches СРС from journal to the same-week СРО destination', () => {
    const srcBrief = { ...brief, weekNumber: 12, title: 'СРС №3. Методы регрессии и классификации' };
    expect(matchSroBrief({ ...target, weekNumber: 12 }, [srcBrief]).status).toBe('MATCHED');
  });

  it('never crosses courses, even when week numbers match', () => {
    expect(matchSroBrief({ ...target, courseRef: 'php' }, [brief]).status).toBe('MISSING');
  });

  it('does not infer a target from missing or unread content', () => {
    expect(matchSroBrief(target, [{ ...brief, content: brief.title }]).status).toBe('MISSING');
  });

  it('halts on multiple SRO briefs in one week', () => {
    const result = matchSroBrief(target, [brief, { ...brief, title: 'СРО №4. Второе задание' }]);
    expect(result.status).toBe('AMBIGUOUS');
  });

  it('only accepts actual SRO tab destinations', () => {
    expect(matchSroBrief({ ...target, source: 'CONTENT' }, [brief]).status).toBe('MISSING');
  });

  it('extracts requirements without generating or uploading a document', () => {
    expect(extractSroRequirements(brief)).toMatchObject({
      title: brief.title,
      reportType: 'Реферат',
      pageRange: { min: 10, max: 15 },
      font: 'Times New Roman',
      fontSize: '12',
      lineSpacing: '1,5',
      minimumSources: 5,
      requiresTitlePage: true,
      requiresReferences: true,
      requiresOriginalityCheck: true,
    });
  });
});

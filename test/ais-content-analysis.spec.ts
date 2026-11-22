import { describe, expect, it } from 'vitest';
import { extractTextFromBuffer } from '../src/university/ais-content-extractor';
import { contentSimilarity, parseContentAssignments } from '../src/university/abu-parsers';
import { activePeriodWeeks } from '../src/university/abu-university.adapter';

describe('AIS content analysis', () => {
  it('scans only the active assessment period in descending order', () => {
    expect(activePeriodWeeks(11)).toEqual([11, 10, 9]);
    expect(activePeriodWeeks(8)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(activePeriodWeeks(15)).toEqual([15, 14, 13, 12, 11, 10, 9]);
  });

  it('extracts text attachments locally', async () => {
    const text = await extractTextFromBuffer(Buffer.from('  Отчёт   по блокчейну  '), 'report.txt', 'text/plain');
    expect(text).toBe('Отчёт по блокчейну');
  });

  it('matches an SRSP against sent subject and extracted content', () => {
    const details = new Map([['СРСП №4. Свойства технологии блокчейн (задание)',
      'Напишите реферат о свойствах блокчейна, децентрализации и смарт-контрактах.']]);
    const [assignment] = parseContentAssignments(
      'course',
      11,
      ['СРСП №4. Свойства технологии блокчейн (задание)'],
      [{
        externalRef: 'mail',
        sentAt: '2026-11-13 10:00:00',
        subject: 'СРСП №4',
        resourceTexts: ['Реферат: блокчейн, децентрализация и смарт-контракты'],
      }],
      details,
    );
    expect(assignment?.submitted).toBe(true);
    expect(assignment?.submissionState).toBe('CONFIRMED');
  });

  it('does not confuse a previous SRSP with the current assignment', () => {
    const [assignment] = parseContentAssignments(
      'course',
      11,
      ['СРСП №4. Свойства технологии блокчейн (задание)'],
      [{ externalRef: 'old', sentAt: '2026-10-01 10:00:00', subject: 'СРСП 3 неделя' }],
      new Map([['СРСП №4. Свойства технологии блокчейн (задание)', 'Свойства технологии блокчейн']]),
    );
    expect(assignment?.submitted).toBe(false);
  });

  it('calculates local keyword similarity without a model call', () => {
    expect(contentSimilarity('блокчейн децентрализация смарт контракты', 'отчёт про блокчейн и смарт контракты'))
      .toBeGreaterThan(0.4);
  });
});

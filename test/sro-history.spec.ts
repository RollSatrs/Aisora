import { describe, expect, it } from 'vitest';
import { classifySroHistory } from '../src/university/sro-history';

describe('SRO uploaded-file history', () => {
  it('recognizes a dated uploaded DOCX even without a grade', () => {
    expect(classifySroHistory(['2026-11-19 14:19:18 сро 10 неделя.docx'], true, true))
      .toMatchObject({ status: 'CONFIRMED', files: ['2026-11-19 14:19:18 сро 10 неделя.docx'] });
  });

  it('does not mistake a choose-file button for a prior upload', () => {
    expect(classifySroHistory(['Выбрать файлы', 'Файл не выбран'], true, true).status).toBe('ABSENT');
  });

  it('reports UNKNOWN when history is still loading or has not stabilized', () => {
    expect(classifySroHistory([], false, true).status).toBe('UNKNOWN');
    expect(classifySroHistory([], true, false).status).toBe('UNKNOWN');
  });

  it('does not treat generic dialog links as uploaded work', () => {
    expect(classifySroHistory(['Close', 'Помощь'], true, true).status).toBe('ABSENT');
  });
});

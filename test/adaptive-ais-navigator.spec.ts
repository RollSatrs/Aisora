import { describe, expect, it } from 'vitest';
import {
  isReadOnlyTarget,
  parseModelTargetId,
  type AisTargetSummary,
} from '../src/university/adaptive-ais-navigator';

const target = (name: string, href?: string): AisTargetSummary => ({
  id: 1,
  name,
  role: 'link',
  href,
});

describe('adaptive AIS navigation safety', () => {
  it('allows read-only navigation targets', () => {
    expect(isReadOnlyTarget(target('Обучение', '/study'))).toBe(true);
    expect(isReadOnlyTarget(target('Электронный журнал', '/journal'))).toBe(true);
    expect(isReadOnlyTarget(target('Отправленные', '/messages/sent'))).toBe(true);
  });

  it('blocks mutating and session actions even if selected by a model', () => {
    expect(isReadOnlyTarget(target('Отправить сообщение', '/message/send'))).toBe(false);
    expect(isReadOnlyTarget(target('Загрузить файл', '/upload'))).toBe(false);
    expect(isReadOnlyTarget(target('Удалить', '/journal'))).toBe(false);
    expect(isReadOnlyTarget(target('Журнал', '/logout'))).toBe(false);
    expect(isReadOnlyTarget(target('Журнал', 'https://example.com/journal'))).toBe(false);
    expect(isReadOnlyTarget(target('Журнал', '//example.com/journal'))).toBe(false);
    expect(isReadOnlyTarget(target('Журнал', 'javascript:sendForm()'))).toBe(false);
    expect(isReadOnlyTarget(target('Обучение', 'javascript:void(0)'))).toBe(true);
  });

  it('accepts only a model target id from the supplied allowlist', () => {
    const allowed = new Set([2, 4]);
    expect(parseModelTargetId('{"targetId":2,"reason":"read-only"}', allowed)).toBe(2);
    expect(parseModelTargetId('```json\n{"targetId":4}\n```', allowed)).toBe(4);
    expect(parseModelTargetId('{"targetId":3}', allowed)).toBeUndefined();
    expect(parseModelTargetId('click target 2', allowed)).toBeUndefined();
  });
});

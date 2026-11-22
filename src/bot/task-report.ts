import type { AssignmentType, StoredAssignment } from '../domain/models';

export type TaskCategory = 'DEBT' | 'CURRENT' | 'UPCOMING' | 'COMPLETED' | 'CLARIFICATION';

const COMPLETED = new Set(['GRADED', 'SUBMITTED_CONFIRMED']);

export function taskCategory(task: StoredAssignment, currentWeek: number): TaskCategory | undefined {
  if (COMPLETED.has(task.status)) return 'COMPLETED';
  if (task.status === 'UPCOMING' || task.weekNumber > currentWeek) return 'UPCOMING';
  if (task.weekNumber === currentWeek) return 'CURRENT';
  if (task.status === 'NOT_STARTED' && task.weekNumber < currentWeek) return 'DEBT';
  if (task.status === 'REQUIRES_CLARIFICATION') return 'CLARIFICATION';
  return undefined;
}

export function formatTaskOverview(tasks: StoredAssignment[], currentWeek: number): string {
  const counts = new Map<TaskCategory, number>();
  for (const task of tasks) {
    const category = taskCategory(task, currentWeek);
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const debts = tasks.filter((task) => taskCategory(task, currentWeek) === 'DEBT');
  const focusedLabs = tasks.filter((task) => task.type === 'LAB' && task.labFocus !== false).length;
  const sroCount = tasks.filter((task) => task.type === 'SRO').length;
  const srspCount = tasks.filter((task) => task.type === 'SRSP').length;
  const labCount = tasks.filter((task) => task.type === 'LAB').length;
  const firstPeriodDebts = debts.filter((task) => task.weekNumber <= 8).length;
  const secondPeriodDebts = debts.length - firstPeriodDebts;
  const period = currentWeek <= 8 ? 'I период (1–8)' : 'II период (9–15)';
  const boundary = currentWeek === 8 || currentWeek === 15 ? ' · рубежный контроль' : '';

  return [
    `📚 Текущая неделя: ${currentWeek} · ${period}${boundary}`,
    '',
    `🔴 Долги: ${counts.get('DEBT') ?? 0}`,
    `   I период, недели 1–8: ${firstPeriodDebts}`,
    `   II период, прошедшие недели: ${secondPeriodDebts}`,
    `🟡 Текущая неделя: ${counts.get('CURRENT') ?? 0}`,
    `🔵 Будущие задания: ${counts.get('UPCOMING') ?? 0}`,
    `✅ Выполнено или оценено: ${counts.get('COMPLETED') ?? 0}`,
    `❓ Требуют проверки: ${counts.get('CLARIFICATION') ?? 0}`,
    `⭐ Лабораторных в фокусе: ${focusedLabs}`,
    '',
    `📝 СРО: ${sroCount}   📚 СРСП: ${srspCount}   🧪 Лабораторные: ${labCount}`,
    '',
    '«Требуют проверки» — это не подтверждённый долг: AIS показал материал, но данных недостаточно, чтобы уверенно определить обязательность или отправку.',
    'Используйте кнопки ниже для подробного списка.',
  ].join('\n');
}

export function formatTaskCategory(
  tasks: StoredAssignment[],
  currentWeek: number,
  category: TaskCategory,
): string[] {
  const selected = tasks
    .filter((task) => taskCategory(task, currentWeek) === category)
    .sort((left, right) => (left.courseName ?? '').localeCompare(right.courseName ?? '', 'ru')
      || Number(right.type === 'LAB' && right.labFocus !== false) - Number(left.type === 'LAB' && left.labFocus !== false)
      || left.weekNumber - right.weekNumber
      || left.title.localeCompare(right.title, 'ru'));
  if (category === 'DEBT') return formatPrioritizedDebts(selected);
  const title = categoryTitle(category, currentWeek);
  if (!selected.length) return [`${title}\n\nСписок пуст.`];

  const sections: string[] = [];
  let course = '';
  let type: AssignmentType | undefined;
  for (const task of selected) {
    const courseName = task.courseName ?? 'Дисциплина';
    if (courseName !== course) {
      course = courseName;
      type = undefined;
      sections.push(`\n📘 ${courseName}`);
    }
    if (task.type !== type) {
      type = task.type;
      sections.push(`  ${typeIcon(task.type)} ${typeLabel(task.type)}`);
    }
    const grade = task.grade === undefined ? '' : ` · оценка ${task.grade}`;
    const focus = task.type === 'LAB' && task.labFocus !== false ? '⭐ ' : '';
    sections.push(`• ${focus}Неделя ${task.weekNumber} · ${task.title}${grade}`);
  }
  return chunkTelegramText([title, ...sections], 3500);
}

function formatPrioritizedDebts(debts: StoredAssignment[]): string[] {
  if (!debts.length) return ['✅ Долгов нет.'];
  const laboratories = debts.filter((task) => task.type === 'LAB')
    .sort((left, right) => Number(right.labFocus !== false) - Number(left.labFocus !== false)
      || left.weekNumber - right.weekNumber
      || left.title.localeCompare(right.title, 'ru'));
  const remaining = debts.filter((task) => task.type !== 'LAB')
    .sort((left, right) => left.weekNumber - right.weekNumber
      || typeRank(left.type) - typeRank(right.type)
      || left.title.localeCompare(right.title, 'ru'));
  const lines = [`🔴 У ВАС ${debts.length} ${debtWord(debts.length)}`];
  let number = 1;

  if (laboratories.length) {
    lines.push('', 'Сначала проверить лабораторные:');
    for (const task of laboratories) {
      const focus = task.labFocus === false ? '' : '⭐ ';
      lines.push(
        '',
        `${number}. ${focus}🧪 ${task.title} — неделя ${task.weekNumber}`,
        `   📘 ${task.courseName ?? 'Дисциплина'}`,
      );
      number += 1;
    }
  }

  if (remaining.length) {
    lines.push('', laboratories.length ? 'Остальные задания:' : 'Задания:');
    for (const task of remaining) {
      lines.push(
        '',
        `${number}. ${typeIcon(task.type)} ${task.title} — неделя ${task.weekNumber}`,
        `   📘 ${task.courseName ?? 'Дисциплина'}`,
      );
      number += 1;
    }
  }
  return chunkTelegramText(lines, 3500);
}

export function formatTaskType(tasks: StoredAssignment[], currentWeek: number, type: AssignmentType): string[] {
  const selected = tasks
    .filter((task) => task.type === type)
    .sort((left, right) => (left.courseName ?? '').localeCompare(right.courseName ?? '', 'ru')
      || left.weekNumber - right.weekNumber
      || left.title.localeCompare(right.title, 'ru'));
  const title = `${typeIcon(type)} ${typeLabel(type)} — все найденные задания`;
  if (!selected.length) return [`${title}\n\nСписок пуст.`];

  const sections: string[] = [];
  let course = '';
  for (const task of selected) {
    const courseName = task.courseName ?? 'Дисциплина';
    if (courseName !== course) {
      course = courseName;
      sections.push(`\n📘 ${courseName}`);
    }
    const category = taskCategory(task, currentWeek);
    const grade = task.grade === undefined ? '' : ` · оценка ${task.grade}`;
    const focus = type === 'LAB' && task.labFocus !== false ? '⭐ ' : '';
    sections.push(`• ${focus}${categoryIcon(category)} Неделя ${task.weekNumber} · ${task.title} — ${categoryLabel(category)}${grade}`);
  }
  return chunkTelegramText([title, '🔴 долг · 🟡 текущая · 🔵 будущая · ✅ выполнено · ❓ проверить', ...sections], 3500);
}

function categoryTitle(category: TaskCategory, currentWeek: number): string {
  if (category === 'DEBT') return '🔴 Долги — прошедшие недели без подтверждённой отправки или оценки';
  if (category === 'CURRENT') return `🟡 Задания текущей ${currentWeek}-й недели`;
  if (category === 'UPCOMING') return '🔵 Будущие задания — долгами не считаются';
  if (category === 'COMPLETED') return '✅ Выполненные и оценённые задания';
  return '❓ Требуют проверки — это ещё не подтверждённые долги';
}

function typeLabel(type: StoredAssignment['type']): string {
  if (type === 'SRO') return 'СРО';
  if (type === 'SRSP') return 'СРСП';
  return 'Лабораторная';
}

function typeIcon(type: AssignmentType): string {
  if (type === 'SRO') return '📝';
  if (type === 'SRSP') return '📚';
  return '🧪';
}

function typeRank(type: AssignmentType): number {
  if (type === 'SRO') return 1;
  if (type === 'SRSP') return 2;
  return 0;
}

function debtWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return 'ДОЛГОВ';
  if (last === 1) return 'ДОЛГ';
  if (last >= 2 && last <= 4) return 'ДОЛГА';
  return 'ДОЛГОВ';
}

function categoryIcon(category: TaskCategory | undefined): string {
  if (category === 'DEBT') return '🔴';
  if (category === 'CURRENT') return '🟡';
  if (category === 'UPCOMING') return '🔵';
  if (category === 'COMPLETED') return '✅';
  return '❓';
}

function categoryLabel(category: TaskCategory | undefined): string {
  if (category === 'DEBT') return 'долг';
  if (category === 'CURRENT') return 'текущая неделя';
  if (category === 'UPCOMING') return 'будущее';
  if (category === 'COMPLETED') return 'выполнено';
  return 'требует проверки';
}

function chunkTelegramText(lines: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

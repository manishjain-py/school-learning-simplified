import { randomInt } from 'node:crypto';
import type { OptionQuestion } from '../grading.js';

export type SetQuestion = OptionQuestion & { difficulty: 'easy' | 'medium' };

/** Prefer unused material before repeating to satisfy a difficulty quota. */
export function selectQuestions(bank: SetQuestion[], seen: Map<string, number>, random: (max: number) => number = randomInt): string[] {
  if (bank.length < 10 || new Set(bank.map(question => question.id)).size !== bank.length) throw new Error('A complete question bank is required.');
  const shuffled = [...bank];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = random(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  shuffled.sort((a, b) => (seen.get(a.id) || 0) - (seen.get(b.id) || 0));
  const chosen: SetQuestion[] = [];
  const take = (difficulty: 'easy' | 'medium' | null, limit: number, unseen: boolean) => {
    for (const question of shuffled) {
      if (limit <= 0 || chosen.length === 10) break;
      if (chosen.includes(question) || (difficulty && question.difficulty !== difficulty) || (unseen && seen.has(question.id))) continue;
      chosen.push(question); limit--;
    }
  };
  take('easy', 4, true); take('medium', 6, true); take(null, 10 - chosen.length, true);
  take('easy', 4 - chosen.filter(question => question.difficulty === 'easy').length, false);
  take('medium', 6 - chosen.filter(question => question.difficulty === 'medium').length, false);
  take(null, 10 - chosen.length, false);
  // An unlucky shuffle must not force repeats when an equally unseen format is available.
  for (const format of new Set(chosen.map(question => question.format))) {
    while (chosen.filter(question => question.format === format).length > 5) {
      const replace = [...chosen].reverse().find(question => question.format === format)!;
      const alternatives = shuffled.filter(question => !chosen.includes(question) && question.format !== format && (seen.get(question.id) || 0) <= (seen.get(replace.id) || 0));
      const replacement = alternatives.find(question => question.difficulty === replace.difficulty) || alternatives[0];
      if (!replacement) break;
      chosen[chosen.indexOf(replace)] = replacement;
    }
  }
  // Largest remaining format first avoids adjacent repeats whenever the mix permits it.
  const groups = new Map<string, SetQuestion[]>();
  for (const question of chosen) groups.set(question.format, [...(groups.get(question.format) || []), question]);
  const ordered: string[] = []; let previous = '';
  while (ordered.length < chosen.length) {
    const available = [...groups.entries()].filter(([, questions]) => questions.length);
    const alternatives = available.filter(([format]) => format !== previous);
    const [format, questions] = (alternatives.length ? alternatives : available).sort((a, b) => b[1].length - a[1].length)[0];
    ordered.push(questions.shift()!.id); previous = format;
  }
  return ordered;
}

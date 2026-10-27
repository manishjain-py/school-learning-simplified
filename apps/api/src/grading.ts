export type OptionQuestion = { id: string; format: 'pick_one' | 'true_false' | 'fill_blank' | 'multi_select'; options: { id: string; text: string }[] };
export type AnswerKey = { correctOptionIds: string[]; correctAnswerText: string; reason: string };

/** Grade canonical option identities, never translated labels or client scores. */
export function gradeOptions(question: OptionQuestion, key: AnswerKey, selection: unknown): boolean {
  if (!Array.isArray(selection) || selection.length === 0 || selection.length > question.options.length || selection.some((id) => typeof id !== 'string') || new Set(selection).size !== selection.length) throw new Error('Choose an answer before checking it.');
  if (question.format !== 'multi_select' && selection.length !== 1) throw new Error('Choose one answer for this question.');
  const allowed = new Set(question.options.map((option) => option.id));
  if (selection.some((id) => !allowed.has(id))) throw new Error('That answer does not belong to this question.');
  if (!key.correctOptionIds.length || key.correctOptionIds.some((id) => !allowed.has(id))) throw new Error('This question is temporarily unavailable.');
  return selection.length === key.correctOptionIds.length && selection.every((id) => key.correctOptionIds.includes(id));
}

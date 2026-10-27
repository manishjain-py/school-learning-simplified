import { useState } from 'react';
import { CheckCircle2, Lightbulb } from 'lucide-react';
import type { Language, PracticeAnswer, Question } from './types';
import { Narration } from './Narration';
import { Text } from './learningShared';

export type Review = Pick<PracticeAnswer, 'correct' | 'selectedOptionIds' | 'correctAnswerText' | 'reason'>;
export function QuestionCard({ question, language, existing, onAnswer, onReviewed }: { question: Question; language: Language; existing?: Review; onAnswer?: (selectedOptionIds: string[]) => Promise<Review>; onReviewed?: () => void }) {
  const [selected, setSelected] = useState<string[]>(existing?.selectedOptionIds || []);
  const [review, setReview] = useState<Review | undefined>(existing);
  const [hint, setHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentReview = existing || review;
  const displaySelection = currentReview?.selectedOptionIds || selected;
  const isMultiple = question.format === 'multi_select';
  const instructions = isMultiple ? 'Choose all the answers that fit.' : question.format === 'fill_blank' ? 'Choose the word or phrase that fills the gap.' : question.format === 'true_false' ? 'Decide whether the statement is true or false.' : 'Choose one answer.';
  async function check() {
    if (!selected.length) return;
    setBusy(true); setError('');
    try {
      let result: Review;
      if (onAnswer) result = await onAnswer(selected);
      else if (question.grading) {
        const key = question.grading;
        result = { selectedOptionIds: selected, correct: selected.length === key.correctOptionIds.length && selected.every((id) => key.correctOptionIds.includes(id)), correctAnswerText: key.correctAnswerText, reason: key.reason };
      } else throw new Error('This question cannot be checked right now. Please try again later.');
      setReview(result); onReviewed?.();
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="question-card" lang={language}><p className="question-instruction">{instructions}</p><h3 className="question-prompt"><Text>{question.prompt}</Text></h3><Narration key={`${question.id}-prompt-${language}`} language={language} showText={false} lines={[{ display: question.prompt, audioUrl: question.audioUrl, audioSha256: question.audioSha256 }]} />
    <fieldset disabled={busy || Boolean(currentReview)} className={question.format === 'fill_blank' ? 'question-options word-bank' : 'question-options'}><legend className="sr-only">{instructions}</legend>{question.options.map((option, index) => <label key={option.id} className={displaySelection.includes(option.id) ? 'option selected' : 'option'}><input type={isMultiple ? 'checkbox' : 'radio'} name={`question-${question.id}`} value={option.id} checked={displaySelection.includes(option.id)} onChange={() => setSelected((current) => isMultiple ? current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id] : [option.id])} /><span className="option-letter">{String.fromCharCode(65 + index)}</span><span><Text>{option.text}</Text></span></label>)}</fieldset>
    {question.hint && !currentReview && <button className="text-button question-hint" onClick={() => setHint(!hint)} aria-expanded={hint}><Lightbulb size={16} />{hint ? 'Hide hint' : 'A little hint'}</button>}
    {hint && question.hint && !currentReview && <div className="hint-box"><p><Text>{question.hint.display}</Text></p><Narration key={`${question.id}-hint-${language}`} language={language} showText={false} lines={[question.hint]} /></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!currentReview ? <button className="button primary check-answer" disabled={!selected.length || busy} onClick={check}>{busy ? 'Checking…' : 'Check answer'}</button> : <div className={currentReview.correct ? 'answer-review correct' : 'answer-review'} role="status"><CheckCircle2 size={22} /><div><strong>{currentReview.correct ? 'You’ve got it.' : 'A chance to understand a little more.'}</strong><p className="correct-answer"><span>Correct answer:</span> <Text>{currentReview.correctAnswerText}</Text></p><p><Text>{currentReview.reason}</Text></p>{question.grading?.successAudioUrl && <Narration key={`${question.id}-feedback-${language}`} language={language} showText={false} lines={[{ display: currentReview.reason, audioUrl: question.grading.successAudioUrl }]} />}</div></div>}
  </div>;
}

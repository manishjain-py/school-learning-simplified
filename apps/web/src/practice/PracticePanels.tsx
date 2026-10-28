import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, Lightbulb, RotateCcw, X } from 'lucide-react';
import { Narration } from '../Narration';
import { Text } from '../learningShared';
import type { Language, LegacyRoundSummary, PracticeBank, PracticeSession, PracticeSet, PracticeSetResult, PracticeSetSummary, Question } from '../types';

export const practiceCopy = (language: Language, en: string, hi: string) => language === 'hi' ? hi : en;
export const pickedText = (question: Question, selected: string[], language: Language) => selected.length
  ? selected.map(id => question.options.find(option => option.id === id)?.text || practiceCopy(language, 'Answer unavailable', 'उत्तर उपलब्ध नहीं')).join(' · ')
  : practiceCopy(language, 'Skipped', 'छोड़ा गया');
export const practiceDate = (value: string, language: Language) => new Intl.DateTimeFormat(language === 'hi' ? 'hi-IN' : 'en-GB', { dateStyle: 'medium' }).format(new Date(value));

export function DraftQuestion({ question, selected, language, disabled, onChange }: { question: Question; selected: string[]; language: Language; disabled: boolean; onChange: (ids: string[]) => void }) {
  const [hint, setHint] = useState(false);
  const multiple = question.format === 'multi_select';
  const instructions = multiple ? practiceCopy(language, 'Choose all the answers that fit.', 'सभी सही लगने वाले उत्तर चुनें।')
    : question.format === 'fill_blank' ? practiceCopy(language, 'Choose the word or phrase that fills the gap.', 'खाली जगह भरने के लिए सही शब्द या वाक्यांश चुनें।')
    : question.format === 'true_false' ? practiceCopy(language, 'Decide whether the statement is true or false.', 'तय करें कि कथन सही है या गलत।') : practiceCopy(language, 'Choose one answer.', 'एक उत्तर चुनें।');
  return <div className="question-card" lang={language}>
    <p className="question-instruction">{instructions}</p><h2 className="question-prompt"><Text>{question.prompt}</Text></h2>
    <Narration key={`${question.id}-prompt-${language}`} language={language} showText={false} lines={[{ display: question.prompt, audioUrl: question.audioUrl, audioSha256: question.audioSha256 }]} />
    <fieldset disabled={disabled} className={question.format === 'fill_blank' ? 'question-options word-bank' : 'question-options'}><legend className="sr-only">{instructions}</legend>{question.options.map((option, index) => <label key={option.id} className={selected.includes(option.id) ? 'option selected' : 'option'}>
      <input type={multiple ? 'checkbox' : 'radio'} name={`practice-${question.id}`} value={option.id} checked={selected.includes(option.id)} onChange={() => onChange(multiple ? selected.includes(option.id) ? selected.filter(id => id !== option.id) : [...selected, option.id] : [option.id])} />
      <span className="option-letter">{String.fromCharCode(65 + index)}</span><span><Text>{option.text}</Text></span>
    </label>)}</fieldset>
    <div className="practice-question-tools">{question.hint && <button type="button" className="text-button" onClick={() => setHint(!hint)} aria-expanded={hint}><Lightbulb size={16} />{hint ? practiceCopy(language, 'Hide hint', 'संकेत छिपाएँ') : practiceCopy(language, 'A little hint', 'एक छोटा संकेत')}</button>}
      {!!selected.length && <button type="button" className="text-button" disabled={disabled} onClick={() => onChange([])}>{practiceCopy(language, 'Clear answer', 'उत्तर हटाएँ')}</button>}</div>
    {hint && question.hint && <div className="hint-box"><p><Text>{question.hint.display}</Text></p><Narration key={`${question.id}-hint-${language}`} language={language} showText={false} lines={[question.hint]} /></div>}
  </div>;
}

export function ReviewPicks({ set, questions, language, disabled, onEdit, onSubmit }: { set: PracticeSet; questions: Question[]; language: Language; disabled: boolean; onEdit: (index: number) => void; onSubmit: () => void }) {
  const answered = questions.filter(question => set.answers[question.id]?.length).length;
  return <section className="practice-review"><p className="eyebrow">{practiceCopy(language, 'BEFORE YOU SUBMIT', 'जमा करने से पहले')}</p><h2>{practiceCopy(language, 'Review your picks.', 'अपने उत्तर एक बार देख लें।')}</h2>
    <p className="practice-help">{practiceCopy(language, 'Tap any question to change your answer. Skipped questions are allowed. Your final submission cannot be changed.', 'उत्तर बदलने के लिए किसी भी प्रश्न पर टैप करें। आप प्रश्न छोड़ भी सकते हैं। जमा करने के बाद उत्तर नहीं बदले जा सकेंगे।')}</p>
    <ol className="practice-pick-list">{questions.map((question, index) => <li key={question.id}><button type="button" onClick={() => onEdit(index)} disabled={disabled}>
      <span className="practice-number">{index + 1}</span><span className="practice-pick-copy"><strong><Text>{question.prompt}</Text></strong><small className={set.answers[question.id]?.length ? '' : 'practice-skipped'}><Text>{pickedText(question, set.answers[question.id] || [], language)}</Text></small></span><ChevronRight size={18} />
    </button></li>)}</ol>
    <div className="practice-submit"><p>{answered}/{set.total} {practiceCopy(language, 'answered', 'के उत्तर दिए')}</p><button type="button" className="button primary" disabled={disabled} onClick={onSubmit}>{practiceCopy(language, 'Submit', 'जमा करें')} {answered}/{set.total}<Check size={17} /></button></div>
  </section>;
}

function AnswerSheet({ question, result, number, language, onClose }: { question: Question; result: PracticeSetResult; number: number; language: Language; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { element.close(); document.body.style.overflow = previous; }; }, []);
  return <dialog ref={dialog} className="practice-answer-sheet" aria-labelledby="practice-answer-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="practice-sheet-heading"><span className={`practice-verdict ${result.verdict}`}>{result.verdict === 'correct' ? practiceCopy(language, 'Correct', 'सही') : result.verdict === 'incorrect' ? practiceCopy(language, 'Incorrect', 'गलत') : practiceCopy(language, 'Skipped', 'छोड़ा गया')}</span><button type="button" className="icon-button" aria-label={practiceCopy(language, 'Close answer explanation', 'उत्तर का कारण बंद करें')} onClick={onClose}><X size={23} /></button></div>
    <p className="eyebrow">{practiceCopy(language, 'QUESTION', 'प्रश्न')} {number}</p><h2 id="practice-answer-title" lang={language}><Text>{question.prompt}</Text></h2>
    <Narration key={`${question.id}-result-${language}`} language={language} showText={false} lines={[{ display: question.prompt, audioUrl: question.audioUrl, audioSha256: question.audioSha256 }]} />
    <dl className="practice-answer-comparison" lang={language}><div><dt>{practiceCopy(language, 'Your answer', 'आपका उत्तर')}</dt><dd><Text>{pickedText(question, result.selectedOptionIds, language)}</Text></dd></div><div><dt>{practiceCopy(language, 'Correct answer', 'सही उत्तर')}</dt><dd><Text>{result.correctAnswerText}</Text></dd></div></dl>
    <section className="practice-explanation" lang={language}><h3>{practiceCopy(language, 'Here’s why', 'कारण समझें')}</h3><p><Text>{result.reason}</Text></p></section>
    <button type="button" className="button secondary full" onClick={onClose}>{practiceCopy(language, 'Back to results', 'नतीजों पर वापस जाएँ')}</button>
  </dialog>;
}

export function ResultGroups({ results, questions, language }: { results: PracticeSetResult[]; questions: Question[]; language: Language }) {
  const [selected, setSelected] = useState<string | null>(null);
  const question = questions.find(item => item.id === selected); const result = results.find(item => item.questionId === selected);
  return <>
    {(['incorrect', 'correct', 'skipped'] as const).map(verdict => {
      const rows = results.filter(item => item.verdict === verdict);
      return <section className="practice-result-group" key={verdict}><h3>{verdict === 'incorrect' ? practiceCopy(language, 'Incorrect', 'गलत') : verdict === 'correct' ? practiceCopy(language, 'Correct', 'सही') : practiceCopy(language, 'Skipped', 'छोड़े गए')}<span>{rows.length}</span></h3>
        {rows.length ? <ul>{rows.map(row => { const item = questions.find(item => item.id === row.questionId); return item ? <li key={row.questionId}><button type="button" onClick={() => setSelected(row.questionId)}><span className={`practice-result-mark ${verdict}`}>{questions.findIndex(question => question.id === item.id) + 1}</span><span><Text>{item.prompt}</Text><small>{practiceCopy(language, 'Here’s why', 'कारण समझें')}</small></span><ChevronRight size={18} /></button></li> : null; })}</ul> : <p className="practice-group-empty">{practiceCopy(language, 'None in this group.', 'इस हिस्से में कोई प्रश्न नहीं है।')}</p>}
      </section>;
    })}
    {question && result && <AnswerSheet question={question} result={result} number={questions.findIndex(item => item.id === question.id) + 1} language={language} onClose={() => setSelected(null)} />}
  </>;
}

export function PracticeResults({ set, questions, language, disabled, onAgain, onKeepLearning }: { set: Extract<PracticeSet, { status: 'submitted' }>; questions: Question[]; language: Language; disabled: boolean; onAgain: () => void; onKeepLearning: () => void }) {
  const headline = set.score >= 9 ? practiceCopy(language, 'Brilliant!', 'बहुत खूब!') : set.score >= 7 ? practiceCopy(language, 'Well done!', 'शाबाश!') : set.score >= 5 ? practiceCopy(language, 'Almost there!', 'बस थोड़ी और कोशिश!') : practiceCopy(language, 'Good try!', 'अच्छी कोशिश!');
  return <section className="practice-results"><div className="practice-result-hero"><p className="eyebrow">{practiceCopy(language, 'YOUR PRACTICE SET', 'आपका अभ्यास सेट')}</p><h2>{headline}</h2><div className="practice-final-score"><strong>{set.score}</strong><span>/{set.total}</span></div><p>{practiceCopy(language, 'Submitted', 'जमा किया')} · {practiceDate(set.submittedAt, language)}</p><small>{practiceCopy(language, 'Recorded practice results, one step at a time.', 'अभ्यास के नतीजे — एक-एक कदम आगे बढ़ें।')}</small></div>
    <ResultGroups results={set.results} questions={questions} language={language} />
    <div className="practice-result-actions"><button type="button" className="button primary" disabled={disabled} onClick={onAgain}><RotateCcw size={17} />{practiceCopy(language, 'Practice again', 'फिर अभ्यास करें')}</button><button type="button" className="button secondary" disabled={disabled} onClick={onKeepLearning}>{practiceCopy(language, 'Keep learning', 'सीखते रहें')}<ArrowRight size={17} /></button></div>
    {set.recommendationId && <p className="practice-help">{practiceCopy(language, 'This submitted set stays with your teacher’s recommendation. Practice again opens your own next set.', 'यह जमा किया गया सेट शिक्षक के सुझाव से जुड़ा रहेगा। फिर अभ्यास करने पर आपका अपना अगला सेट खुलेगा।')}</p>}
  </section>;
}

export function PracticeHistory({ sets, legacyRounds, language, disabled, onOpen, onLegacy }: { sets: PracticeSetSummary[]; legacyRounds: LegacyRoundSummary[]; language: Language; disabled: boolean; onOpen: (id: string) => void; onLegacy: (id: string) => void }) {
  return <section className="practice-history"><p className="eyebrow">{practiceCopy(language, 'YOUR RECORDED WORK', 'आपका किया हुआ अभ्यास')}</p><h2>{practiceCopy(language, 'Past sets', 'पिछले सेट')}</h2>{!sets.length && <p className="practice-help">{practiceCopy(language, 'Your saved sets will appear here.', 'आपके सहेजे गए सेट यहाँ दिखाई देंगे।')}</p>}
    <ul className="practice-history-list">{sets.map(set => <li key={set.id}><button type="button" disabled={disabled} onClick={() => onOpen(set.id)}><span><strong>{practiceDate(set.submittedAt || set.createdAt, language)}</strong><small>{set.recommendationId ? practiceCopy(language, 'From your teacher', 'शिक्षक के सुझाव से') : practiceCopy(language, 'Your own practice', 'आपका अपना अभ्यास')} · {set.status === 'submitted' ? practiceCopy(language, 'Submitted', 'जमा किया') : practiceCopy(language, 'In progress', 'जारी है')}</small></span><strong className="practice-history-score">{set.status === 'submitted' ? `${set.score}/${set.total}` : `${set.answered}/${set.total} ${practiceCopy(language, 'answered', 'उत्तर')}`}</strong><ChevronRight size={18} /></button></li>)}</ul>
    {!!legacyRounds.length && <><h3>{practiceCopy(language, 'Earlier practice rounds', 'पहले किए गए अभ्यास दौर')}</h3><p className="practice-help">{practiceCopy(language, 'Your earlier answers are preserved here for review.', 'आपके पुराने उत्तर यहाँ सुरक्षित हैं। आप उन्हें फिर से देख सकते हैं।')}</p><ul className="practice-history-list">{legacyRounds.map(round => <li key={round.id}><button type="button" disabled={disabled} onClick={() => onLegacy(round.id)}><span><strong>{practiceDate(round.startedAt, language)}</strong><small>{round.answered}/{round.totalQuestions} {practiceCopy(language, 'answered · read-only', 'उत्तर दिए · केवल देखने के लिए')}</small></span><strong>{round.correctCount} {practiceCopy(language, 'correct', 'सही')}</strong><ChevronRight size={18} /></button></li>)}</ul></>}
  </section>;
}

export function LegacyResults({ round, bank, language }: { round: PracticeSession; bank: PracticeBank; language: Language }) {
  const results: PracticeSetResult[] = round.answers.map(answer => ({ ...answer, verdict: answer.correct ? 'correct' : 'incorrect' }));
  return <section className="practice-results"><div className="practice-result-hero"><p className="eyebrow">{practiceCopy(language, 'EARLIER PRACTICE ROUND', 'पुराना अभ्यास दौर')}</p><h2>{practiceCopy(language, 'Your answers, preserved.', 'आपके उत्तर सुरक्षित हैं।')}</h2><div className="practice-final-score"><strong>{round.correctCount}</strong><span>/{round.answered}</span></div><p>{round.answered}/{round.totalQuestions} {practiceCopy(language, 'answered', 'उत्तर दिए')} · {practiceDate(round.startedAt, language)}</p><small>{practiceCopy(language, 'Read-only history. New practice uses sets of ten.', 'यह पुराने अभ्यास का रिकॉर्ड है। नया अभ्यास दस प्रश्नों के सेट में होगा।')}</small></div><ResultGroups results={results} questions={bank.questions} language={language} /></section>;
}

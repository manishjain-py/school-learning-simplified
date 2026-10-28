import { uiError } from '../uiCopy';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, GraduationCap, Layers, Leaf, ListChecks, RefreshCw } from 'lucide-react';
import { request } from '../api';
import { friendlySchoolTimestamp } from '../school/dates';
import type { Config, Language, LearningMode, User } from '../types';
import './reports.css';

type Coverage = { completed: number; total: number; percent: number };
type ChapterReport = { id: string; title: string; learn: Coverage; revise: Coverage; practice: { setsSubmitted: number; latest: null | { score: number; total: number; submittedAt: string; language: Language } }; lastStudiedAt: string | null };
type Report = { view: 'self' | 'parent'; readOnly: boolean; learner: { name: string; language: Language }; timeZone: string; generatedAt: string; summary: { chaptersStudied: number; ideasExplored: number; cardsRevised: number; practiceSetsDone: number }; subjects: { subject: string; title: string; chapters: ChapterReport[] }[] };
type ReportResponse = { report: Report } | { report: null; status: 'learner_not_connected' };
type ParentContext = { schoolId: string; classId: string; childId: string };
type Props = { config: Config; user: User; navigate: (path: string) => void; preferredLanguage?: Language; parent?: ParentContext };
type State = { scope: string; data: ReportResponse | null; error: string; loading: boolean };
const text = (language: Language, en: string, hi: string) => language === 'hi' ? hi : en;

export function ReportCardView({ config, user, navigate, parent, preferredLanguage = 'en' }: Props) {
  const path = parent ? `/school/family/parent/${encodeURIComponent(parent.schoolId)}/${encodeURIComponent(parent.classId)}/${encodeURIComponent(parent.childId)}/report` : '/reports/mine';
  const scope = `${user.id}:${path}`;
  const [state, setState] = useState<State>({ scope: '', data: null, error: '', loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ scope, data: null, error: '', loading: true });
    request<ReportResponse>(config, path, { authenticated: true, expectedUserId: user.id, signal: abort.signal }).then(data => {
      if (abort.signal.aborted) return;
      if (data.report && (data.report.view !== (parent ? 'parent' : 'self') || (parent && !data.report.readOnly))) throw new Error('This report could not open. Refresh your school connections and try again.');
      setState({ scope, data, error: '', loading: false });
    }).catch(issue => {
      if (!abort.signal.aborted) setState({ scope, data: null, error: issue.message || 'Your report could not load. Please try again.', loading: false });
    });
    return () => abort.abort();
  }, [config, user.id, path, scope, revision]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') setRevision(value => value + 1); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const current = state.scope === scope ? state : { scope, data: null, error: '', loading: true };
  const report = current.data?.report;
  const language = report?.learner.language || preferredLanguage;
  const copy = (en: string, hi: string) => text(language, en, hi);
  const readOnly = Boolean(parent) || report?.readOnly !== false || report.view !== 'self';
  const back = () => navigate(parent ? '/school' : '/');
  return <main className="report-page page-width" lang={language}>
    <div className="report-navigation"><button type="button" className="text-button" onClick={back}><ArrowLeft size={17} />{parent ? copy('Family workspace', 'परिवार का पेज') : copy('My library', 'मेरी लाइब्रेरी')}</button><button type="button" className="text-button" disabled={current.loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />{copy('Refresh', 'फिर से देखें')}</button></div>
    {current.loading ? <section className="report-state" role="status"><span className="report-symbol"><ListChecks size={30} /></span><h1>{copy('Opening recorded learning…', 'सीखने का रिकॉर्ड खोला जा रहा है…')}</h1><p>{copy('Gathering saved activities and submitted practice sets.', 'सहेजी गई गतिविधियाँ और जमा किए गए अभ्यास सेट देखे जा रहे हैं।')}</p></section>
      : current.error ? <section className="report-state"><span className="report-symbol"><BookOpen size={30} /></span><h1>{copy('This report couldn’t open.', 'यह रिपोर्ट नहीं खुल सकी।')}</h1><p className="form-error" role="alert">{uiError(language, current.error, 'यह रिपोर्ट नहीं खुल सकी। अपना खाता और स्कूल से जुड़ाव जाँचें, फिर कोशिश करें।')}</p><button type="button" className="button primary" onClick={() => setRevision(value => value + 1)}>{copy('Try again', 'फिर कोशिश करें')}</button></section>
      : !report ? <section className="report-state"><span className="report-symbol"><GraduationCap size={31} /></span><h1>Your child’s learning connection is next.</h1><p>The student needs to sign in with the email recorded by their school before their saved learning can appear here. Once that connection is ready, this page will show their recorded work.</p><button type="button" className="button secondary" onClick={back}>Back to family workspace<ArrowRight size={17} /></button></section>
      : <>
        <header className="report-heading"><div><p className="eyebrow">{copy('ONE STEP AT A TIME', 'एक-एक कदम आगे')}</p><h1>{language === 'hi' ? `${report.learner.name} का रिपोर्ट कार्ड` : `${report.learner.name}’s report card`}</h1><p>{copy('Saved learning and practice from the library and school recommendations.', 'लाइब्रेरी और स्कूल के सुझावों से किए गए सीखने और अभ्यास का सहेजा रिकॉर्ड।')}</p></div><span className="report-heading-icon"><Leaf size={42} strokeWidth={1.4} /></span></header>
        {readOnly && <p className="report-read-only"><CheckCircle2 size={16} />{copy('Your child’s recorded work · read-only', 'आपके बच्चे का सहेजा काम · केवल देखने के लिए')}</p>}
        <dl className="report-summary">
          <div><GraduationCap size={21} aria-hidden="true" /><dt>{copy('Chapters studied', 'पढ़े गए अध्याय')}</dt><dd>{report.summary.chaptersStudied}</dd></div>
          <div><BookOpen size={21} aria-hidden="true" /><dt>{copy('Ideas explored', 'देखे गए विचार')}</dt><dd>{report.summary.ideasExplored}</dd></div>
          <div><Layers size={21} aria-hidden="true" /><dt>{copy('Cards revised', 'दोहराए गए कार्ड')}</dt><dd>{report.summary.cardsRevised}</dd></div>
          <div><ListChecks size={21} aria-hidden="true" /><dt>{copy('Practice sets done', 'पूरे किए गए अभ्यास सेट')}</dt><dd>{report.summary.practiceSetsDone}</dd></div>
        </dl>
        {!report.summary.chaptersStudied && <section className="report-empty"><BookOpen size={25} /><div><h2>{readOnly ? copy('Learning will appear here.', 'सीखने का रिकॉर्ड यहाँ दिखाई देगा।') : copy('Your first chapter is waiting.', 'आपका पहला अध्याय आपका इंतज़ार कर रहा है।')}</h2><p>{readOnly ? copy('As your child explores, revises and submits practice sets, their recorded work will fill this page.', 'आपका बच्चा जैसे-जैसे पढ़ेगा, दोहराएगा और अभ्यास सेट जमा करेगा, उसका काम यहाँ दिखाई देगा।') : copy('Explore an idea, revisit a card or try a practice set. Each saved step will appear here.', 'एक विचार देखें, किसी कार्ड को दोहराएँ या अभ्यास सेट करें। हर सहेजा कदम यहाँ दिखाई देगा।')}</p></div></section>}
        {report.subjects.map(subject => <section className="report-subject" key={subject.subject}><div className="report-subject-heading"><span><Leaf size={22} /></span><div><p className="eyebrow">{subject.subject}</p><h2>{language === 'hi' && subject.subject === 'EVS' ? 'पर्यावरण अध्ययन' : subject.title}</h2></div></div><div className="report-chapters">{subject.chapters.map(chapter => <ChapterCard key={chapter.id} chapter={chapter} language={language} timeZone={report.timeZone} readOnly={readOnly} onMode={mode => navigate(`/${mode}/${encodeURIComponent(chapter.id)}`)} />)}</div></section>)}
        <footer className="report-footer"><p>{copy('Counts show saved activity and submitted practice results.', 'गिनती में सहेजी गई गतिविधियाँ और जमा किए गए अभ्यास के नतीजे शामिल हैं।')}</p><p>{copy('Updated', 'अपडेट किया')} <time dateTime={report.generatedAt}>{friendlySchoolTimestamp(report.generatedAt, report.timeZone, { locale: language })}</time></p></footer>
      </>}
  </main>;
}

function ChapterCard({ chapter, language, timeZone, readOnly, onMode }: { chapter: ChapterReport; language: Language; timeZone: string; readOnly: boolean; onMode: (mode: LearningMode) => void }) {
  const copy = (en: string, hi: string) => text(language, en, hi);
  const revised = chapter.revise.total > 0 && chapter.revise.completed === chapter.revise.total;
  const latest = chapter.practice.latest;
  return <article className="report-chapter"><h3>{chapter.title}</h3><p className="report-last-studied">{chapter.lastStudiedAt ? <>{copy('Last studied', 'आखिरी बार पढ़ा')} · <time dateTime={chapter.lastStudiedAt}>{friendlySchoolTimestamp(chapter.lastStudiedAt, timeZone, { locale: language })}</time></> : copy('No saved activity yet', 'अभी कोई गतिविधि सहेजी नहीं गई है')}</p>
    <div className="report-coverage"><div><h4>{copy('Learn', 'सीखें')}</h4><strong>{Math.round(chapter.learn.percent)}%</strong></div><progress max={chapter.learn.total || 1} value={chapter.learn.completed} aria-label={copy('Learn coverage', 'सीखने की प्रगति')} /><p>{chapter.learn.completed}/{chapter.learn.total} {copy('ideas explored', 'विचार देखे गए')}</p></div>
    <div className="report-coverage"><div><h4>{copy('Revise', 'दोहराएँ')}</h4>{revised ? <span className="report-revised"><CheckCircle2 size={13} />{copy('Revised', 'दोहराया गया')}</span> : <strong>{Math.round(chapter.revise.percent)}%</strong>}</div><progress max={chapter.revise.total || 1} value={chapter.revise.completed} aria-label={copy('Revision coverage', 'दोहराने की प्रगति')} /><p>{chapter.revise.completed}/{chapter.revise.total} {copy('cards reviewed', 'कार्ड दोहराए गए')}</p></div>
    <div className="report-practice"><div><ListChecks size={20} /><h4>{copy('Practice', 'अभ्यास')}</h4></div>{latest ? <><p className="report-practice-score"><strong>{latest.score}/{latest.total}</strong><span>· {chapter.practice.setsSubmitted} {copy(chapter.practice.setsSubmitted === 1 ? 'set' : 'sets', 'सेट')}</span></p><small>{copy('Latest submitted set', 'आखिरी जमा किया गया सेट')}</small></> : <p className="report-practice-empty">{copy('No submitted sets yet', 'अभी कोई सेट जमा नहीं किया गया है')}</p>}</div>
    {!readOnly && <nav className="report-mode-actions" aria-label={copy(`Study ${chapter.title}`, `${chapter.title} का अध्ययन करें`)}><button type="button" onClick={() => onMode('learn')}><BookOpen size={16} />{copy('Learn', 'सीखें')}</button><button type="button" onClick={() => onMode('revise')}><Layers size={16} />{copy('Revise', 'दोहराएँ')}</button><button type="button" onClick={() => onMode('practice')}><ListChecks size={16} />{copy('Practice', 'अभ्यास')}</button></nav>}
  </article>;
}

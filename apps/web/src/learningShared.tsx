import { BookOpen, Layers, Pencil } from 'lucide-react';
import type { Language, LearningMode } from './types';

export function Text({ children }: { children: string }) {
  return <>{children.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</>;
}

export function ModeTabs({ mode, onMode, language = 'en' }: { mode: LearningMode; onMode: (mode: LearningMode) => void; language?: Language }) {
  return <nav className="mode-tabs" aria-label={language === 'hi' ? 'सीखने का तरीका' : 'Learning mode'}>
    <button aria-current={mode === 'learn' ? 'page' : undefined} onClick={() => onMode('learn')}><BookOpen size={16} />{language === 'hi' ? 'सीखें' : 'Learn'}</button>
    <button aria-current={mode === 'practice' ? 'page' : undefined} onClick={() => onMode('practice')}><Pencil size={16} />{language === 'hi' ? 'अभ्यास' : 'Practice'}</button>
    <button aria-current={mode === 'revise' ? 'page' : undefined} onClick={() => onMode('revise')}><Layers size={16} />{language === 'hi' ? 'दोहराएँ' : 'Revise'}</button>
  </nav>;
}

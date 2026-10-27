import { BookOpen, Layers, Pencil } from 'lucide-react';
import type { LearningMode } from './types';

export function Text({ children }: { children: string }) {
  return <>{children.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</>;
}

export function ModeTabs({ mode, onMode }: { mode: LearningMode; onMode: (mode: LearningMode) => void }) {
  return <nav className="mode-tabs" aria-label="Learning mode">
    <button aria-current={mode === 'learn' ? 'page' : undefined} onClick={() => onMode('learn')}><BookOpen size={16} />Learn</button>
    <button aria-current={mode === 'practice' ? 'page' : undefined} onClick={() => onMode('practice')}><Pencil size={16} />Practice</button>
    <button aria-current={mode === 'revise' ? 'page' : undefined} onClick={() => onMode('revise')}><Layers size={16} />Revise</button>
  </nav>;
}

import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Config, Language, Progress, User } from './types';

export function useLearningProgress(config: Config, chapterId: string, user: User | null, mode: 'learn' | 'revise', recommendationId?: string) {
  const [language, setLanguage] = useState<Language>('en');
  const [currentCardId, setCurrentCardId] = useState<string | null>(null);
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(Boolean(user));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const owner = useRef<string | null>(user?.id || null);
  owner.current = user?.id || null;
  useEffect(() => () => { owner.current = null; }, []);
  const pending = useRef(0);
  const path = `/progress/${chapterId}?mode=${mode}${recommendationId !== undefined ? `&recommendation=${encodeURIComponent(recommendationId)}` : ''}`;
  useEffect(() => {
    let alive = true; setError(''); setSaved(false);
    if (!user) { setCompletedIds([]); setLoading(false); return; }
    setLoading(true);
    void request<Progress>(config, path, { authenticated: true, expectedUserId: user.id }).then((progress) => {
      if (!alive) return;
      setCurrentCardId(progress.currentCardId); setCompletedIds(progress.completedCardIds || []);
      setLanguage(progress.language || 'en'); setSaved(Boolean(progress.updatedAt));
    }).catch((issue: Error) => { if (alive) setError(`Saved progress could not be loaded. ${issue.message}`); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [config, user?.id, path]);
  function persist(id: string, completed: string[], selectedLanguage: Language) {
    if (!user || loading) return;
    const expectedOwner = user.id;
    pending.current++; setSaving(true); setSaved(false); setError('');
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (owner.current !== expectedOwner) return;
      try { await request<Progress>(config, path, { authenticated: true, expectedUserId: expectedOwner, body: { currentCardId: id, completedCardIds: completed, language: selectedLanguage } }); if (owner.current === expectedOwner) setSaved(true); }
      catch (issue) { if (owner.current === expectedOwner) setError((issue as Error).message); }
    }).finally(() => { pending.current--; if (!pending.current) setSaving(false); });
  }
  function visit(id: string, completed = completedIds) { setCurrentCardId(id); setCompletedIds(completed); persist(id, completed, language); }
  function changeLanguage(next: Language, fallbackCardId?: string) { setLanguage(next); const id = currentCardId || fallbackCardId; if (id) persist(id, completedIds, next); }
  function retry(fallbackCardId: string) { persist(currentCardId || fallbackCardId, completedIds, language); }
  return { language, changeLanguage, currentCardId, completedIds, loading, saving, saved, error, visit, retry };
}

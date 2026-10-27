export type Language = 'en' | 'hi';
export type Config = { apiBaseUrl: string; region: string; userPoolId: string; userPoolClientId: string; release: string };
export type User = { id: string; email: string; emailVerified: boolean };
export type Chapter = { id: string; title: string; description: string; grade: number; subject: string; languages: Language[]; status: string; cardCount: number };
export type Catalog = { schemaVersion: number; chapters: Chapter[] };
export type Card = { id: string; title: string; kind: string; lines: { display: string; audioUrl: string }[] };
export type Lesson = { schemaVersion: number; id: string; title: string; language: Language; cards: Card[] };
export type Progress = { chapterId: string; currentCardId: string | null; completedCardIds: string[]; language: Language; updatedAt: string | null };

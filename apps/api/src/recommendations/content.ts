import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CatalogEntry } from '../ai/index.js';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const cache = new Map<string, { until: number; value: unknown }>();
export async function recommendationContent<T>(path: string): Promise<T> {
  const key = `${process.env.CONTENT_RELEASE === 'm2' ? 'content/releases/m2' : 'content'}/${path}`;
  const hit = cache.get(key); if (hit && hit.until > Date.now()) return hit.value as T;
  const raw = process.env.LOCAL_CONTENT_DIR && process.env.NODE_ENV !== 'production'
    ? await readFile(resolve(process.env.LOCAL_CONTENT_DIR, path), 'utf8')
    : await (await s3.send(new GetObjectCommand({ Bucket: process.env.CONTENT_BUCKET, Key: key }))).Body!.transformToString();
  const value = JSON.parse(raw); cache.set(key, { until: Date.now() + 30_000, value }); return value;
}
export async function recommendationCatalog(): Promise<CatalogEntry[]> {
  const data = await recommendationContent<{ chapters: (CatalogEntry & { parts?: { title: string }[] })[] }>('catalog.json');
  return data.chapters.map(item => ({ id: item.id, title: item.title, subject: item.subject,
    modes: item.modes || ['learn'], topics: item.parts?.map(part => part.title) || [] }));
}

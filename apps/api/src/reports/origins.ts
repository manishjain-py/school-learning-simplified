/** Discovery only: readers must validate the canonical META and ACTIVITY records. */
export function reportOriginRow(accountId: string, studentId: string, recommendation: { id: string; chapterId: string; mode: string }) {
  return { PK: `USER#${accountId}`, SK: `REPORT_ORIGIN#${recommendation.id}#${studentId}`, kind: 'report-origin', schemaVersion: 1, recommendationId: recommendation.id, studentId, chapterId: recommendation.chapterId, mode: recommendation.mode };
}

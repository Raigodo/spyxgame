/** First 8 characters, for readable logs. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

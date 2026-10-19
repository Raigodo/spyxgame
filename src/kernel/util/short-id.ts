/** Last 8 characters, for readable logs. (ULIDs start with a timestamp, so the tail is the varying part.) */
export function shortId(id: string): string {
  return id.slice(-8);
}

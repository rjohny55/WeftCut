/** An opt-in resident cache ceiling, never execution concurrency. Invalid
 * configuration preserves the shipping three-page cache. */
export function exportMotifHostLimit(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 1 && number <= 12 ? number : 3;
}

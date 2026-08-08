/**
 * Exact decimal-string parsing. The feed's *_str fields are the authoritative
 * values; parsing them digit-by-digit into integer ticks/sats avoids ever
 * routing a market quantity through binary floating point.
 */
export function parseDecimal(str: string, decimals: number): number {
  const dot = str.indexOf(".");
  const whole = dot === -1 ? str : str.slice(0, dot);
  let frac = dot === -1 ? "" : str.slice(dot + 1);
  if (frac.length > decimals) {
    // More precision than the instrument's tick — the config is wrong for
    // this pair. Loud failure beats a silently rounded book.
    throw new Error(`"${str}" has more than ${decimals} decimals`);
  }
  frac = frac.padEnd(decimals, "0");
  const value = Number(whole + frac);
  if (!Number.isSafeInteger(value)) throw new Error(`"${str}" does not parse to a safe integer`);
  return value;
}

export function formatDecimal(value: number, decimals: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const s = String(abs).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return decimals === 0 ? sign + whole : `${sign}${whole}.${frac}`;
}

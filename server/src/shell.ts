export const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

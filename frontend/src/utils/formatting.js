export function displayValue(value) {
  if (value === null || value === undefined) return 'UNKNOWN';
  const s = String(value).trim();
  return s === '' ? 'UNKNOWN' : s;
}

export function isKnown(value) {
  const s = String(value ?? '').trim();
  return s !== '' && s.toUpperCase() !== 'UNKNOWN';
}

export function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
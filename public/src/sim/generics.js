export function parseGenerics(text) {
  const parts = []; let part = '', quote = '', escaped = false;
  for (const ch of text) {
    if (escaped) { part += ch; escaped = false; continue; }
    if (ch === '\\' && quote === '"') { part += ch; escaped = true; continue; }
    if (quote) { part += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; part += ch; }
    else if (ch === ',') { parts.push(part); part = ''; }
    else part += ch;
  }
  if (quote || escaped) throw new Error('Close the quoted generic value.');
  if (part.trim()) parts.push(part);
  const result = Object.create(null), names = new Set();
  for (const entry of parts) {
    const match = entry.trim().match(/^([a-z]\w*)\s*=\s*(.+)$/i);
    if (!match) throw new Error('Use comma-separated scalar overrides: WIDTH=32, MODE="fast", FLAG=true.');
    const key = match[1], raw = match[2].trim();
    if (names.has(key.toLowerCase())) throw new Error(`Duplicate generic: ${key}.`);
    names.add(key.toLowerCase());
    let value = raw;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw new Error(`Invalid quoted string for ${key}.`); }
      if (typeof value !== 'string') throw new Error(`Expected a string for ${key}.`);
    }
    if (/[\0\r\n]/.test(value) || value.length > 4096) throw new Error(`Invalid generic value for ${key}.`);
    result[key] = value;
  }
  return result;
}

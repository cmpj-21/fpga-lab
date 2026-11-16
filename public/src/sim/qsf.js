function words(line) {
  const result = []; let word = '', quote = false, braces = 0, active = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { word += line[++i]; active = true; continue; }
    if (!quote && !braces && ch === '#') break;
    if (!braces && ch === '"') { quote = !quote; active = true; continue; }
    if (!quote && ch === '{') { if (braces++) word += ch; active = true; continue; }
    if (!quote && ch === '}' && braces) { if (--braces) word += ch; continue; }
    if (!quote && !braces && /\s/.test(ch)) { if (active) result.push(word); word = ''; active = false; }
    else { word += ch; active = true; }
  }
  if (quote || braces) throw new Error('Unterminated quote or brace in QSF assignment.');
  if (active) result.push(word);
  return result;
}

export function parseQsf(text) {
  const out = { family: null, device: null, top: null, outputDir: null, pins: [], globals: [], instances: [], files: [], includes: [] };
  const pins = new Map();
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    if (!/^\s*set_(location|global|instance)_assignment\b/i.test(line)) continue;
    const [command, ...args] = words(line);
    const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    if (command.toLowerCase() === 'set_location_assignment') {
      const pin = args.find(v => /^PIN_\d+$/i.test(v)), target = option('-to');
      if (!pin || !target) throw new Error('QSF pin assignment requires PIN_number and -to port.');
      const number = Number(pin.slice(4));
      if (number < 1 || number > 144) throw new Error(`Pin ${number} is outside the EQFP-144 package.`);
      pins.set(number, target);
    } else {
      const at = args.indexOf('-name'), key = args[at + 1]?.toUpperCase(), value = args[at + 2];
      if (at < 0 || !key || value === undefined) throw new Error('Invalid QSF named assignment.');
      if (command.toLowerCase() === 'set_instance_assignment') {
        const target = option('-to'); if (target) out.instances.push({ key, value, target });
        continue;
      }
      out.globals.push({ key, value, section: option('-section_id') });
      if (key === 'FAMILY') out.family = value;
      else if (key === 'DEVICE') out.device = value;
      else if (key === 'TOP_LEVEL_ENTITY') out.top = value;
      else if (key === 'PROJECT_OUTPUT_DIRECTORY') out.outputDir = value;
      else if (['VERILOG_FILE','VHDL_FILE','SYSTEMVERILOG_FILE','QIP_FILE'].includes(key)) out.files.push({ lang: key.split('_')[0].toLowerCase(), path: value, library: option('-library') });
      else if (['VERILOG_INCLUDE_FILE','VHDL_INCLUDE_FILE'].includes(key)) out.includes.push(value);
    }
  }
  out.pins = [...pins].map(([pin, target]) => ({ pin, target }));
  return out;
}

export function pinMap(qsf) { return new Map(qsf.pins.map(p => [p.target.toLowerCase(), p.pin])); }

export function busMap(qsf) {
  const buses = new Map();
  for (const p of qsf.pins) {
    const m = p.target.match(/^(.+?)\[(-?\d+)\]$/);
    if (!m) continue;
    const base = m[1].toLowerCase();
    if (!buses.has(base)) buses.set(base, []);
    buses.get(base).push({ index: Number(m[2]), pin: p.pin });
  }
  for (const entries of buses.values()) entries.sort((a, b) => b.index - a.index);
  return buses;
}

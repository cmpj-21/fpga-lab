// Lightweight static analyzer for classic VHDL-vs-Quartus Cyclone IV hardware pitfalls.
// Runs in < 2 ms during compile and emits non-blocking [Quartus Hint] warnings.

function stripVhdlComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');
}

function parseVhdlInt(raw) {
  const clean = String(raw || '').replace(/_/g, '').trim();
  if (/^\d+$/.test(clean)) return BigInt(clean);
  return null;
}

export function lintVhdlHardwarePitfalls(sources) {
  const warnings = [];
  const seen = new Set();
  const pushWarn = msg => {
    if (seen.has(msg) || warnings.length >= 12) return;
    seen.add(msg);
    warnings.push(msg);
  };

  for (const src of sources || []) {
    const name = src?.name || 'design.vhd';
    if (!/\.(vhd|vhdl)$/i.test(name)) continue;
    const clean = stripVhdlComments(src.text || '');

    // 1. Collect sized unsigned / signed signal declarations + std_logic initializers
    const vecTypes = new Map(); // lowerName -> { name, signed, width }
    const scalarInits = new Map(); // lowerName -> { name, init }

    const sigDeclRe = /\bsignal\s+([a-z][a-z0-9_,\s]*?)\s*:\s*(unsigned|signed)\s*\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)/gi;
    let m;
    while ((m = sigDeclRe.exec(clean))) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const isSigned = m[2].toLowerCase() === 'signed';
      const a = Number(m[3]), b = Number(m[5]);
      const width = Math.abs(a - b) + 1;
      if (width > 0 && width <= 64) {
        for (const n of names) {
          vecTypes.set(n.toLowerCase(), { name: n, signed: isSigned, width });
        }
      }
    }

    const initRe = /\bsignal\s+([a-z][a-z0-9_,\s]*?)\s*:\s*std_logic\s*:=\s*'([01])'/gi;
    while ((m = initRe.exec(clean))) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const initVal = m[2];
      for (const n of names) {
        scalarInits.set(n.toLowerCase(), { name: n, init: initVal });
      }
    }

    // 2. Check out-of-range integer literal comparisons on unsigned/signed vectors
    for (const [key, info] of vecTypes.entries()) {
      const escaped = info.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cmpRe = new RegExp(`\\b${escaped}\\b\\s*(=|/=|<|<=|>|>=)\\s*(\\d[\\d_]*)\\b`, 'gi');
      let cm;
      while ((cm = cmpRe.exec(clean))) {
        const op = cm[1];
        const lit = parseVhdlInt(cm[2]);
        if (lit === null) continue;
        const maxVal = info.signed ? ((1n << BigInt(info.width - 1)) - 1n) : ((1n << BigInt(info.width)) - 1n);
        const minVal = info.signed ? -(1n << BigInt(info.width - 1)) : 0n;
        if (lit > maxVal) {
          pushWarn(
            `[Quartus Hint] ${name}: "${info.name}" is ${info.width}-bit ${info.signed ? 'signed' : 'unsigned'} (range ${minVal}..${maxVal}), so "${info.name} ${op} ${cm[2]}" compares against an out-of-range literal (always ${op === '/=' ? 'TRUE' : op === '=' ? 'FALSE' : 'constant'} on real Cyclone IV hardware).`
          );
        }
      }
    }

    // 3. Check async reset/preset power-up mismatch (Quartus Critical Warning 18010)
    // Match `process(clk, rst) ... if rst = '0' then <asyncBody> elsif rising_edge(clk)`
    const asyncProcRe = /\bprocess\s*\([^)]+\)[\s\S]*?\bbegin\b[\s\S]*?\bif\s+([a-z][a-z0-9_]*)\s*=\s*'[01]'\s+then([\s\S]*?)\belsif\s+(?:rising_edge|falling_edge)\s*\(/gi;
    while ((m = asyncProcRe.exec(clean))) {
      const asyncBody = m[2] || '';
      const assignRe = /\b([a-z][a-z0-9_]*)\s*<=\s*'([01])'\s*;/gi;
      let am;
      while ((am = assignRe.exec(asyncBody))) {
        const sigKey = am[1].toLowerCase();
        const rstVal = am[2];
        const decl = scalarInits.get(sigKey);
        if (decl && decl.init !== rstVal) {
          pushWarn(
            `[Quartus Hint] ${name}: "${decl.name}" initializes to '${decl.init}' but async reset/set drives '${rstVal}' — Cyclone IV registers power up to their async preset/clear state (Quartus Warning 18010).`
          );
        }
      }
    }
  }

  return warnings;
}

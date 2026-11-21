// Lightweight in-browser code editor: line gutter, VHDL syntax highlighting, auto-indent,
// comment toggling, line moving and diagnostic markers. No external dependencies (the app loads no remote resources).

const KEYWORDS = new Set(('abs access after alias all and architecture array assert assume assume_guarantee attribute begin block body buffer bus case component ' +
  'configuration constant context cover default disconnect downto else elsif end entity exit fairness file for force function generate generic group guarded if ' +
  'impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package parameter port postponed ' +
  'procedure process property protected pure range record register reject release rem report restrict restrict_guarantee return rol ror select sequence severity ' +
  'shared signal sla sll sra srl strong subtype then to transport type unaffected units until use variable vmode vprop vunit wait when while with xnor xor').split(/\s+/));
const TYPES = new Set(('std_logic std_logic_vector std_ulogic std_ulogic_vector bit bit_vector boolean integer natural positive real time character string unsigned signed ' +
  'severity_level file_open_kind line text side width delay_length ieee std work numeric_std std_logic_1164 textio').split(/\s+/));
const TOKEN = /(--[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\n]|"")*"?)|(\b[xXbBoO]"[0-9a-fA-F_uUxXzZwWlLhH-]*")|((?<![\w)])'[^'\n]')|(\b\d+#[0-9a-fA-F_.]+#(?:[eE][+-]?\d+)?|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([A-Za-z][A-Za-z0-9_]*)/g;
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightVhdl(text) {
  let out = '', last = 0, match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text))) {
    const token = match[0];
    if (!token.length) { TOKEN.lastIndex++; continue; }
    if (match.index > last) out += esc(text.slice(last, match.index));
    let cls = null;
    if (match[1] || match[2]) cls = 'cm';
    else if (match[3] || match[4] || match[5]) cls = 'st';
    else if (match[6]) cls = 'nu';
    else if (match[7]) { const word = token.toLowerCase(); cls = KEYWORDS.has(word) ? 'kw' : TYPES.has(word) ? 'ty' : null; }
    out += cls ? `<span class="tk-${cls}">${esc(token)}</span>` : esc(token);
    last = match.index + token.length;
  }
  return out + esc(text.slice(last));
}

const LINE_HEIGHT = 20, PAD_TOP = 10;
const INDENT_AFTER = /(\b(is|begin|then|else|loop|generate|record|units)|\(|\b(port|generic)(\s+map)?\s*\()$/i;

export class CodeEditor {
  constructor(host, callbacks = {}) {
    this.callbacks = callbacks;
    this.markers = [];
    this.root = document.createElement('div');
    this.root.className = 'ce';
    this.root.innerHTML = '<div class="ce-gutter" aria-hidden="true"><div class="ce-gutter-in"><pre class="ce-nums"></pre></div></div>' +
      '<div class="ce-view"><textarea class="ce-input ce-text" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="VHDL source code"></textarea>' +
      '<div class="ce-layer" aria-hidden="true"><div class="ce-lines"></div><pre class="ce-hl ce-text"></pre></div></div>';
    host.append(this.root);
    this.gutter = this.root.querySelector('.ce-gutter');
    this.gutterIn = this.root.querySelector('.ce-gutter-in');
    this.nums = this.root.querySelector('.ce-nums');
    this.layer = this.root.querySelector('.ce-layer');
    this.lines = this.root.querySelector('.ce-lines');
    this.pre = this.root.querySelector('.ce-hl');
    this.input = this.root.querySelector('.ce-input');
    this.curLine = document.createElement('div');
    this.curLine.className = 'ce-curline';
    this.lineCount = 0;
    this.input.addEventListener('input', () => { this.schedule(); this.callbacks.onChange?.(this.input.value); });
    this.input.addEventListener('scroll', () => this.syncScroll());
    this.input.addEventListener('keydown', event => this.onKeyDown(event));
    for (const type of ['keyup', 'click', 'focus', 'select']) this.input.addEventListener(type, () => this.reportCursor());
    this.input.addEventListener('blur', () => this.curLine.classList.add('off'));
    this.input.addEventListener('focus', () => this.curLine.classList.remove('off'));
  }
  get value() { return this.input.value; }
  setValue(text) { this.input.value = text; this.renderNow(); this.reportCursor(); }
  show(visible) { this.root.classList.toggle('active', visible); if (visible) { this.syncScroll(); this.reportCursor(); } }
  focus() { this.input.focus({ preventScroll: true }); }
  schedule() { if (this.frame) return; this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderNow(); this.reportCursor(); }); }
  renderNow() {
    const text = this.input.value;
    this.pre.innerHTML = highlightVhdl(text) + '\n';
    const count = text.split('\n').length;
    if (count !== this.lineCount) {
      this.lineCount = count;
      let numbers = '';
      for (let i = 1; i <= count; i++) numbers += i + '\n';
      this.nums.textContent = numbers;
      this.gutter.style.width = `${Math.max(3, String(count).length) + 2.2}ch`;
    }
    this.renderMarkers();
  }
  syncScroll() {
    this.layer.style.transform = `translate(${-this.input.scrollLeft}px, ${-this.input.scrollTop}px)`;
    this.gutterIn.style.transform = `translateY(${-this.input.scrollTop}px)`;
  }
  cursor() {
    const value = this.input.value, pos = this.input.selectionStart;
    const before = value.slice(0, pos), line = before.split('\n').length;
    return { line, col: pos - before.lastIndexOf('\n'), lines: this.lineCount || value.split('\n').length, selected: this.input.selectionEnd - pos };
  }
  reportCursor() {
    if (!this.root.classList.contains('active')) return;
    const info = this.cursor();
    if (info.selected) this.curLine.remove();
    else { this.curLine.style.top = `${PAD_TOP + (info.line - 1) * LINE_HEIGHT}px`; if (!this.curLine.isConnected) this.lines.prepend(this.curLine); }
    this.callbacks.onCursor?.(info);
  }
  setMarkers(markers) { this.markers = markers || []; this.renderMarkers(); }
  renderMarkers() {
    this.lines.replaceChildren(...(this.curLine.isConnected ? [this.curLine] : []));
    this.gutterIn.querySelectorAll('.gm').forEach(node => node.remove());
    const seen = new Map();
    for (const marker of this.markers) {
      const rank = marker.severity === 'error' ? 2 : 1;
      if ((seen.get(marker.line)?.rank ?? 0) >= rank) continue;
      seen.set(marker.line, { rank, marker });
    }
    for (const [line, { marker }] of seen) {
      const top = PAD_TOP + (line - 1) * LINE_HEIGHT;
      const bar = document.createElement('div'); bar.className = `ce-linehl ${marker.severity}`; bar.style.top = `${top}px`; this.lines.append(bar);
      const dot = document.createElement('div'); dot.className = `gm ${marker.severity}`; dot.style.top = `${top}px`; dot.title = marker.message || ''; dot.textContent = marker.severity === 'error' ? '●' : '▲'; this.gutterIn.append(dot);
    }
  }
  goto(line, col = 1) {
    const rows = this.input.value.split('\n');
    line = Math.min(Math.max(1, line), rows.length);
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += rows[i].length + 1;
    offset += Math.min(Math.max(0, col - 1), rows[line - 1].length);
    this.focus();
    this.input.setSelectionRange(offset, offset);
    const top = PAD_TOP + (line - 1) * LINE_HEIGHT;
    if (top < this.input.scrollTop + 20 || top > this.input.scrollTop + this.input.clientHeight - 60) this.input.scrollTop = Math.max(0, top - this.input.clientHeight / 2);
    this.syncScroll(); this.reportCursor();
  }
  insert(text, start = this.input.selectionStart, end = this.input.selectionEnd) {
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      this.input.setRangeText(text, start, end, 'end');
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  blockRange() {
    const value = this.input.value, start = this.input.selectionStart;
    let end = this.input.selectionEnd;
    if (end > start && value[end - 1] === '\n') end--;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to < 0) to = value.length;
    return { from, to, text: value.slice(from, to) };
  }
  replaceBlock(from, to, text) { this.insert(text, from, to); this.input.setSelectionRange(from, from + text.length); this.reportCursor(); }
  onKeyDown(event) {
    const mod = event.ctrlKey || event.metaKey, key = event.key;
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 's') { event.preventDefault(); this.callbacks.onSave?.(); return; }
    if (mod && key === '/') { event.preventDefault(); this.toggleComment(); return; }
    if (key === 'Tab' && !mod && !event.altKey) { event.preventDefault(); if (event.shiftKey) this.outdent(); else this.indent(); return; }
    if (key === 'Enter' && !mod && !event.shiftKey && !event.altKey) { event.preventDefault(); this.newline(); return; }
    if (event.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) { event.preventDefault(); this.moveLines(key === 'ArrowUp' ? -1 : 1); }
  }
  indent() {
    const { selectionStart: start, selectionEnd: end, value } = this.input;
    if (start === end || !value.slice(start, end).includes('\n')) {
      const col = start - (value.lastIndexOf('\n', start - 1) + 1);
      this.insert(' '.repeat(2 - (col % 2)));
      return;
    }
    const block = this.blockRange();
    this.replaceBlock(block.from, block.to, block.text.split('\n').map(line => '  ' + line).join('\n'));
  }
  outdent() {
    const block = this.blockRange();
    const text = block.text.split('\n').map(line => line.replace(/^( {1,2}|\t)/, '')).join('\n');
    if (text !== block.text) this.replaceBlock(block.from, block.to, text);
  }
  toggleComment() {
    const block = this.blockRange(), rows = block.text.split('\n');
    const code = rows.filter(row => row.trim());
    const allCommented = code.length > 0 && code.every(row => /^\s*--/.test(row));
    const indent = Math.min(...code.map(row => row.match(/^\s*/)[0].length), Infinity);
    const next = rows.map(row => {
      if (!row.trim()) return row;
      if (allCommented) return row.replace(/^(\s*)-- ?/, '$1');
      return row.slice(0, indent) + '-- ' + row.slice(indent);
    });
    this.replaceBlock(block.from, block.to, next.join('\n'));
  }
  newline() {
    const { selectionStart: start, value } = this.input;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1, before = value.slice(lineStart, start);
    const indent = before.match(/^[ \t]*/)[0];
    const code = before.replace(/--.*$/, '').trim();
    const extra = INDENT_AFTER.test(code) && !/^end\b/i.test(code) ? '  ' : '';
    this.insert('\n' + indent + extra);
  }
  moveLines(direction) {
    const value = this.input.value, block = this.blockRange();
    if (direction < 0 && block.from === 0) return;
    if (direction > 0 && block.to >= value.length) return;
    if (direction < 0) {
      const prevStart = value.lastIndexOf('\n', block.from - 2) + 1, prev = value.slice(prevStart, block.from - 1);
      this.insert(block.text + '\n' + prev, prevStart, block.to);
      this.input.setSelectionRange(prevStart, prevStart + block.text.length);
    } else {
      let nextEnd = value.indexOf('\n', block.to + 1); if (nextEnd < 0) nextEnd = value.length;
      const next = value.slice(block.to + 1, nextEnd), from = block.from + next.length + 1;
      this.insert(next + '\n' + block.text, block.from, nextEnd);
      this.input.setSelectionRange(from, from + block.text.length);
    }
    this.reportCursor();
  }
  dispose() { cancelAnimationFrame(this.frame); this.root.remove(); }
}

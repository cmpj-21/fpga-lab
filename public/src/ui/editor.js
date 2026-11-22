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

const QSF_COMMANDS = new Set([
  'set_global_assignment', 'set_location_assignment', 'set_instance_assignment',
  'set_parameter', 'project_new', 'project_open', 'project_close', 'export_assignments',
  'quartus_version', 'project_revision', 'date',
]);
const QSF_KEYS = new Set([
  'family', 'device', 'top_level_entity', 'vhdl_file', 'verilog_file', 'vhdl_input_version',
  'project_output_directory', 'min_core_junction_temp', 'max_core_junction_temp',
  'error_check_frequency_divisor', 'nominal_core_supply_voltage', 'eda_simulation_tool',
  'eda_output_data_format', 'power_preserves_high_speed_tiles', 'partition_netlist_type',
  'partition_fit_attempt_hierarchy', 'partition_color', 'io_standard', 'current_strength_new',
  'slew_rate', 'weak_pull_up_resistor', 'sdc_file', 'qip_file', 'bdf_file', 'source_file',
]);
const QSF_TOKEN = /(#[^\n]*)|("(?:[^"\n\\]|\\.)*"?|'(?:[^'\n\\]|\\.)*'?|\{[^}\n]*\}?)|(-[A-Za-z_][A-Za-z0-9_-]*)|(\bPIN_\d+\b|\bEP4CE\w+\b|\bVHDL_(?:1993|2002|2008)\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

export function highlightQsf(text) {
  let out = '', last = 0, match;
  QSF_TOKEN.lastIndex = 0;
  while ((match = QSF_TOKEN.exec(text))) {
    const token = match[0];
    if (!token.length) { QSF_TOKEN.lastIndex++; continue; }
    if (match.index > last) out += esc(text.slice(last, match.index));
    let cls = null;
    if (match[1]) cls = 'cm';
    else if (match[2]) cls = 'st';
    else if (match[3]) cls = 'ty';
    else if (match[4]) cls = 'nu';
    else if (match[5]) {
      const low = token.toLowerCase();
      if (QSF_COMMANDS.has(low)) cls = 'kw';
      else if (QSF_KEYS.has(low)) cls = 'ty';
    }
    out += cls ? `<span class="tk-${cls}">${esc(token)}</span>` : esc(token);
    last = match.index + token.length;
  }
  return out + esc(text.slice(last));
}

const MD_TOKEN = /(```[\s\S]*?(?:```|$))|(`[^`\n]+`)|(^[ \t]*#{1,6}[ \t]+[^\n]*)|(^[ \t]*>[ \t]?.+$)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\[[^\]\n]+\]\([^)\n]+\))|(^[ \t]*(?:[-*+]|\d+\.)[ \t]+)/gm;

export function highlightMarkdown(text) {
  let out = '', last = 0, match;
  MD_TOKEN.lastIndex = 0;
  while ((match = MD_TOKEN.exec(text))) {
    const token = match[0];
    if (!token.length) { MD_TOKEN.lastIndex++; continue; }
    if (match.index > last) out += esc(text.slice(last, match.index));
    let cls = null;
    if (match[1] || match[2]) cls = 'st';
    else if (match[3]) cls = 'kw';
    else if (match[4]) cls = 'cm';
    else if (match[5] || match[7]) cls = 'ty';
    else if (match[6]) cls = 'nu';
    out += cls ? `<span class="tk-${cls}">${esc(token)}</span>` : esc(token);
    last = match.index + token.length;
  }
  return out + esc(text.slice(last));
}

function formatInlineMarkdown(raw) {
  let s = esc(raw);
  s = s.replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|#[a-z0-9_-]+)\)/gi, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

export function renderMarkdownHtml(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```([a-z0-9_-]*)\s*$/i);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const codeText = buf.join('\n');
      const highlighted = lang === 'vhdl' || lang === 'vhd'
        ? highlightVhdl(codeText)
        : (lang === 'qsf' || lang === 'qpf' || lang === 'tcl')
          ? highlightQsf(codeText)
          : esc(codeText);
      html.push(`<div class="md-code-block">${lang ? `<div class="md-code-lang mono">${esc(lang)}</div>` : ''}<pre class="mono"><code>${highlighted}</code></pre></div>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const slug = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      html.push(`<h${level} id="${esc(slug)}">${formatInlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const parseRow = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => formatInlineMarkdown(c.trim()));
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      html.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote class="md-quote">${qLines.map(formatInlineMarkdown).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
        let itemText = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
        const task = itemText.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          items.push(`<li class="md-task"><input type="checkbox" disabled ${checked ? 'checked' : ''}><span>${formatInlineMarkdown(task[2])}</span></li>`);
        } else {
          items.push(`<li>${formatInlineMarkdown(itemText)}</li>`);
        }
        i++;
      }
      html.push(`<${tag} class="md-list">${items.join('')}</${tag}>`);
      continue;
    }
    const pLines = [];
    while (i < lines.length && lines[i].trim() && !/^(?:```|#{1,6}\s|>\s?|(?:---|\*\*\*|___)\s*$|\s*(?:[-*+]|\d+\.)\s+)/.test(lines[i])) {
      pLines.push(formatInlineMarkdown(lines[i]));
      i++;
    }
    html.push(`<p>${pLines.join(' ')}</p>`);
  }
  return html.join('\n');
}

const LINE_HEIGHT = 20, PAD_TOP = 10;
const INDENT_AFTER = /(\b(is|begin|then|else|loop|generate|record|units)|\(|\b(port|generic)(\s+map)?\s*\()$/i;

export class CodeEditor {
  constructor(host, callbacks = {}) {
    this.callbacks = callbacks;
    this.language = callbacks.language || 'vhdl';
    this.wordWrap = !!callbacks.wordWrap;
    this.markers = [];
    this.root = document.createElement('div');
    this.root.className = `ce${this.wordWrap ? ' wrap-on' : ''}`;
    this.root.innerHTML = '<div class="ce-gutter" aria-hidden="true"><div class="ce-gutter-in"><pre class="ce-nums"></pre></div></div>' +
      `<div class="ce-view"><textarea class="ce-input ce-text" spellcheck="false" wrap="${this.wordWrap ? 'soft' : 'off'}" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="Source code editor"></textarea>` +
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
  setLanguage(lang = 'vhdl') { this.language = lang; this.renderNow(); }
  setWordWrap(enabled) {
    this.wordWrap = !!enabled;
    this.root.classList.toggle('wrap-on', this.wordWrap);
    this.input.setAttribute('wrap', this.wordWrap ? 'soft' : 'off');
    if (this.wordWrap) this.input.scrollLeft = 0;
    this.syncScroll();
    this.reportCursor();
  }
  toggleWordWrap() {
    this.setWordWrap(!this.wordWrap);
    return this.wordWrap;
  }
  highlightText(text) {
    if (this.language === 'vhdl') return highlightVhdl(text);
    if (this.language === 'qsf') return highlightQsf(text);
    if (this.language === 'markdown') return highlightMarkdown(text);
    return esc(text);
  }
  renderNow() {
    const text = this.input.value;
    this.pre.innerHTML = this.highlightText(text) + '\n';
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
    const x = this.wordWrap ? 0 : -this.input.scrollLeft;
    this.layer.style.transform = `translate(${x}px, ${-this.input.scrollTop}px)`;
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
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); this.callbacks.onSave?.(); return; }
    if (!mod && event.altKey && !event.shiftKey && key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); if (this.callbacks.onToggleWrap) this.callbacks.onToggleWrap(); else this.toggleWordWrap(); return; }
    if (mod && !event.altKey && key === '/') { event.preventDefault(); this.toggleComment(); return; }
    if (mod && event.shiftKey && !event.altKey && key.toLowerCase() === 'k') { event.preventDefault(); this.deleteLines(); return; }
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'l') { event.preventDefault(); this.selectLine(); return; }
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'd') { event.preventDefault(); this.selectWord(); return; }
    if (mod && !event.altKey && key === 'Enter') { event.preventDefault(); this.insertLineAround(event.shiftKey ? -1 : 1); return; }
    if (key === 'Tab' && !mod && !event.altKey) { event.preventDefault(); if (event.shiftKey) this.outdent(); else this.indent(); return; }
    if (key === 'Enter' && !mod && !event.shiftKey && !event.altKey) { event.preventDefault(); this.newline(); return; }
    if (event.altKey && event.shiftKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) { event.preventDefault(); this.duplicateLines(key === 'ArrowUp' ? -1 : 1); return; }
    if (event.altKey && !event.shiftKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) { event.preventDefault(); this.moveLines(key === 'ArrowUp' ? -1 : 1); }
  }
  duplicateLines(direction = 1) {
    const block = this.blockRange();
    const replacement = block.text + '\n' + block.text;
    this.insert(replacement, block.from, block.to);
    if (direction < 0) {
      this.input.setSelectionRange(block.from, block.from + block.text.length);
    } else {
      const secondStart = block.from + block.text.length + 1;
      this.input.setSelectionRange(secondStart, secondStart + block.text.length);
    }
    this.reportCursor();
  }
  deleteLines() {
    const value = this.input.value;
    const block = this.blockRange();
    let from = block.from, to = block.to;
    if (to < value.length && value[to] === '\n') to++;
    else if (from > 0 && value[from - 1] === '\n') from--;
    this.insert('', from, to);
    const pos = Math.min(from, this.input.value.length);
    this.input.setSelectionRange(pos, pos);
    this.reportCursor();
  }
  selectLine() {
    const value = this.input.value;
    const block = this.blockRange();
    const to = block.to < value.length && value[block.to] === '\n' ? block.to + 1 : block.to;
    this.input.setSelectionRange(block.from, to);
    this.reportCursor();
  }
  selectWord() {
    const value = this.input.value;
    const pos = this.input.selectionStart;
    if (this.input.selectionStart !== this.input.selectionEnd) {
      const selected = value.slice(this.input.selectionStart, this.input.selectionEnd);
      if (selected && !/\n/.test(selected)) {
        const nextIdx = value.indexOf(selected, this.input.selectionEnd);
        const wrapIdx = nextIdx >= 0 ? nextIdx : value.indexOf(selected, 0);
        if (wrapIdx >= 0) {
          this.input.setSelectionRange(wrapIdx, wrapIdx + selected.length);
          this.reportCursor();
          return;
        }
      }
    }
    let start = pos, end = pos;
    while (start > 0 && /\w/.test(value[start - 1])) start--;
    while (end < value.length && /\w/.test(value[end])) end++;
    if (end > start) {
      this.input.setSelectionRange(start, end);
      this.reportCursor();
    }
  }
  insertLineAround(dir = 1) {
    const block = this.blockRange();
    const indent = (block.text.match(/^[ \t]*/) || [''])[0];
    if (dir < 0) {
      this.insert(indent + '\n', block.from, block.from);
      this.input.setSelectionRange(block.from + indent.length, block.from + indent.length);
    } else {
      this.insert('\n' + indent, block.to, block.to);
      const pos = block.to + 1 + indent.length;
      this.input.setSelectionRange(pos, pos);
    }
    this.reportCursor();
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
    const prefix = this.language === 'vhdl' ? '--' : '#';
    const reTest = this.language === 'vhdl' ? /^\s*--/ : /^\s*#/;
    const reStrip = this.language === 'vhdl' ? /^(\s*)-- ?/ : /^(\s*)# ?/;
    const block = this.blockRange(), rows = block.text.split('\n');
    const code = rows.filter(row => row.trim());
    const allCommented = code.length > 0 && code.every(row => reTest.test(row));
    const indent = Math.min(...code.map(row => row.match(/^\s*/)[0].length), Infinity);
    const next = rows.map(row => {
      if (!row.trim()) return row;
      if (allCommented) return row.replace(reStrip, '$1');
      return row.slice(0, indent) + prefix + ' ' + row.slice(indent);
    });
    this.replaceBlock(block.from, block.to, next.join('\n'));
  }
  newline() {
    const { selectionStart: start, value } = this.input;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1, before = value.slice(lineStart, start);
    const indent = before.match(/^[ \t]*/)[0];
    const code = before.replace(/--.*$/, '').trim();
    const extra = this.language === 'vhdl' && INDENT_AFTER.test(code) && !/^end\b/i.test(code) ? '  ' : '';
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

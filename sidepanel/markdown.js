// Small Markdown renderer for model output: headings, lists, paragraphs,
// bold/italic/code, and timestamps turned into seek buttons. List items that
// start with a timestamp become clickable "moments".
// Input is escaped first, so the result is safe to assign to innerHTML.

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const parseTimestamp = (text) => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);

const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:[0-5]\d`;
// [1:23], (1:23), ranges such as [1:23–2:05], and links such as [1:23](https://…)
const BRACKETED_TS = new RegExp(String.raw`[\[(](${TS}(?:\s*[-–—]\s*${TS})?)[\])](?:\([^)\s]*\))?`, 'g');
// Lines that open with a bare timestamp: "1:23 — …", "**1:23** …", "**1:23 Headline**"
const LEADING_TS = new RegExp(String.raw`^(\*\*)?(${TS})\1(?:\s*[-–—:]\s+|\s+|$)`);
const LEADING_BOLD_TS = new RegExp(String.raw`^\*\*(${TS})(?:\s*[-–—:])?\s+`);
const STARTS_WITH_TS = new RegExp(String.raw`^\*{0,2}[\[(]?${TS}`);

const tsButton = (ts) =>
  `<button type="button" class="ts" data-seconds="${parseTimestamp(ts)}" title="Jump to ${ts}">${ts}</button>`;

function formatInline(text) {
  return escapeHtml(text)
    .replace(BRACKETED_TS, (_, inner) => inner.replace(new RegExp(TS, 'g'), tsButton))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>');
}

function inline(text) {
  return text
    .replace(LEADING_TS, '[$2] ')
    .replace(LEADING_BOLD_TS, '[$1] **')
    .split(/`([^`]+)`/) // odd-numbered parts are inside backticks
    .map((part, i) => (i % 2 ? `<code>${escapeHtml(part)}</code>` : formatInline(part)))
    .join('');
}

function listItem(text) {
  const html = inline(text);
  const moment = html.match(/^(?:<strong>)?<button type="button" class="ts" data-seconds="(\d+)"/);
  return moment ? `<li class="moment" data-seconds="${moment[1]}">${html}</li>` : `<li>${html}</li>`;
}

export function renderMarkdown(markdown) {
  const out = [];
  let paragraph = [];
  let list = null; // { tag, items: string[] }
  let sectionOpen = false;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(listItem).join('')}</${list.tag}>`);
    list = null;
  };
  const openSection = () => {
    if (sectionOpen) out.push('</section>');
    out.push('<section>');
    sectionOpen = true;
  };
  const addItem = (tag, text) => {
    flushParagraph();
    if (list?.tag !== tag) flushList();
    if (!sectionOpen) openSection();
    list ??= { tag, items: [] };
    list.items.push(text);
  };

  for (const rawLine of markdown.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    let m;
    if (!line) {
      flushParagraph();
      flushList();
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushParagraph();
      flushList();
      if (m[1].length <= 2) {
        openSection();
        out.push(`<h2>${inline(m[2])}</h2>`);
      } else {
        if (!sectionOpen) openSection();
        out.push(`<h3>${inline(m[2])}</h3>`);
      }
    } else if ((m = line.match(/^(?:([-*•])|(\d+)[.)])\s+(.*)$/))) {
      addItem(m[1] ? 'ul' : 'ol', m[3]);
    } else if (list && /^\s+/.test(rawLine)) {
      // Indented continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line}`;
    } else if (STARTS_WITH_TS.test(line)) {
      // Highlights written as lines instead of bullets.
      addItem('ul', line);
    } else {
      flushList();
      if (!sectionOpen) openSection();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  if (sectionOpen) out.push('</section>');
  return out.join('');
}

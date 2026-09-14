/* ============================================================================
   BINDERS — scripts.js  (client only, vanilla, no build step, no dependencies)

   The whole product is here because the whole product is the client: the
   server's job would only ever be sync and sharing (spec 22). This file owns
   the document, parsing, rendering, search, navigation, tags, collapsing,
   persistence, export and printing.

   Sections are marked with banner comments and communicate only through the
   small surfaces named at each banner — so any of them can become its own
   module file later without rewiring the rest.

   01. UTILITIES
   02. STORE            — persistence + Binder records
   03. PARSER           — text -> sheets, tags, mentions, quotes, reminders
   04. RENDERER         — parsed text -> HTML
   05. ROUTER           — hash URLs, deep links to sheets
   06. VIEW: SHELF      — the list of Binders
   07. VIEW: BINDER     — reading representation (index, spine, expansion)
   08. TAGS             — the horizontal dimension
   09. EDITING          — the sheet on screen is the one being written
   10. PALETTE          — find / ask / speak
   11. ANSWERS          — local retrieval over your own text
   12. REMINDERS        — time attached to text
   13. NOTIFICATIONS    — only when there is something to say
   14. EXPORT & PRINT   — portable HTML, native print
   15. MENU
   16. KEYBOARD
   17. TOUCH
   18. BOOT             — seeds "What's Txtr?" on the very first run
   ========================================================================= */


/* == 01. UTILITIES ======================================================== */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'sheet';

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** "3 minutes ago", "yesterday", "12 Mar" — short, human, no library. */
function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 172800) return 'yesterday';
  if (d < 604800) return Math.floor(d / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function clockLabel(date) {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 864e5).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'today ' + time;
  if (tomorrow) return 'tomorrow ' + time;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + time;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/**
 * A destructive action that already happened, with a way out of it: the
 * toast says what was done and offers a few seconds to undo it instead of
 * asking first — deleting is common enough that a confirm dialog in front
 * of every one of them would be the interruption, not the safety.
 */
function toastUndo(msg, onUndo, ms = 6000) {
  const t = $('#toast');
  clearTimeout(toast._t);
  t.textContent = msg + ' ';
  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.type = 'button';
  btn.textContent = 'Undo';
  t.appendChild(btn);
  t.hidden = false;
  const close = () => { t.hidden = true; };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(toast._t);
    close();
    onUndo();
  });
  toast._t = setTimeout(close, ms);
}


/* == 02. STORE ============================================================
   Local first, and local only: the client owns the document (spec 22). One
   localStorage record holds every Binder plus the little state the interface
   needs to remember. Surface: DB, saveDB(), getBinder(), newBinder(), ...    */

const DB_KEY = 'binders.v2';

let DB = {
  identity: 'Felipe',      // who "me" is, for @mentions
  binders: [],             // [{ id, title, text, created, updated }]
  seen: 0,                 // timestamp of the last notification check
  fired: {},               // reminder keys already notified
};

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) DB = Object.assign(DB, JSON.parse(raw));
  } catch (e) {
    console.warn('Txtr: local data could not be read, starting fresh.', e);
  }
}

const saveDB = debounce(() => {
  try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); }
  catch (e) { toast('Local storage is full — export this Binder'); }
}, 250);

const getBinder = (id) => DB.binders.find((b) => b.id === id);

function newBinder(title = 'Untitled', text = '') {
  const b = { id: uid(), title, text, created: Date.now(), updated: Date.now() };
  DB.binders.unshift(b);
  saveDB();
  return b;
}

function writeBinder(b, text) {
  if (text === b.text) return;       // nothing changed, nothing to undo either
  pushHistory(b);
  b.text = text;
  b.updated = Date.now();
  saveDB();
}

function deleteBinder(id) {
  DB.binders = DB.binders.filter((b) => b.id !== id);
  History.delete(id);
  saveDB();
}


/* == 02b. UNDO / REDO =====================================================
   The document is just text (spec 2), so undo is just text too: one stack
   per Binder, of what writeBinder saw right before it overwrote it. Typing,
   creating a sheet, deleting one, tagging — every edit goes through that one
   function, so Cmd+Z undoes all of them the same way, not just typing (which
   is all the browser's own undo, bypassed by the custom key handling below,
   would ever have known about). Surface: undo(), redo().                   */

const History = new Map();          // binder id -> { undo: [text...], redo: [text...] }
const HISTORY_LIMIT = 200;

function historyFor(id) {
  let h = History.get(id);
  if (!h) { h = { undo: [], redo: [] }; History.set(id, h); }
  return h;
}

function pushHistory(b) {
  const h = historyFor(b.id);
  h.undo.push(b.text);
  if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
  h.redo.length = 0;
}

/** Write a history-stack entry back without it becoming one more entry. */
function applyHistory(b, text) {
  b.text = text;
  b.updated = Date.now();
  saveDB();
  if (App.binderId !== b.id) return;   // undone in the background — nothing on screen to refresh

  const openSlug = App.open;
  App.open = null;
  App.doc = parse(b.text);
  App.col = Math.min(App.col, App.doc.tags.length);
  renderBinder();
  renderChrome();
  scheduleReminders();
  refreshBell();

  const reopen = openSlug && App.doc.sheets.find((c) => c.slug === openSlug);
  if (reopen) expand(reopen.slug, { scroll: true });
  else {
    const li = visible()[0];
    if (li) setCursor(0, { scroll: true });
  }
}

function undo() {
  const b = getBinder(App.binderId);
  if (!b) return;
  if ($('.sheet.is-open')) writeOpenSheet();   // commit whatever is mid-keystroke first
  const h = historyFor(b.id);
  if (!h.undo.length) return toast('Nothing to undo');
  h.redo.push(b.text);
  applyHistory(b, h.undo.pop());
}

function redo() {
  const b = getBinder(App.binderId);
  if (!b) return;
  if ($('.sheet.is-open')) writeOpenSheet();
  const h = historyFor(b.id);
  if (!h.redo.length) return toast('Nothing to redo');
  h.undo.push(b.text);
  applyHistory(b, h.redo.pop());
}


/* == 03. PARSER ===========================================================
   One document in, one shape out. Everything the product knows how to do is
   derived from the text — there are no sheet records, no tag table, no status
   field (spec 2, 4, 9). Surface: parse(text).

   The rules, all of them:
     "# Title"   at line start   -> a new sheet         (## too)
     "### Sub"   at line start   -> a heading inside the current sheet
     "#tag"      inline          -> a tag on that sheet
     "@name"     inline          -> a mention
     "> text"    at line start   -> a quoted passage
     "— text"    after a quote   -> a reply to it
     "!" line                    -> a reminder
     "- [ ]"                     -> a task
   Anything else is just text, which is the point.                           */

const RE_SHEET    = /^(#{1,2})\s+(.*)$/;
const RE_SUB     = /^(#{3,6})\s+(.*)$/;
const RE_TAG     = /(^|[\s(])#([\p{L}][\p{L}\p{N}_-]*)/gu;
const RE_MENTION = /(^|[\s(])@([\p{L}][\p{L}\p{N}._-]*)/gu;
const RE_REMIND  = /^!\s*(?:remind(?:er)?\s*)?(.+)$/i;

function collect(re, text, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) if (!out.includes(m[2])) out.push(m[2]);
}

function parse(text) {
  const lines = String(text || '').split('\n');
  const sheets = [];
  const lead = [];
  const slugs = new Set();
  let sheet = null;

  const open = (level, raw, lineNo) => {
    // A sheet carries one tag, written on its title line and not part of its
    // name. One tag means a sheet sits in exactly one column.
    const tags = [];
    collect(RE_TAG, raw, tags);
    // "Untitled" is what an unnamed sheet is called, not what it says: the
    // heading really is empty, and the editable title has to stay empty too.
    const written = raw.replace(RE_TAG, '$1').replace(/\s+/g, ' ').trim();
    const title = written || 'Untitled';

    let slug = slugify(title), n = 2;
    while (slugs.has(slug)) slug = slugify(title) + '-' + n++;
    slugs.add(slug);

    sheet = {
      level, title, slug, named: !!written, tag: tags[0] || null,
      mentions: [], reminders: [], lines: [], line: lineNo,
    };
    collect(RE_MENTION, raw, sheet.mentions);
    sheets.push(sheet);
  };

  // Fenced code is quoted verbatim: a "# heading" inside it is an example of
  // a heading, not a new sheet. Pasted Markdown depends on this.
  let fenced = false;

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : RE_SHEET.exec(line);
    if (m) { open(m[1].length, m[2], i); return; }
    if (!sheet) { lead.push(line); return; }

    sheet.lines.push(line);
    collect(RE_MENTION, line, sheet.mentions);

    const r = RE_REMIND.exec(line.trim());
    if (r) {
      const when = parseWhen(r[1]);
      if (when) sheet.reminders.push(when);
    }
  });

  // Tag order is order of appearance in the document. No sorting, no config:
  // the columns are however the writer wrote them (spec 9).
  const tags = [];
  sheets.forEach((c) => { if (c.tag && !tags.includes(c.tag)) tags.push(c.tag); });

  return { lead, sheets, tags, text: String(text || '') };
}

/** "tomorrow 10:00 Call João" -> { at, label, text }. Small on purpose. */
function parseWhen(str) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let s = str.trim();
  const now = new Date();
  const at = new Date(now);
  at.setSeconds(0, 0);
  let matched = false;

  const iso = /^(\d{4})-(\d{2})-(\d{2})\s*/.exec(s);
  const word = /^(today|tonight|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*/i.exec(s);

  if (iso) {
    at.setFullYear(+iso[1], +iso[2] - 1, +iso[3]);
    s = s.slice(iso[0].length); matched = true;
  } else if (word) {
    const w = word[1].toLowerCase();
    if (w === 'tomorrow') at.setDate(at.getDate() + 1);
    else if (w === 'next week') at.setDate(at.getDate() + 7);
    else if (w === 'tonight') at.setHours(20, 0);
    else if (days.includes(w)) {
      const delta = (days.indexOf(w) - at.getDay() + 7) % 7 || 7;
      at.setDate(at.getDate() + delta);
    }
    s = s.slice(word[0].length); matched = true;
  }

  const time = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*/i.exec(s);
  if (time) {
    let h = +time[1];
    if (/pm/i.test(time[3] || '') && h < 12) h += 12;
    if (/am/i.test(time[3] || '') && h === 12) h = 0;
    at.setHours(h, +(time[2] || 0));
    s = s.slice(time[0].length); matched = true;
  }

  if (!matched) return null;
  s = s.replace(/^(to|–|—|-|:)\s*/i, '').trim();
  return { at: at.getTime(), label: clockLabel(at), text: s };
}


/* == 04. RENDERER =========================================================
   Parsed text -> HTML, using ordinary HTML semantics so the same markup is a
   sheet, a heading, a print section and a URL target (spec 6).
   Surface: inline(str), renderBody(sheet).                                   */

/* Sentinel used to park code spans while the other inline rules run. */
const PARK = String.fromCharCode(0);

/** Inline text: emphasis, code, links, images, tags, mentions. */
function inline(str) {
  let s = esc(str);

  // Code spans are parked first so nothing else rewrites their contents.
  const parked = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    parked.push('<code>' + c + '</code>');
    return PARK + (parked.length - 1) + PARK;
  });

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  s = s.replace(RE_TAG, (_, pre, tag) =>
    pre + '<span class="tagref" data-tag="' + tag + '">#' + tag + '</span>');
  s = s.replace(RE_MENTION, (_, pre, name) => {
    const me = name.toLowerCase() === String(DB.identity).toLowerCase();
    return pre + '<span class="mention' + (me ? ' is-me' : '') + '">@' + name + '</span>';
  });

  return s.replace(new RegExp(PARK + '(\\d+)' + PARK, 'g'), (_, i) => parked[+i]);
}

/**
 * Sheet body -> HTML. Line-oriented like Markdown, because if Markdown is
 * simpler then Txtr should behave like Markdown (spec 37.10).
 * Task checkboxes carry their absolute line number so a click edits the
 * document rather than some parallel state.
 */
/** A fence is chrome: the block keeps the code, not the backticks. */
const fencedCode = (lines) =>
  '<pre data-b="code"><code>' + esc(lines.join('\n')) + '</code></pre>';

/** "| a | b |" -> ["a", "b"]. A leading/trailing pipe is decoration, not a
 * cell, and "\|" is a pipe a cell wants to keep. */
function splitTableRow(line) {
  const bare = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  return bare.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const RE_TABLE_SEP = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

function tableAlign(cell) {
  const c = cell.trim();
  if (/^:-+:$/.test(c)) return 'center';
  if (/^-+:$/.test(c)) return 'right';
  if (/^:-+$/.test(c)) return 'left';
  return '';
}

function renderBody(sheet, opts = {}) {
  const out = [];
  let para = [], fence = null, quote = null;
  // Nesting is indent alone: each level on the stack is a list still open
  // (its last <li> too, waiting to see whether a deeper one lands inside it
  // before anything closes it), so Tab's indentation reads back the same
  // shape it wrote (spec: what you can nest by Tab, a paste can also carry).
  let listStack = [];

  const flushPara = () => {
    if (para.length) { out.push('<p data-b="p">' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  // out.join('\n') is how every block gets a line to itself — but a li left
  // open (waiting to see whether a deeper item nests inside it) is not a
  // block boundary yet, so closing or nesting into it has to land right on
  // the end of what's already there, not as one more \n-separated entry
  // that Range#toString() (and everything built on it) would read as text
  // sitting inside that li.
  const append = (s) => { if (out.length) out[out.length - 1] += s; else out.push(s); };
  const flushList = () => {
    while (listStack.length) append('</li></' + listStack.pop().kind + '>');
  };
  /** Open, continue, or nest into a list at this line's own indent. */
  const enterListLevel = (kind, indent) => {
    while (listStack.length) {
      const top = listStack[listStack.length - 1];
      if (top.indent > indent || (top.indent === indent && top.kind !== kind)) {
        append('</li></' + top.kind + '>');
        listStack.pop();
        continue;
      }
      break;
    }
    const top = listStack[listStack.length - 1];
    if (top && top.indent === indent && top.kind === kind) {
      append('</li>');              // a sibling: the previous item's tag closes now
    } else if (top) {
      append('<' + kind + ' data-b="' + kind + '">');   // nests inside the still-open li above
      listStack.push({ indent, kind });
    } else {
      out.push('<' + kind + ' data-b="' + kind + '">'); // a fresh list, its own block
      listStack.push({ indent, kind });
    }
  };
  const flushQuote = () => {
    if (quote) {
      out.push('<blockquote class="quote" data-b="quote">' + quote + '</blockquote>');
      quote = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  let skipUntil = -1;
  sheet.lines.forEach((raw, i) => {
    if (i < skipUntil) return;
    const t = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    // fenced code
    if (/^```/.test(t)) {
      if (fence === null) { flushAll(); fence = []; }
      else { out.push(fencedCode(fence)); fence = null; }
      return;
    }
    if (fence !== null) { fence.push(raw); return; }

    if (!t) { flushAll(); return; }

    // A GFM table: a header row, a "|---|---|" line right under it saying so,
    // then however many rows keep the same shape until a blank line ends it.
    if (t.includes('|')) {
      const head = splitTableRow(t);
      const sepLine = sheet.lines[i + 1];
      if (head.length > 1 && sepLine && RE_TABLE_SEP.test(sepLine.trim())) {
        const aligns = splitTableRow(sepLine).map(tableAlign);
        const rows = [];
        let j = i + 2;
        while (j < sheet.lines.length && sheet.lines[j].trim().includes('|')) {
          rows.push(splitTableRow(sheet.lines[j]));
          j++;
        }
        flushAll();
        const cell = (tag, text, align) => '<' + tag +
          (align ? ' style="text-align:' + align + '"' : '') + '>' + inline(text || '') + '</' + tag + '>';
        out.push('<table data-b="table" data-aligns="' + aligns.map((a) => a || '-').join(',') + '">' +
          '<thead><tr>' + head.map((c, k) => cell('th', c, aligns[k])).join('') + '</tr></thead>' +
          '<tbody>' + rows.map((r) =>
            '<tr>' + head.map((_, k) => cell('td', r[k], aligns[k])).join('') + '</tr>'
          ).join('') + '</tbody></table>');
        skipUntil = j;
        return;
      }
    }

    // A line starting with an em dash right after a quote is a reply to it.
    // That is the entire comment system (spec 16).
    // A reply keeps its em dash and a reminder keeps its "!", because in both
    // the marker is part of what the line says — and because a line whose
    // rendering reorders its own words could not be written back (spec 16).
    const reply = /^(?:—|--)\s+(.+)$/.exec(t);
    if (reply && quote !== null) {
      const q = quote; quote = null;
      out.push('<blockquote class="quote" data-b="quote">' + q + '</blockquote>');
      const who = /\(([^)]+)\)\s*$/.exec(reply[1]);
      out.push('<p class="reply" data-b="line">— ' +
        inline(who ? reply[1].slice(0, who.index) : reply[1]) +
        (who ? '<span class="reply-who">(' + inline(who[1]) + ')</span>' : '') + '</p>');
      return;
    }

    if (/^>\s?/.test(t)) {
      flushPara(); flushList();
      quote = (quote || '') + '<p data-b="q">' + inline(t.replace(/^>\s?/, '')) + '</p>';
      return;
    }
    flushQuote();

    const sub = RE_SUB.exec(t);
    if (sub) {
      flushAll();
      out.push('<h3 data-b="h" data-l="' + sub[1].length + '">' + inline(sub[2]) + '</h3>');
      return;
    }

    if (/^(---|\*\*\*|___)$/.test(t)) { flushAll(); out.push('<hr data-b="hr">'); return; }

    // reminders
    const rem = RE_REMIND.exec(t);
    if (rem) {
      const w = parseWhen(rem[1]);
      if (w) {
        flushAll();
        out.push('<p class="reminder' + (w.at < Date.now() ? ' is-past' : '') +
          '" data-b="line" title="' + esc(w.label) + '">' + inline(t) + '</p>');
        return;
      }
    }

    // tasks and lists — indented further than the list line above becomes
    // nested inside it, exactly what Tab does live (its <li> stays open
    // above until something closes it: a sibling, a dedent, or the list
    // ending outright).
    const task = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(t);
    if (task) {
      flushPara(); flushQuote();
      enterListLevel('ul', indent);
      const done = task[1].toLowerCase() === 'x';
      out.push('<li class="task' + (done ? ' is-done' : '') +
        '" data-b="task" data-done="' + (done ? 1 : 0) + '">' +
        (opts.static
          ? '<span class="task-box" data-nomd>' + (done ? '[x]' : '[ ]') + '</span>'
          : '<button class="task-box" contenteditable="false" data-nomd>' +
            (done ? '[x]' : '[ ]') + '</button>') +
        inline(task[2]));
      return;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(t);
    const number = /^\d+[.)]\s+(.*)$/.exec(t);
    if (bullet || number) {
      flushPara(); flushQuote();
      const kind = bullet ? 'ul' : 'ol';
      enterListLevel(kind, indent);
      out.push('<li data-b="li">' + inline((bullet || number)[1]));
      return;
    }
    flushList();

    para.push(t);
  });

  if (fence !== null) out.push(fencedCode(fence));
  flushAll();
  return out.join('\n');
}


/* == 05. ROUTER ===========================================================
   #/                     the shelf
   #/<binder>             a Binder
   #/<binder>/<sheet>      a Binder with that sheet open
   #<sheet>                a plain fragment inside the Binder already open
   The sheet part is the heading's own id, so a sheet link is an ordinary anchor
   link (spec 6) and the back button works without any help.                 */

const App = {
  view: 'shelf',   // 'shelf' | 'binder'
  binderId: null,
  doc: null,       // parsed document of the open Binder
  col: 0,          // tag column: 0 = all sheets, otherwise doc.tags[col - 1]
  cur: 0,          // index into the currently visible sheets
  open: null,      // slug of the expanded sheet, which is the one being written
  namingBinderId: null,   // id of a just-created Binder still being named, on the shelf
};

const go = (hash) => { location.hash = hash; };
/** Same hash, same intent: re-run the route so the sheet still opens. */
const navigate = (hash) => { if (location.hash === hash) route(); else go(hash); };
const linkTo = (binderId, slug) => '#/' + binderId + (slug ? '/' + slug : '');

function route() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [first, second] = raw.split('/');

  if (!first) return show('shelf');

  const b = getBinder(first);
  if (b) return show('binder', b, second);

  // A bare fragment (#authentication) resolves to the Binder on screen, or
  // to whichever Binder has a sheet by that name — so a plain anchor link
  // shared out of Txtr still lands on the sheet (spec 6).
  const here = getBinder(App.binderId);
  const owner = (here && parse(here.text).sheets.some((c) => c.slug === first))
    ? here
    : DB.binders.find((b2) => parse(b2.text).sheets.some((c) => c.slug === first));
  if (owner) return show('binder', owner, first);

  show('shelf');
}

/**
 * A link — from search, from a shared URL — can point at a sheet that the
 * column on screen filters out, and expanding a hidden row shows nothing at
 * all. So the column follows the link: it moves to the sheet's own tag, or to
 * All when the sheet has none.
 */
function columnFor(slug) {
  if (!slug || App.col === 0) return;
  const sheet = App.doc.sheets.find((c) => c.slug === slug);
  if (!sheet || sheet.tag === App.doc.tags[App.col - 1]) return;
  App.col = sheet.tag ? App.doc.tags.indexOf(sheet.tag) + 1 : 0;
}

function show(view, binder, slug) {
  closeOverlays();
  // Whatever is still unsaved in lead/trail belongs to the Binder on screen
  // right now — commit it before App.doc points somewhere else.
  if (App.view === 'binder') commitRegions();
  if (view === 'shelf') {
    App.view = 'shelf'; App.binderId = null; App.doc = null; App.open = null; App.cur = 0;
    renderShelf();
  } else {
    const changed = App.binderId !== binder.id;
    App.view = 'binder';
    App.binderId = binder.id;
    App.doc = parse(binder.text);
    if (changed) { App.col = 0; App.cur = 0; }
    App.open = slug || null;
    columnFor(App.open);
    renderBinder();
  }
  renderChrome();
}


/* == 06. VIEW: SHELF ======================================================
   Not a dashboard. The Binders, large, and nothing else (spec 28).          */

function renderShelf() {
  const stage = $('#stage');
  // Whatever was touched last sits on top — the shelf is a desk, not an
  // archive in filing order.
  const ordered = [...DB.binders].sort((a, z) => z.updated - a.updated);
  const items = ordered.map((b, i) => {
    const d = parse(b.text);
    // A Binder just created is named right here, in place — not a button
    // yet, because a caret cannot live inside one (same reason a sheet's own
    // title is a div, not a button, once it is open).
    const naming = b.id === App.namingBinderId;
    const tag = naming ? 'div' : 'button';
    return '<' + tag + ' class="shelf-item' + (naming ? ' is-naming' : '') + '" ' +
      'data-id="' + b.id + '" data-i="' + i + '"' + (naming ? ' role="button" tabindex="-1"' : '') + '>' +
      '<h2 class="shelf-item-title"' +
        (naming ? ' contenteditable="true" spellcheck="true" data-hint="Name this Binder"' : '') + '>' +
        (naming ? '' : esc(b.title)) +
      '</h2>' +
      '<div class="shelf-item-meta">' +
        '<span>' + d.sheets.length + (d.sheets.length === 1 ? ' sheet' : ' sheets') + '</span>' +
        (d.tags.length ? '<span>' + esc(d.tags.join(' · ')) + '</span>' : '') +
        '<span>' + ago(b.updated) + '</span>' +
      '</div></' + tag + '>';
  }).join('');

  stage.className = 'stage';
  stage.innerHTML = '<div class="column">' +
    (items || '<p class="shelf-empty">No Binders yet. Press <kbd>B</kbd> and start writing.</p>') +
  '</div>';

  $$('.shelf-item', stage).forEach((el) => {
    if (el.classList.contains('is-naming')) return;
    el.addEventListener('click', () => go(linkTo(el.dataset.id)));
  });
  markShelfCursor();
  renderTagRail();

  if (App.namingBinderId) wireNaming();
}

/** Commit whatever was typed as the Binder's name, then move on. */
function commitBinderName(open) {
  const id = App.namingBinderId;
  const b = id && getBinder(id);
  App.namingBinderId = null;
  if (!b) return;
  const el = $('.shelf-item-title[contenteditable]');
  const name = el ? el.textContent.trim() : '';
  if (name) { b.title = name; b.updated = Date.now(); saveDB(); }
  if (!open) return renderShelf();

  // Named, and still empty: land in the one writable place it has. A sheet
  // of its own is only "# " away, typed there like anywhere else (spec 4) —
  // renderBinder() puts the caret there for any empty Binder, not just this one.
  go(linkTo(id));
}

function wireNaming() {
  const el = $('.shelf-item-title[contenteditable]');
  if (!el) return;
  el.focus();
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitBinderName(true); }
    if (e.key === 'Escape') { e.preventDefault(); commitBinderName(false); }
  });
  el.addEventListener('blur', () => { if (App.namingBinderId) commitBinderName(false); });
}

function markShelfCursor() {
  const items = $$('.shelf-item');
  if (!items.length) return;
  App.cur = Math.max(0, Math.min(App.cur, items.length - 1));
  items.forEach((el, i) => el.classList.toggle('is-cur', i === App.cur));
}


/* == 07. VIEW: BINDER =====================================================
   The reading representation: collapsed titles as an index, one sheet open
   at a time, and the lightline above the current one (spec 5).              */

function renderBinder() {
  const stage = $('#stage');
  commitRegions();          // absorb whatever is still unsaved in lead/trail first
  const doc = App.doc;

  const rows = doc.sheets.map((c, i) => {
    // The fragment stays in the markup because it is still the sheet's own
    // address; it is only hidden from view.
    // Not a <button>: the title is editable once the sheet is open, and a
    // caret cannot live inside a button.
    return '<li class="sheet" data-slug="' + esc(c.slug) + '" data-i="' + i + '" id="' + esc(c.slug) + '">' +
      '<div class="sheet-hit" role="button" tabindex="-1">' +
        '<span class="drag-handle" draggable="true" data-nomd aria-label="Drag to reorder">&#8942;&#8942;</span>' +
        '<span class="sheet-anchor" data-nomd>#' + esc(c.slug) + '</span>' +
        '<h2 class="sheet-title' + (c.level > 1 ? ' sheet-sub' : '') + '">' +
          (c.named ? inline(c.title) : '') + '</h2>' +
        tagChip(c.tag) +
      '</div>' +
      '<div class="sheet-body" hidden></div>' +
    '</li>';
  }).join('');

  stage.className = 'stage';
  stage.innerHTML = '<div class="column">' +
    '<div class="lead prose" id="lead"></div>' +
    (doc.sheets.length
      ? '<ol class="index" id="index">' + rows + '</ol>' +
        '<div class="lead prose trail" id="trail"></div>'
      : '') +
  '</div>';

  fillRegion('lead', doc.lead);
  if (doc.sheets.length) fillRegion('trail', []);

  $$('.sheet-hit', stage).forEach((hit) => {
    hit.addEventListener('click', (e) => {
      if (e.target.closest('.tag') || e.target.closest('.drag-handle')) return;
      const li = hit.closest('.sheet');
      // An open sheet is being written in: a click in its title is a caret,
      // not a request to close it. Esc closes.
      if (li.classList.contains('is-open')) return;
      // Dragging across the title selects it (to delete it, say) rather than
      // opening it — a click that leaves a selection behind was not a click.
      const sel = document.getSelection();
      if (sel && sel.toString().trim() && hit.contains(sel.anchorNode)) return;
      App.cur = visible().indexOf(li);
      // A click opens the sheet to read; it does not put a caret in it —
      // clicking again, into the text itself, is what starts writing. The
      // title is only made contenteditable inside expand(), below, but the
      // browser still resolves *this* click's own focus against the DOM as
      // it stands after every listener has run — so it can land a caret on
      // the title anyway, now that there's something editable to catch it.
      // A tick later undoes that, same as if there had been nothing to catch.
      expand(li.dataset.slug);
      const titleEl = $('.sheet-title', li);
      if (titleEl) setTimeout(() => {
        if (document.activeElement === titleEl) {
          titleEl.blur();
          document.getSelection().removeAllRanges();
        }
      }, 0);
    });
  });
  // From the index a chip is navigation; on the sheet being written it is the
  // sheet's own tag, so it opens the list of tags to switch to.
  $$('.sheet-hit .tag', stage).forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const li = el.closest('.sheet');
    if (li.classList.contains('is-open')) {
      openTagMenu(el, App.doc.sheets[+li.dataset.i]);
    } else if (el.dataset.tag) {
      openColumn(el.dataset.tag);
    }
  }));

  wireDragHandles(stage);

  applyColumn();
  if (App.open) expand(App.open, { scroll: true });
  else if (doc.sheets.length) setCursor(App.cur, { scroll: false });
  // Nothing to read yet, nothing to click either: land the caret in the one
  // writable thing on screen, the same as naming the Binder and opening it
  // straight into writing does (a sheet of its own is only "# " away).
  else { const lead = $('#lead'); if (lead) placeCaret(lead.firstElementChild || lead, 'start'); }

  renderTagRail();
}

/**
 * Picking up a row and setting it down among the others reorders the
 * document itself — the handle is the only draggable thing so dragging never
 * fights with selecting a title to delete it (spec 9).
 */
function wireDragHandles(root) {
  let from = null;
  const clearMarks = () => $$('.sheet', root).forEach((el) =>
    el.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));

  $$('.drag-handle', root).forEach((handle) => {
    handle.addEventListener('dragstart', (e) => {
      const li = handle.closest('.sheet');
      from = +li.dataset.i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(from));
      li.classList.add('is-dragging');
    });
    handle.addEventListener('dragend', () => { from = null; clearMarks(); });
  });

  $$('.sheet', root).forEach((li) => {
    li.addEventListener('dragover', (e) => {
      if (from === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const before = e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
      clearMarks();
      li.classList.add(before ? 'is-drop-before' : 'is-drop-after');
    });
    li.addEventListener('drop', (e) => {
      if (from === null) return;
      e.preventDefault();
      const before = e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
      let to = +li.dataset.i + (before ? 0 : 1);
      if (from < to) to--;            // the row being moved is about to vanish from above it
      clearMarks();
      moveSheet(from, to);
    });
  });
}

/**
 * Pick up a sheet's own lines, heading and all, and set them down somewhere
 * else in the file. Order is the only thing that changes (spec 9).
 */
function moveSheet(from, to) {
  const b = getBinder(App.binderId);
  if (!b || !App.doc) return;
  if (App.open) writeOpenSheet();          // commit first: line numbers below read App.doc fresh
  const sheets = App.doc.sheets;
  if (from === to || !sheets[from]) return;

  const lines = b.text.split('\n');
  const bounds = sheets.map((s, i) => [s.line, sheets[i + 1] ? sheets[i + 1].line : lines.length]);
  const lead = lines.slice(0, sheets[0].line);
  const chunks = bounds.map(([f, t]) => lines.slice(f, t));
  const [moved] = chunks.splice(from, 1);
  chunks.splice(Math.max(0, Math.min(to, chunks.length)), 0, moved);

  const openSlug = App.open;
  writeBinder(b, tidyLines([...lead, ...chunks.flat()]).join('\n') + '\n');
  App.doc = parse(b.text);
  renderBinder();
  const still = openSlug && App.doc.sheets.find((c) => c.slug === openSlug);
  if (still) expand(still.slug, { scroll: false });
}

/**
 * One tag, one chip, always to the right of the title. An untagged sheet still
 * gets a chip once it is open, because the chip is how a tag is chosen.
 */
const tagChip = (tag) => (tag
  ? '<span class="tag" data-tag="' + esc(tag) + '" role="button" tabindex="-1">' + esc(tag) + '</span>'
  : '<span class="tag is-untagged" data-tag="" role="button" tabindex="-1">Tag</span>');

/** The sheets currently inside the visible tag column. */
const visible = () => $$('.sheet').filter((el) => !el.classList.contains('is-hidden'));

const sheetBySlug = (slug) => $$('.sheet').find((el) => el.dataset.slug === slug);

function setCursor(i, { scroll = true, align } = {}) {
  const list = visible();
  if (!list.length) return;
  App.cur = Math.max(0, Math.min(i, list.length - 1));
  list.forEach((el, n) => el.classList.toggle('is-cur', n === App.cur));
  if (scroll) {
    suppressScrollSync();
    list[App.cur].scrollIntoView({
      // An open sheet starts at the top of the window; a collapsed row only
      // moves the page if it is not already on screen.
      block: align || (App.open ? 'start' : 'nearest'),
      behavior: 'smooth',
    });
  }
}

function expand(slug, { scroll = true } = {}) {
  if (!sheetBySlug(slug)) return;
  collapse({ keepHash: true });          // writing the last one re-parses App.doc
  const sheet = App.doc.sheets.find((c) => c.slug === slug);
  const li = sheetBySlug(slug);
  if (!sheet || !li) return;
  App.open = slug;

  const body = $('.sheet-body', li);
  body.innerHTML = '<div class="prose">' + renderBody(sheet) + '</div>';
  body.hidden = false;
  li.classList.add('is-open');
  wireSheetBody(body);

  const all = getBinder(App.binderId).text.split('\n');
  const next = App.doc.sheets[App.doc.sheets.indexOf(sheet) + 1];
  Edit.from = sheet.line;
  Edit.to = next ? next.line : all.length;
  Edit.level = sheet.level;
  Edit.tag = sheet.tag;
  Edit.dirty = false;

  makeEditable(li, sheet);

  setCursor(visible().indexOf(li), { scroll, align: 'start' });
  if (location.hash !== linkTo(App.binderId, slug)) {
    history.replaceState(null, '', linkTo(App.binderId, slug));
  }
}

function collapse({ keepHash = false } = {}) {
  // Anything still in the DOM is the newest version of the text.
  if ($('.sheet.is-open .prose')) writeOpenSheet();
  $$('.sheet.is-open').forEach((li) => {
    li.classList.remove('is-open');
    const body = $('.sheet-body', li);
    body.hidden = true; body.innerHTML = '';
  });
  App.open = null;
  Edit.from = Edit.to = -1;
  Edit.dirty = false;
  if (!keepHash && App.binderId) history.replaceState(null, '', linkTo(App.binderId));
}

/**
 * A tag jumps to its column and a checkbox flips itself, wherever in the body
 * either one ends up — typing keeps adding both, so the click has to be
 * delegated to the body rather than bound to each mark as it is drawn.
 */
function wireProse(root, onToggle) {
  root.addEventListener('click', (e) => {
    const ref = e.target.closest('.tagref');
    if (ref) { e.stopPropagation(); openColumn(ref.dataset.tag); return; }

    const box = e.target.closest('.task-box');
    if (!box) return;
    e.preventDefault(); e.stopPropagation();
    const item = box.closest('.task');
    const done = item.dataset.done !== '1';
    item.dataset.done = done ? '1' : '0';
    item.classList.toggle('is-done', done);
    box.textContent = done ? '[x]' : '[ ]';
    onToggle();
  });
}

function wireSheetBody(body) {
  wireProse(body, () => { touched(); writeOpenSheet(); });
}

function copyLink(sheet) {
  const url = location.origin + location.pathname + linkTo(App.binderId, sheet.slug);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url)
      .then(() => toast('Link copied. It opens on this sheet.'))
      .catch(() => toast(url));
  } else toast(url);
}


/* == 08. TAGS =============================================================
   Tags are the horizontal dimension. Column 0 is every sheet; each other
   column is one tag. Moving left and right is the whole Kanban feature
   (spec 9, 10) — there is no board, no status, no column config.            */

function renderTagRail() {
  const rail = $('#tagrail');
  const tags = App.doc ? App.doc.tags : [];
  if (App.view !== 'binder' || !tags.length) { rail.hidden = true; rail.innerHTML = ''; return; }

  const count = (t) => App.doc.sheets.filter((c) => c.tag === t).length;
  rail.hidden = false;
  rail.innerHTML =
    '<button class="tab' + (App.col === 0 ? ' is-on' : '') + '" data-col="0">All' +
      '<span class="tab-count">' + App.doc.sheets.length + '</span></button>' +
    tags.map((t, i) =>
      '<button class="tab' + (App.col === i + 1 ? ' is-on' : '') + '" data-col="' + (i + 1) + '">' +
        esc(t) + '<span class="tab-count">' + count(t) + '</span></button>').join('');

  $$('.tab', rail).forEach((el) => el.addEventListener('click', () => setColumn(+el.dataset.col)));
}

/**
 * Take a tag off every sheet that carries it. The tag itself is not a record
 * anywhere, so it stops existing when the last sheet stops mentioning it.
 */
function dropTag(tag) {
  const b = getBinder(App.binderId);
  if (!b) return;
  const n = App.doc.sheets.filter((c) => c.tag === tag).length;
  if (!confirm('Remove the tag "' + tag + '" from ' + n +
      (n === 1 ? ' sheet' : ' sheets') + '? The sheets themselves stay.')) return;

  const open = App.open;
  const lines = b.text.split('\n');
  App.doc.sheets.forEach((c) => {
    if (c.tag !== tag) return;
    lines[c.line] = ('#'.repeat(c.level) + ' ' + c.title).trim();
  });
  writeBinder(b, lines.join('\n'));

  App.doc = parse(b.text);
  App.col = 0;
  renderBinder();
  if (open && App.doc.sheets.some((c) => c.slug === open)) expand(open, { scroll: false });
  toast('Tag removed');
}

function setColumn(n) {
  const total = App.doc.tags.length + 1;
  App.col = (n + total) % total;
  collapse({ keepHash: true });
  applyColumn();
  renderTagRail();
  setCursor(0);
}

/** Hide the sheets outside the current column. Sheets keep their text either way. */
function applyColumn() {
  const tag = App.col === 0 ? null : App.doc.tags[App.col - 1];
  $$('.sheet').forEach((el, i) => {
    const sheet = App.doc.sheets[i];
    el.classList.toggle('is-hidden', !!tag && sheet.tag !== tag);
  });
}

const openColumn = (tag) => {
  const i = App.doc.tags.indexOf(tag);
  if (i >= 0) setColumn(i + 1);
};

/**
 * The tags this Binder already uses, as one press each, plus a field for one
 * it does not. Opened from a sheet's own chip — a tag is not a record
 * anywhere, it is a word on a sheet's title line, so the only way to make
 * one is to give it to a sheet (spec 9).
 */
function openTagMenu(anchor, sheet) {
  closeTagMenu();
  const on = sheet || App.doc.sheets[currentSheetIndex()];
  if (!on) return toast('Open a sheet to tag it');

  const menu = document.createElement('form');
  menu.className = 'tag-menu';
  menu.id = 'tag-menu';
  menu.innerHTML =
    App.doc.tags.map((t) =>
      // Picking the tag and deleting it are two different buttons, so a slip
      // of the thumb while reassigning a sheet can never drop a whole column.
      '<div class="tag-menu-row">' +
        '<button type="button" class="tag-menu-item' + (t === on.tag ? ' is-on' : '') +
        '" data-pick="' + esc(t) + '">' + esc(t) + '</button>' +
        '<button type="button" class="tag-menu-drop" data-drop="' + esc(t) + '" ' +
          'aria-label="Delete the tag ' + esc(t) + '">&#215;</button>' +
      '</div>').join('') +
    (on.tag
      ? '<button type="button" class="tag-menu-item is-danger" data-pick="">No tag</button>'
      : '') +
    '<input type="text" placeholder="Or a new one" ' +
      'spellcheck="false" autocomplete="off" aria-label="New tag">';

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 8, window.innerHeight - 40) + 'px';
  menu.style.left = Math.max(12,
    Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)) + 'px';

  const input = $('input', menu);
  menu.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.trim()) { closeTagMenu(); setSheetTag(on, input.value); }
  });
  $$('[data-pick]', menu).forEach((el) => el.addEventListener('click', () => {
    closeTagMenu();
    setSheetTag(on, el.dataset.pick);
  }));
  $$('[data-drop]', menu).forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTagMenu();
    dropTag(el.dataset.drop);
  }));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeTagMenu();
  });
}

function closeTagMenu() {
  const m = $('#tag-menu');
  if (m) m.remove();
}

/** One tag in, the heading line rewritten. An empty value removes it. */
function setSheetTag(sheet, value) {
  const tag = String(value || '').split(/[\s,#]+/).filter(Boolean)[0] || '';
  const b = getBinder(App.binderId);
  const lines = b.text.split('\n');
  lines[sheet.line] = ('#'.repeat(sheet.level) + ' ' + sheet.title + (tag ? '  #' + tag : '')).trim();
  writeBinder(b, lines.join('\n'));

  App.doc = parse(b.text);
  const still = App.doc.sheets.find((c) => c.slug === sheet.slug);
  // Retagging can move the sheet out of the column it is being read in, so the
  // column follows it rather than filtering away the sheet still on screen.
  if (still) columnFor(still.slug);
  renderBinder();
  if (still) expand(still.slug, { scroll: false });
  toast(tag ? 'Tagged ' + tag : 'Tag removed');
}


/* == 09. EDITING ==========================================================
   There is no writing mode, because the document on screen is the one you
   write in (spec 4, 15). Opening a sheet makes its title and its body
   editable where they already are: the blocks stay rendered while you type,
   and the text underneath is rewritten from them as you go.

   The invariant that keeps this small: while a sheet has focus the DOM is the
   working copy and b.text is derived from it, never the other way round. So
   nothing ever re-renders under the caret. Everything outside the open sheet
   — the other rows, the tag rail, the reminders — re-syncs when focus leaves
   or when a new sheet is committed.

   Surface: makeEditable(li, sheet), writeOpenSheet(), leaveSheet().         */

/* -- DOM -> Markdown ------------------------------------------------------
   The exact inverse of the renderer, so a sheet can survive any number of
   round trips through the screen.                                          */

/* Parked next to a caret that would otherwise fall inside a closed element. */
const ZWSP = '\u200b';

const MD_WRAP = {
  strong: '**', b: '**', em: '*', i: '*',
  del: '~~', s: '~~', strike: '~~', code: '`',
};

/** Inline DOM -> Markdown. The inverse of inline(). */
function mdInline(node) {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += n.nodeValue.split(ZWSP).join(''); return; }
    if (n.nodeType !== 1) return;
    if (n.dataset && n.dataset.nomd !== undefined) return;   // chrome, not text
    const tag = n.tagName.toLowerCase();

    if (tag === 'br') { out += '\n'; return; }
    if (tag === 'img') {
      out += '![' + (n.getAttribute('alt') || '') + '](' + n.getAttribute('src') + ')';
      return;
    }
    // A tag and a mention are written the way they are read: as themselves.
    if (n.classList.contains('tagref') || n.classList.contains('mention')) {
      out += n.textContent;
      return;
    }
    if (tag === 'a') {
      const href = n.getAttribute('href') || '';
      const text = mdInline(n);
      out += (!href || text === href) ? text : '[' + text + '](' + href + ')';
      return;
    }
    const inner = tag === 'code' ? n.textContent : mdInline(n);
    const wrap = MD_WRAP[tag];
    out += (wrap && inner.trim()) ? wrap + inner + wrap : inner;
  });
  return out;
}

/** One block -> its source lines, appended to out. */
function mdBlock(el, out) {
  const kind = el.dataset.b;

  if (kind === 'hr') { out.push('---'); return; }

  if (kind === 'code') {
    out.push('```');
    String(el.textContent || '').replace(/\n+$/, '').split('\n').forEach((l) => out.push(l));
    out.push('```');
    return;
  }

  if (kind === 'table') {
    const aligns = (el.dataset.aligns || '').split(',').map((a) => (a === '-' ? '' : a));
    const sepCell = (a) => (a === 'center' ? ':-:' : a === 'right' ? '-:' : a === 'left' ? ':-' : '-');
    // A cell's own text keeping a "|" would otherwise look like one more of
    // the row's own — it has to leave as "\|" to come back the same cell.
    const rowLine = (cells) => '| ' + cells.map((c) => mdInline(c).replace(/\|/g, '\\|').trim()).join(' | ') + ' |';

    const head = [...el.querySelectorAll('thead > tr > th')];
    out.push(rowLine(head));
    out.push('| ' + head.map((_, k) => sepCell(aligns[k])).join(' | ') + ' |');
    [...el.querySelectorAll('tbody > tr')].forEach((tr) => out.push(rowLine([...tr.children])));
    return;
  }

  // Containers hold the lines; the container itself has no line of its own.
  if (kind === 'ul' || kind === 'ol' || kind === 'quote') {
    let n = 1;
    [...el.children].forEach((child) => {
      if (kind === 'ol') child.dataset.n = n++;

      // A list item that itself holds a nested list (Tab did that, live) is
      // its own line first, then that sublist indented two spaces under it —
      // the same shape a level of Tab nesting reads back as.
      const nested = (child.dataset.b === 'li' || child.dataset.b === 'task')
        && [...child.children].find((c) => c.dataset && (c.dataset.b === 'ul' || c.dataset.b === 'ol'));
      if (!nested) { mdBlock(child, out); return; }

      // A clone stripped of its sublist so mdInline reads just the item's own
      // text — parented in a throwaway list of the same kind, since mdBlock
      // asks a li's own parent whether it's numbered or bulleted.
      const clone = child.cloneNode(true);
      [...clone.children].find((c) => c.dataset && (c.dataset.b === 'ul' || c.dataset.b === 'ol')).remove();
      const shell = document.createElement(kind);
      shell.dataset.b = kind;
      shell.appendChild(clone);
      mdBlock(clone, out);
      const inner = [];
      mdBlock(nested, inner);
      inner.forEach((l) => out.push(l.trim() ? '  ' + l : l));
    });
    return;
  }

  const text = mdInline(el).replace(/[ \t]+$/, '');
  const prefix =
    kind === 'sheet' ? '#'.repeat(+el.dataset.l || 1) + ' '
    : kind === 'h'   ? '#'.repeat(+el.dataset.l || 3) + ' '
    : kind === 'li'  ? (el.parentNode.dataset.b === 'ol' ? (el.dataset.n || 1) + '. ' : '- ')
    : kind === 'task' ? '- [' + (el.dataset.done === '1' ? 'x' : ' ') + '] '
    : kind === 'q'   ? '> '
    : '';

  // An emptied block is a blank line, not a stray marker left in the file.
  // A sheet heading is the exception: it is the sheet, so it keeps its hashes
  // while the title is still being typed.
  if (!text.trim() && prefix && kind !== 'sheet') { out.push(''); return; }

  text.split('\n').forEach((l, i) => out.push(i ? l : prefix + l));
}

/**
 * One blank line between blocks and none left over at either end. Emptied
 * blocks each want to be a blank line, and several in a row would otherwise
 * pile up in the file. Inside a fence a blank line is content, so it stays.
 */
function tidyLines(lines) {
  const out = [];
  let fence = false;
  lines.forEach((l) => {
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence || l.trim()) { out.push(l); return; }
    if (out.length && out[out.length - 1].trim()) out.push(l);
  });
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/** The whole body -> source lines, blank line between blocks. */
function serializeBody(root) {
  const out = [];
  [...root.children].forEach((el) => {
    if (!el.dataset.b) return;              // anything unlabelled is not text
    const before = out.length;
    mdBlock(el, out);
    if (out.length > before) out.push('');
  });
  return tidyLines(out);
}


/* -- writing back --------------------------------------------------------- */

/* Reading a sheet must not rewrite it. Rendering a paragraph forgets where
   its source line breaks were, so writing back always reflows — which is fine
   for a sheet someone edited and wrong for one they only looked at.

   from/to are the sheet's own region in the file, remembered when it opens
   rather than looked up again on every write. It has to be remembered:
   typing "# " puts a real heading in the text, and a fresh parse would then
   report the sheet as ending *at* that heading — so writing the body back
   would put the heading before its own copy, once per keystroke. level and
   tag are held for the same reason. */
const Edit = { dirty: false, from: -1, to: -1, level: 1, tag: null };
const touched = () => { Edit.dirty = true; };

/**
 * Rewrite this sheet's own lines from the DOM, leaving every other line in
 * the Binder untouched. Returns what changed, so the caller can decide
 * whether the rest of the screen needs to catch up.
 */
function replaceSheetLines(li, bodyLines) {
  const b = getBinder(App.binderId);
  const idx = +li.dataset.i;
  const titleEl = $('.sheet-title', li);
  if (!b || !App.doc || !titleEl || Edit.from < 0) return null;

  const title = mdInline(titleEl).replace(/\s+/g, ' ').trim();
  const head = '#'.repeat(Edit.level) + ' ' + title + (Edit.tag ? '  #' + Edit.tag : '');

  const lines = b.text.split('\n');
  const block = bodyLines.length ? [head, '', ...bodyLines, ''] : [head, ''];
  const text = [...lines.slice(0, Edit.from), ...block, ...lines.slice(Edit.to)].join('\n');

  Edit.dirty = false;
  if (text === b.text) return { idx, sheets: App.doc.sheets.length, changed: false };

  Edit.to = Edit.from + block.length;      // the region is this long now
  const was = App.doc.sheets.length;
  writeBinder(b, text);
  App.doc = parse(b.text);

  // A Binder with no name of its own borrows the first sheet's, once that
  // sheet has one.
  if (/^untitled$/i.test(b.title) && App.doc.sheets[0] && App.doc.sheets[0].named) {
    b.title = App.doc.sheets[0].title;
    renderChrome();
  }

  // Renaming a sheet renames its address, and the row it lives in.
  const now = App.doc.sheets[idx];
  if (now && now.slug !== li.dataset.slug) {
    li.dataset.slug = now.slug;
    li.id = now.slug;
    App.open = now.slug;
    history.replaceState(null, '', linkTo(App.binderId, now.slug));
  }
  return { idx, sheets: App.doc.sheets.length, changed: true, split: App.doc.sheets.length !== was };
}

function writeOpenSheet() {
  const li = $('.sheet.is-open');
  const body = li && $('.prose', li);
  if (!li || !body || !Edit.dirty) return null;
  return replaceSheetLines(li, serializeBody(body));
}

const persistSheet = debounce(() => {
  if (!writeOpenSheet()) return;
  // A heading still being typed is already a sheet in the text but not yet a
  // row on screen, so the counts in the rail would flicker word by word.
  if (!$('.sheet.is-open .prose [data-b="sheet"]')) renderTagRail();
  scheduleReminders();
  refreshBell();
}, 300);


/* -- caret ---------------------------------------------------------------- */

function placeCaret(el, where = 'start') {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(where === 'start');
  // A leading widget (e.g. a task's checkbox) isn't editable text: "start"
  // means the start of what's actually typeable, which is right after it.
  if (where === 'start' && el.firstChild && el.firstChild.nodeType === 1
      && el.firstChild.contentEditable === 'false') {
    r.setStart(el, 1);
    r.collapse(true);
  }
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return el;
}

/** The block the caret is in: the nearest labelled ancestor. */
function blockOf(node, root) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentNode);
  while (el && el !== root) {
    if (el.dataset && el.dataset.b) return el;
    el = el.parentNode;
  }
  return null;
}

function currentBlock(root) {
  const sel = document.getSelection();
  if (!sel.rangeCount) return null;
  const node = sel.getRangeAt(0).startContainer;
  return root.contains(node) ? blockOf(node, root) : null;
}

/** Is the caret at the very start (or end) of this element's text? */
function atEdge(el, where) {
  const sel = document.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return false;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  if (where === 'start') {
    // A leading widget (a task's checkbox) carries its own text ("[ ]") that
    // Range#toString() can't tell apart from typed content — start past it.
    const from = (el.firstChild && el.firstChild.dataset && el.firstChild.dataset.nomd !== undefined) ? 1 : 0;
    probe.setStart(el, from);
    probe.setEnd(r.startContainer, r.startOffset);
  } else probe.setStart(r.endContainer, r.endOffset);
  return probe.toString().length === 0;
}

/** Is the whole of this block's text selected — nothing before or after it? */
function selectionSpans(el) {
  const sel = document.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return false;
  // A leading widget (a task's checkbox) carries its own text ("[ ]") that
  // Range#toString() can't tell apart from typed content — start past it.
  const from = (el.firstChild && el.firstChild.dataset && el.firstChild.dataset.nomd !== undefined) ? 1 : 0;
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setStart(el, from);
  before.setEnd(r.startContainer, r.startOffset);
  const after = document.createRange();
  after.selectNodeContents(el);
  after.setStart(r.endContainer, r.endOffset);
  return before.toString().length === 0 && after.toString().length === 0;
}

/** Everything after the caret, lifted out of the block. */
function cutToEnd(block) {
  const sel = document.getSelection();
  const r = sel.getRangeAt(0);
  if (!r.collapsed) r.deleteContents(); // erase the selection before splitting
  const tail = document.createRange();
  tail.selectNodeContents(block);
  tail.setStart(r.startContainer, r.startOffset);
  return tail.extractContents();
}


/**
 * Take one line out of a list or a quote and leave the rest of it intact:
 * the items above stay where they are, the line lands after them, and any
 * items below start a list of their own.
 */
function liftOut(block, made) {
  const container = block.parentNode;
  const below = [...container.children].slice([...container.children].indexOf(block) + 1);
  container.parentNode.insertBefore(made, container.nextSibling);
  if (below.length) {
    const rest = container.cloneNode(false);
    below.forEach((n) => rest.appendChild(n));
    made.parentNode.insertBefore(rest, made.nextSibling);
  }
  block.remove();
  if (!container.children.length) container.remove();
  return made;
}

/**
 * Tab at the start of a list item nests it one level deeper, under whatever
 * is directly above it; Shift+Tab is the other way. Either one only makes
 * sense relative to a neighbour — the first item in a list has nothing
 * above to nest under, and a top-level item has nowhere further to climb.
 */
function indentListItem(li) {
  const prev = li.previousElementSibling;
  if (!prev) return false;
  const kind = li.parentNode.dataset.b;
  let sub = [...prev.children].find((c) => c.dataset && c.dataset.b === kind);
  if (!sub) sub = prev.appendChild(newBlock(kind));
  sub.appendChild(li);
  placeCaret(li, 'start');
  return true;
}

function outdentListItem(li) {
  const sub = li.parentNode;              // the list li currently sits in
  const parentLi = sub.parentNode;        // the item that list is nested under
  if (!parentLi.dataset || (parentLi.dataset.b !== 'li' && parentLi.dataset.b !== 'task')) return false;
  const grandList = parentLi.parentNode;  // the list parentLi itself sits in

  // Whatever came after li in the nested list was "under" it too, once li
  // climbs back out it takes that tail along as a sublist of its own.
  const after = [...sub.children].slice([...sub.children].indexOf(li) + 1);
  grandList.insertBefore(li, parentLi.nextSibling);
  if (after.length) {
    const rest = li.appendChild(newBlock(sub.dataset.b));
    after.forEach((n) => rest.appendChild(n));
  }
  if (!sub.children.length) sub.remove();
  placeCaret(li, 'start');
  return true;
}


/* -- building blocks ------------------------------------------------------ */

function newBlock(kind, level) {
  const el = document.createElement(
    kind === 'sheet' ? 'h2' : kind === 'h' ? 'h3'
    : kind === 'li' || kind === 'task' ? 'li'
    : kind === 'ul' ? 'ul' : kind === 'ol' ? 'ol'
    : kind === 'quote' ? 'blockquote' : kind === 'code' ? 'pre' : 'p');
  el.dataset.b = kind;
  if (kind === 'p') el.dataset.hint = 'Write. A line starting with # is a heading.';
  if (kind === 'sheet') { el.className = 'sheet-title is-pending'; el.dataset.l = level || 1; }
  if (kind === 'h') el.dataset.l = level || 3;
  if (kind === 'task') { el.className = 'task'; el.dataset.done = '0'; el.appendChild(taskBox(false)); }
  if (kind === 'quote') el.className = 'quote';
  if (kind === 'code') el.appendChild(document.createElement('code'));
  return el;
}

function taskBox(done) {
  const box = document.createElement('button');
  box.className = 'task-box';
  box.contentEditable = 'false';
  box.dataset.nomd = '';
  box.textContent = done ? '[x]' : '[ ]';
  return box;
}

/** The editable part of a block: a task keeps its box out of the way. */
const blockText = (el) => (el.dataset.b === 'task'
  ? [...el.childNodes].filter((n) => !(n.dataset && n.dataset.nomd !== undefined))
      .map((n) => n.textContent).join('')
  : el.textContent).split(ZWSP).join('');


/* -- live formatting ------------------------------------------------------
   Two transforms, both run on input and both leaving the caret where the
   typing was: a marker at the start of a line changes what the line is, and
   a closed marker inside it changes how a run of words looks.              */

const BLOCK_RULES = [
  { re: /^(#{1,2})[ \t]/,        kind: 'sheet' },
  { re: /^(#{3,6})[ \t]/,        kind: 'h' },
  { re: /^[-*+][ \t]\[( |x|X)\][ \t]/, kind: 'task' },
  { re: /^\[( |x|X)\][ \t]/,     kind: 'task' },   // typed inside a list item
  { re: /^[-*+][ \t]/,           kind: 'ul' },
  { re: /^\d+[.)][ \t]/,         kind: 'ol' },
  { re: /^>[ \t]/,               kind: 'quote' },
  { re: /^```/,                  kind: 'code' },
];

/**
 * A marker typed at the start of a line turns the line into that kind of
 * thing straight away, and the marker itself stops being text — which is the
 * whole of "type # and it is a heading".
 */
function completeBlock(root) {
  const block = currentBlock(root);
  if (!block || block.dataset.b === 'code') return false;
  const kind = block.dataset.b;
  // Only a plain line, a quoted line, or a bare list item volunteers.
  if (!['p', 'q', 'li'].includes(kind)) return false;

  const text = blockText(block);
  const rule = BLOCK_RULES.find((r) => r.re.test(text));
  if (!rule) return false;
  if (rule.kind === 'task' && kind !== 'li' && kind !== 'p') return false;
  if (kind === 'li' && rule.kind === 'ul') return false;          // already one

  const m = rule.re.exec(text);
  const rest = text.slice(m[0].length);

  let made;
  if (rule.kind === 'ul' || rule.kind === 'ol') {
    const prev = block.previousElementSibling;
    const list = (prev && prev.dataset.b === rule.kind)
      ? prev : block.parentNode.insertBefore(newBlock(rule.kind), block);
    made = list.appendChild(newBlock('li'));
    made.textContent = rest;
  } else if (rule.kind === 'task') {
    if (kind === 'li') {
      made = newBlock('task');
      made.appendChild(document.createTextNode(rest));
      made.dataset.done = /[xX]/.test(m[1] || '') ? '1' : '0';
      $('.task-box', made).textContent = made.dataset.done === '1' ? '[x]' : '[ ]';
      block.parentNode.replaceChild(made, block);
      return placeCaret(made, 'end') && true;
    }
    const list = block.parentNode.insertBefore(newBlock('ul'), block);
    made = list.appendChild(newBlock('task'));
    made.appendChild(document.createTextNode(rest));
  } else if (rule.kind === 'quote') {
    const prev = block.previousElementSibling;
    const quote = (prev && prev.dataset.b === 'quote')
      ? prev : block.parentNode.insertBefore(newBlock('quote'), block);
    made = quote.appendChild(newBlock('q'));
    made.textContent = rest;
  } else if (rule.kind === 'code') {
    made = newBlock('code');
    $('code', made).textContent = rest;
    block.parentNode.replaceChild(made, block);
    return placeCaret($('code', made), 'end') && true;
  } else {
    made = newBlock(rule.kind, m[1].length);
    made.textContent = rest;
    block.parentNode.replaceChild(made, block);
    return placeCaret(made, 'end') && true;
  }

  block.remove();
  placeCaret(made, 'end');
  return true;
}

// Longest marker first, so ** is bold before * can be italic.
const MARKERS = [
  { open: '**', tag: 'strong' },
  { open: '~~', tag: 'del' },
  { open: '`', tag: 'code' },
  { open: '*', tag: 'em' },
  { open: '_', tag: 'em' },
];

/** Closing a marker formats what it wraps, and the marker stops being text. */
function completeMarker(root) {
  const sel = document.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const node = r.startContainer;
  if (node.nodeType !== 3 || !root.contains(node)) return false;
  const block = blockOf(node, root);
  if (!block || block.dataset.b === 'code') return false;

  const before = node.nodeValue.slice(0, r.startOffset);
  for (const m of MARKERS) {
    if (!before.endsWith(m.open)) continue;
    const body = before.slice(0, -m.open.length);
    const at = body.lastIndexOf(m.open);
    if (at < 0) continue;
    const content = body.slice(at + m.open.length);
    if (!content.trim() || /^\s|\s$/.test(content)) continue;
    if (content.includes(m.open)) continue;
    if (m.open.length === 1) {
      // A single * or _ inside a word is punctuation, not emphasis — and one
      // sitting against another is half of a **, which has not closed yet.
      if (/[\w]/.test(body[at - 1] || '')) continue;
      if (body[at - 1] === m.open || content.endsWith(m.open)) continue;
    }

    const tail = node.nodeValue.slice(r.startOffset);
    node.nodeValue = node.nodeValue.slice(0, at);
    const el = document.createElement(m.tag);
    el.textContent = content;
    // With nothing after it, the caret would fall back inside the element that
    // just closed and the next word would be swallowed by it. A zero width
    // space is somewhere outside to stand; serializing drops it again.
    const after = document.createTextNode(tail || ZWSP);
    node.parentNode.insertBefore(el, node.nextSibling);
    node.parentNode.insertBefore(after, el.nextSibling);
    const rr = document.createRange();
    rr.setStart(after, tail ? 0 : 1);
    rr.collapse(true);
    sel.removeAllRanges();
    sel.addRange(rr);
    return true;
  }
  return false;
}


/* -- tables ---------------------------------------------------------------
   A grid, not one more kind of paragraph: Tab and Enter move the caret
   around the cells instead of indenting or splitting a line, running out
   the last row or column grows the table rather than doing nothing.        */

const cellOf = (node) => node && (node.nodeType === 1 ? node : node.parentNode).closest('td, th');

function addTableRow(table) {
  const tr = document.createElement('tr');
  const count = table.querySelector('thead > tr').children.length;
  for (let k = 0; k < count; k++) tr.appendChild(document.createElement('td'));
  table.querySelector('tbody').appendChild(tr);
  return tr;
}

/** Tab / Shift+Tab: reading order, adding a row once the last cell runs out. */
function stepTableCell(cell, forward) {
  const table = cell.closest('table');
  const cells = [...table.querySelectorAll('th, td')];
  const idx = cells.indexOf(cell) + (forward ? 1 : -1);
  const target = idx >= cells.length ? addTableRow(table).firstChild : cells[idx];
  if (target) placeCaret(target, 'start');
}

/** Enter: straight down the same column, adding a row past the last one. */
function stepTableRow(cell) {
  const table = cell.closest('table');
  const col = [...cell.parentNode.children].indexOf(cell);
  const rows = [table.querySelector('thead > tr'), ...table.querySelectorAll('tbody > tr')];
  const at = rows.indexOf(cell.closest('tr'));
  const next = rows[at + 1] || addTableRow(table);
  if (next.children[col]) placeCaret(next.children[col], 'start');
}

/* -- keys ----------------------------------------------------------------- */

/**
 * Enter. What it does depends on the line it is pressed in, which is the only
 * place this editor has any opinions: a sheet heading becomes a sheet, a list
 * item makes another one, an empty one steps back out.
 */
function onEditEnter(root, li) {
  const block = currentBlock(root);
  if (!block) return;

  if (block.dataset.b === 'code') {
    document.execCommand('insertText', false, '\n');
    return;
  }

  if (block.dataset.b === 'table') {
    const cell = cellOf(document.getSelection().getRangeAt(0).startContainer);
    if (cell) stepTableRow(cell);
    return;
  }

  // The line the user asked for: "# something" and Enter is a new sheet.
  if (block.dataset.b === 'sheet') { commitSheet(li, block); return; }

  const kind = block.dataset.b;
  const container = block.parentNode;
  const empty = !blockText(block).trim();

  // An empty list item or quote line steps out — one level of nesting at a
  // time, same as Shift+Tab, and only a plain paragraph once there is none
  // left to climb out of.
  if (empty && (kind === 'li' || kind === 'task' || kind === 'q')) {
    if ((kind === 'li' || kind === 'task') && outdentListItem(block)) return;
    const lifted = newBlock('p');
    parkIfEmpty(lifted);
    placeCaret(liftOut(block, lifted), 'start');
    return;
  }

  const tail = cutToEnd(block);
  let made;
  if (kind === 'li' || kind === 'task') {
    made = newBlock(kind === 'task' ? 'task' : 'li');
    container.insertBefore(made, block.nextSibling);
  } else if (kind === 'q') {
    made = newBlock('q');
    container.insertBefore(made, block.nextSibling);
  } else {
    made = newBlock('p');
    container.insertBefore(made, block.nextSibling);
  }
  made.appendChild(tail);
  parkIfEmpty(block);
  parkIfEmpty(made);
  placeCaret(made, 'start');
}

/** A block left with no child at all (Enter at the very end or very start of
 * a line) has no line box for the browser to hang a caret or a click on —
 * the CSS min-height for :empty makes it look like a line, but it is not one
 * to click into. A parked caret, same trick as completeMarker, gives it real
 * (if invisible) content; serializing drops it again. */
function parkIfEmpty(el) {
  if (!el.hasChildNodes()) el.appendChild(document.createTextNode(ZWSP));
}

/**
 * A pending heading becomes a real sheet: the text already says so, so this
 * only has to redraw the index and put the caret in the new sheet's body.
 */
function commitSheet(li, block) {
  const title = blockText(block).replace(/^#+\s*/, '').trim();
  if (!title) { placeCaret(block, 'end'); return; }
  const idx = +li.dataset.i;
  // With more than one heading waiting in this sheet, the one Enter was
  // pressed in is the nth new boundary inside it.
  const nth = Math.max(0, $$('[data-b="sheet"]', $('.prose', li)).indexOf(block));
  const openTag = Edit.tag;
  writeOpenSheet();
  inheritColumnTag(App.doc.sheets[idx + 1 + nth], openTag);
  const made = App.doc.sheets[idx + 1 + nth];
  renderBinder();
  if (made) {
    const row = sheetBySlug(made.slug);
    columnFor(made.slug);
    expand(made.slug, { scroll: true });
    const body = row && $('.prose', sheetBySlug(made.slug));
    if (body) placeCaret(body.firstElementChild || body, 'start');
  }
}

/** Backspace at the start of a line takes the line's marker off first —
 * and backspacing away the line's whole selected text takes it off too,
 * rather than leaving an empty marker (an empty task box, say) behind. */
function onEditBackspace(e, root) {
  const block = currentBlock(root);
  if (!block) return;
  const kind = block.dataset.b;
  if (kind === 'p' || kind === 'table') return;    // nothing left to undo, or nothing this simple to
  const full = selectionSpans(block);
  if (!full && !atEdge(block, 'start')) return;

  e.preventDefault();
  if (full) document.getSelection().getRangeAt(0).deleteContents();

  // A nested item steps back out one level at a time first, same as
  // Shift+Tab — only a top-level one loses its marker outright.
  if ((kind === 'li' || kind === 'task') && outdentListItem(block)) {
    touched();
    persistSheet();
    return;
  }

  const p = newBlock('p');
  while (block.firstChild) {
    const n = block.firstChild;
    if (n.dataset && n.dataset.nomd !== undefined) { n.remove(); continue; }
    p.appendChild(n);
  }
  if (kind === 'li' || kind === 'task' || kind === 'q') liftOut(block, p);
  else block.parentNode.replaceChild(p, block);
  placeCaret(p, 'start');
  touched();
  persistSheet();
}

function onEditKey(e, el, li) {
  const root = el;

  if (e.key === 'Escape') { e.preventDefault(); leaveSheet(); return; }

  // The title is one line: Enter drops into the body rather than splitting it.
  if (e.key === 'Enter' && el.dataset.role === 'title') {
    e.preventDefault();
    const body = $('.prose', li);
    if (body) placeCaret(body.firstElementChild || body, 'start');
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    touched();
    onEditEnter(root, li);
    persistSheet();
    return;
  }

  // Backspace out of the name of a sheet with nothing in it and the sheet
  // goes, rather than leaving an empty heading nothing can be done with.
  if (e.key === 'Backspace' && el.dataset.role === 'title') {
    const body = $('.prose', li);
    const bare = !el.textContent.trim() && (!body || !body.textContent.trim());
    if (bare && atEdge(el, 'start')) {
      e.preventDefault();
      deleteSheet(+li.dataset.i, { intoPrevious: true });
    }
    return;
  }

  if (e.key === 'Backspace') { onEditBackspace(e, root); return; }

  if (e.key === 'Tab') {
    e.preventDefault();
    const cell = cellOf(document.getSelection().getRangeAt(0).startContainer);
    if (cell) { touched(); stepTableCell(cell, !e.shiftKey); persistSheet(); return; }

    // Anywhere in a list item, Tab nests the whole item rather than
    // indenting text at the caret — same as every outliner's Tab does,
    // caret position within the line is not the point of pressing it.
    const block = currentBlock(root);
    if (block && (block.dataset.b === 'li' || block.dataset.b === 'task')) {
      const did = e.shiftKey ? outdentListItem(block) : indentListItem(block);
      if (did) { touched(); persistSheet(); return; }
    }

    document.execCommand('insertText', false, '  ');
    return;
  }

  // Up and down still turn the page, but only once the caret has run out of
  // sheet to move through — so the navigation survives the sheet being live.
  if (e.key === 'ArrowUp' && atEdge(root, 'start')) {
    if (el.dataset.role === 'body') {
      e.preventDefault();
      placeCaret($('.sheet-title', li), 'end');
      return;
    }
    if (stepSheet(-1)) e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown' && atEdge(root, 'end')) {
    if (el.dataset.role === 'title') {
      e.preventDefault();
      const body = $('.prose', li);
      if (body) placeCaret(body.firstElementChild || body, 'start');
      return;
    }
    if (stepSheet(1)) e.preventDefault();
  }
}

/** Move to the sheet before or after this one, caret ready to keep writing. */
function stepSheet(d) {
  writeOpenSheet();
  const list = visible();
  const at = list.findIndex((el) => el.classList.contains('is-open'));
  const to = list[at + d];
  if (at < 0 || !to) return false;
  expand(to.dataset.slug, { scroll: true });
  const body = $('.prose', to);
  if (body) placeCaret(d > 0 ? (body.firstElementChild || body)
    : (body.lastElementChild || body), d > 0 ? 'start' : 'end');
  return true;
}

/**
 * Copy and cut hand over the selection as plain text, the same way paste
 * takes it in — otherwise the caret-parking zero-width space that live
 * formatting leaves behind (see completeMarker) rides along invisibly and
 * turns up stuck in the middle of whatever the text gets pasted into.
 */
function copySelectionAsText(e) {
  const sel = document.getSelection();
  if (!sel.rangeCount) return false;
  const text = sel.getRangeAt(0).toString().split(ZWSP).join('');
  (e.clipboardData || window.clipboardData).setData('text/plain', text);
  e.preventDefault();
  return true;
}

function onEditCopy(e) { copySelectionAsText(e); }

function onEditCut(e) {
  if (copySelectionAsText(e)) document.execCommand('delete');
}

/** Pasted Markdown is the import path: take the text and let it re-render. */
function onEditPaste(e, el) {
  e.preventDefault();
  touched();
  const raw = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  if (!raw) return;

  if (!/\n/.test(raw) || el.dataset.role !== 'body') {
    document.execCommand('insertText', false, raw.replace(/\s*\n\s*/g, ' '));
    persistSheet();
    return;
  }

  // Several lines mean several blocks, and blocks are the one thing typing
  // cannot make on its own. Rather than let the browser drop its own markup
  // into the sheet, the lines go into the source between the blocks that are
  // already there, and the sheet is drawn again from it.
  const li = el.closest('.sheet');
  const tops = [...el.children].filter((c) => c.dataset.b);
  let top = currentBlock(el);
  while (top && top.parentNode !== el) top = top.parentNode;
  const at = tops.indexOf(top) < 0 ? tops.length - 1 : tops.indexOf(top);

  const out = [];
  tops.forEach((block, i) => {
    const before = out.length;
    mdBlock(block, out);
    if (out.length > before) out.push('');
    if (i === at) { raw.split('\n').forEach((l) => out.push(l)); out.push(''); }
  });
  if (!tops.length) raw.split('\n').forEach((l) => out.push(l));

  const r = replaceSheetLines(li, tidyLines(out));
  App.col = 0;                       // a pasted heading may belong elsewhere
  renderBinder();
  const landed = App.doc.sheets[r ? r.idx : 0];
  if (!landed) return;
  expand(landed.slug, { scroll: false });
  const body = $('.prose', sheetBySlug(landed.slug));
  if (body) placeCaret(body.lastElementChild || body, 'end');
}

function onEditInput(el) {
  touched();
  if (el.dataset.role === 'body') { completeBlock(el) || completeMarker(el); }
  else completeMarker(el);
  persistSheet();
}


/* -- turning a sheet on and off ------------------------------------------- */

/** Opening a sheet is all the "edit mode" there is. */
function makeEditable(li, sheet) {
  const titleEl = $('.sheet-title', li);
  const bodyEl = $('.prose', li);
  if (!titleEl || !bodyEl) return;

  if (!bodyEl.children.length) bodyEl.appendChild(newBlock('p'));
  const only = bodyEl.children.length === 1 && bodyEl.firstElementChild;
  if (only && only.dataset.b === 'p' && !only.textContent.trim()) {
    only.dataset.hint = 'Write. A line starting with # is a heading.';
  }
  titleEl.dataset.hint = 'Name this sheet';

  [[titleEl, 'title'], [bodyEl, 'body']].forEach(([el, role]) => {
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.dataset.role = role;
    el.addEventListener('input', () => onEditInput(el));
    el.addEventListener('keydown', (e) => onEditKey(e, el, li));
    el.addEventListener('copy', onEditCopy);
    el.addEventListener('cut', onEditCut);
    el.addEventListener('paste', (e) => onEditPaste(e, el));
    el.addEventListener('blur', () => { if (writeOpenSheet()) { renderTagRail(); refreshBell(); } });
  });
}

/** Esc: stop writing, put the sheet back in the index, navigation returns. */
function leaveSheet() {
  const r = writeOpenSheet();
  const slug = App.open;
  collapse();
  if (r && r.split) { renderBinder(); }
  const li = slug && sheetBySlug(slug);
  if (li) setCursor(visible().indexOf(li), { scroll: true });
  renderTagRail();
  scheduleReminders();
  refreshBell();
  $('#stage').focus({ preventScroll: true });
}


/* -- lead & trail: text with no sheet of its own ---------------------------
   Before the first heading, and after the last one, text is still just
   text — it only lacks a name and a tag (spec 2, 4). Both are edited with
   the same block rules and the same serializer as a sheet's own body, so
   typing "# " here is still the only way a sheet is born; there is no
   separate "new sheet" control to click instead.
   Surface: fillRegion(kind, lines), commitRegions().                       */

/* Neither region has a heading of its own to re-locate by, so — like an open
   sheet's own from/to — each one's range has to be remembered rather than
   looked up fresh on every commit. Looking it up fresh is exactly the bug
   this replaced: once lead has written its own first line of a sheet, that
   sheet *is* App.doc.sheets[0], so re-deriving "up to the first sheet" from
   App.doc next keystroke collapses to zero width and the following commit
   inserts a second sheet beside the first instead of finishing it. Same
   failure at the other end for trail, whichever sheet just became the last. */
const RegionEdit = { lead: { from: -1, to: -1 }, trail: { from: -1, to: -1 } };

/** Where this region's own lines currently live in the raw text. */
function regionRange(kind) {
  const r = RegionEdit[kind];
  if (r.from < 0) {
    const lines = getBinder(App.binderId).text.split('\n');
    if (kind === 'lead') {
      const first = App.doc.sheets[0];
      r.from = 0; r.to = first ? first.line : lines.length;
    } else {
      r.from = r.to = lines.length;
    }
  }
  return { from: r.from, to: r.to };
}

/** Write this region's DOM back into its own range, and nowhere else. */
function commitRegion(kind) {
  const el = $('#' + kind);
  const b = getBinder(App.binderId);
  if (!el || !b || !App.doc) return false;
  const { from, to } = regionRange(kind);
  const bodyLines = serializeBody(el);
  const lines = b.text.split('\n');
  const block = bodyLines.length ? [...bodyLines, ''] : [];
  // No tidyLines here: it could trim a trailing blank line, and then the
  // remembered range above would run short of what is actually on disk.
  const text = [...lines.slice(0, from), ...block, ...lines.slice(to)].join('\n');
  RegionEdit[kind].to = from + block.length;
  if (text === b.text) return false;
  writeBinder(b, text);
  App.doc = parse(b.text);
  return true;
}

/** Called before anything reads App.doc to decide what the screen shows. */
function commitRegions() {
  commitRegion('lead');
  commitRegion('trail');
}

const persistRegion = debounce((kind) => {
  if (!commitRegion(kind)) return;
  const el = $('#' + kind);
  // A heading still being typed is already a sheet in the text but not yet a
  // row on screen (see persistSheet) — the rail waits for the same reason.
  if (!el || !$('[data-b="sheet"]', el)) renderTagRail();
}, 300);

/** A heading typed here is a real sheet the moment Enter closes it — the
 * same instant it would become one inside an open sheet's body. */
function commitPendingSheet(el, kind, block) {
  const title = blockText(block).replace(/^#+\s*/, '').trim();
  if (!title) { placeCaret(block, 'end'); return; }
  commitRegion(kind);
  const made = kind === 'lead' ? App.doc.sheets[0] : App.doc.sheets[App.doc.sheets.length - 1];
  if (!made) return;
  const slug = made.slug;
  inheritColumnTag(made);
  renderBinder();
  columnFor(slug);
  expand(slug, { scroll: true });
  const body = $('.prose', sheetBySlug(slug));
  if (body) placeCaret(body.firstElementChild || body, 'start');
}

function onRegionKey(e, el, kind) {
  if (e.key === 'Escape') { e.preventDefault(); el.blur(); return; }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const block = currentBlock(el);
    if (block && block.dataset.b === 'sheet') { commitPendingSheet(el, kind, block); return; }
    onEditEnter(el, null);
    persistRegion(kind);
    return;
  }
  if (e.key === 'Backspace') { onEditBackspace(e, el); persistRegion(kind); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const block = currentBlock(el);
    if (block && (block.dataset.b === 'li' || block.dataset.b === 'task')) {
      const did = e.shiftKey ? outdentListItem(block) : indentListItem(block);
      if (did) { persistRegion(kind); return; }
    }
    document.execCommand('insertText', false, '  ');
  }
}

/** Pasted Markdown lands in the region's own source, same as inside a sheet. */
function onRegionPaste(e, el, kind) {
  e.preventDefault();
  const raw = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  if (!raw) return;
  if (!/\n/.test(raw)) {
    document.execCommand('insertText', false, raw.replace(/\s*\n\s*/g, ' '));
    persistRegion(kind);
    return;
  }

  const tops = [...el.children].filter((c) => c.dataset.b);
  let top = currentBlock(el);
  while (top && top.parentNode !== el) top = top.parentNode;
  const at = tops.indexOf(top) < 0 ? tops.length - 1 : tops.indexOf(top);

  const out = [];
  tops.forEach((block, i) => {
    const before = out.length;
    mdBlock(block, out);
    if (out.length > before) out.push('');
    if (i === at) { raw.split('\n').forEach((l) => out.push(l)); out.push(''); }
  });
  if (!tops.length) raw.split('\n').forEach((l) => out.push(l));

  const { from, to } = regionRange(kind);
  const b = getBinder(App.binderId);
  const lines = b.text.split('\n');
  const text = tidyLines([...lines.slice(0, from), ...tidyLines(out), '', ...lines.slice(to)]).join('\n');
  writeBinder(b, text);
  App.doc = parse(b.text);
  renderBinder();
  const el2 = $('#' + kind);
  if (el2) placeCaret(el2, kind === 'lead' ? 'start' : 'end');
}

function wireRegion(el, kind) {
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.dataset.role = 'region';
  wireProse(el, () => commitRegion(kind));
  el.addEventListener('focus', () => { if (App.open) collapse(); });
  el.addEventListener('input', () => { completeBlock(el) || completeMarker(el); persistRegion(kind); });
  el.addEventListener('keydown', (e) => onRegionKey(e, el, kind));
  el.addEventListener('copy', onEditCopy);
  el.addEventListener('cut', onEditCut);
  el.addEventListener('paste', (e) => onRegionPaste(e, el, kind));
  // Leaving mid-heading finishes it, same as Enter would — but that redraws
  // the whole index, and doing that synchronously on blur can eat a click
  // already headed for a different row, so it waits a tick.
  el.addEventListener('blur', () => {
    const hadPendingSheet = !!$('[data-b="sheet"]', el);
    if (!commitRegion(kind)) return;
    if (hadPendingSheet) { setTimeout(renderBinder, 0); return; }
    // Plain text just committed into the tail of the last sheet (or, for
    // lead, is already showing correctly where it stands) — trail resets so
    // the same words are not also left sitting below the index.
    if (kind === 'trail') fillRegion('trail', []);
  });
}

/** Fill a region from its own lines and make it as editable as a sheet body. */
function fillRegion(kind, lines) {
  const el = $('#' + kind);
  if (!el) return;
  el.innerHTML = renderBody({ line: -1, lines }) || '';
  if (!el.children.length) el.appendChild(newBlock('p'));
  const only = el.children.length === 1 && el.firstElementChild;
  if (only && only.dataset.b === 'p' && !only.textContent.trim() && kind === 'trail') {
    only.dataset.hint = 'Write more, or start a line with # for a new sheet.';
  }
  // A fresh render is the one point where this region's range is allowed to
  // be looked up again — regionRange recomputes it once, on first use, then
  // remembers it through every commit until the next fresh render.
  RegionEdit[kind].from = RegionEdit[kind].to = -1;
  wireRegion(el, kind);
}


/* == CHROME RENDERING ===================================================== */

function renderChrome() {
  const inBinder = App.view === 'binder';
  const b = inBinder ? getBinder(App.binderId) : null;
  $('#crumb-sep').hidden = !inBinder;
  const crumb = $('#crumb-binder');
  crumb.hidden = !inBinder;
  if (b) crumb.textContent = b.title;
  document.title = b ? b.title + ' — Txtr' : 'Txtr';
  refreshBell();
}


/* == 10. PALETTE ==========================================================
   Find, ask and speak on one surface (spec 12, 13, 14). It is a navigation
   surface first: typing filters, Enter goes there, Tab turns the same words
   into a question.                                                         */

const Pal = { open: false, mode: 'find', items: [], sel: 0 };

function openPalette(prefill = '') {
  Pal.open = true;
  Pal.mode = 'find';
  $('#palette').hidden = false;
  $('#term-scope').textContent = App.view === 'binder'
    ? getBinder(App.binderId).title : 'All Binders';
  const input = $('#term-input');
  input.value = prefill;
  input.focus();
  input.select();
  runPalette();
}

function closePalette() {
  Pal.open = false;
  $('#palette').hidden = true;
  stopListening();
  $('#stage').focus({ preventScroll: true });
}

function setMode(mode) {
  Pal.mode = mode;
  $('#term-mode').textContent = mode === 'ask' ? 'Ask' : 'Find';
  $('#term-input').placeholder = mode === 'ask'
    ? 'Ask about your own text, or say "add a sheet about..."'
    : 'Find a sheet, or ask a question';
}

/** Everything searchable, built from the text on demand — no search index. */
function corpus() {
  const rows = [];
  DB.binders.forEach((b) => {
    const doc = parse(b.text);
    rows.push({ kind: 'binder', binder: b, title: b.title, text: b.title, href: linkTo(b.id) });
    doc.tags.forEach((t) => rows.push({
      kind: 'tag', binder: b, title: '#' + t, text: t,
      href: linkTo(b.id), tag: t,
    }));
    doc.sheets.forEach((c) => {
      rows.push({
        kind: 'sheet', binder: b, sheet: c, title: c.title,
        text: c.title + ' ' + (c.tag || ''), href: linkTo(b.id, c.slug),
      });
      c.lines.forEach((l) => {
        const t = l.trim();
        if (t.length > 2) rows.push({
          kind: 'text', binder: b, sheet: c, title: t, text: t,
          href: linkTo(b.id, c.slug),
        });
      });
    });
  });
  return rows;
}

/**
 * The query as words. Punctuation is not worth matching on, and neither is a
 * stray single letter left behind by it — "R$25" is a search for 25, not for
 * every line with an r in it. A query that is only one letter keeps it, so
 * typing the first letter of a title still filters.
 */
function terms(q) {
  const all = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const long = all.filter((w) => w.length > 1);
  return long.length ? long : all;
}

const rxEsc = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How well one row answers the query. Every word that appears scores on its
 * own, so getting a word wrong — "Cards are just headings" — still finds the
 * sheet that has the rest of it. Rows carrying every word always outrank
 * partial ones, the original phrasing outranks the same words scattered, and
 * a long word counts for more than a short common one.
 */
function score(row, words, q) {
  const hay = row.text.toLowerCase();
  let hits = 0, s = 0;
  words.forEach((w) => {
    const i = hay.indexOf(w);
    if (i < 0) return;
    hits++;
    s += 6 * w.length + Math.max(0, 40 - i);
    if (i === 0 || /[^\p{L}\p{N}]/u.test(hay[i - 1])) s += 12;   // at a word start
  });
  // Half the words, rounded up: a four-word query should not turn up rows that
  // only share "are" with it, but a one or two word query stays as open as it
  // was. Rows with every word still win outright, just below.
  if (!hits || hits < Math.ceil(words.length / 2)) return 0;
  s += 80 * hits;
  if (hits === words.length) s += 240;           // everything asked for is here
  if (hay.includes(q)) s += 120;                 // and in the order it was typed
  if (row.kind === 'sheet') s += 60;
  if (row.kind === 'binder') s += 40;
  if (row.kind === 'tag') s += 30;
  if (row.binder.id === App.binderId) s += 25;   // where you already are wins
  return s;
}

function runPalette() {
  const q = $('#term-input').value.trim();
  const looksLikeQuestion = /\?\s*$/.test(q) ||
    /^(what|who|when|where|why|how|did|do|does|is|are|should|can|add|remind|show)\b/i.test(q);
  if (Pal.mode !== 'ask') setMode('find');
  $('#term-mode').textContent = Pal.mode === 'ask' ? 'Ask'
    : (looksLikeQuestion && q ? 'Find — Tab to ask' : 'Find');

  if (Pal.mode === 'ask') return;

  const results = $('#results');
  if (!q) {
    // With an empty field the palette is a table of contents.
    Pal.items = corpus().filter((r) => r.kind === 'sheet' || r.kind === 'binder')
      .filter((r) => App.view !== 'binder' || r.binder.id === App.binderId ||
        r.kind === 'binder').slice(0, 10);
  } else {
    const words = terms(q);
    Pal.items = corpus().map((r) => ({ r, s: score(r, words, q.toLowerCase()) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 14).map((x) => x.r);
  }
  Pal.sel = 0;
  results.innerHTML = Pal.items.length
    ? renderResults(Pal.items, terms(q))
    : '<div class="res-group">Nothing matches. Press Tab to ask instead.</div>';
  wireResults();
}

const KIND_LABEL = { sheet: 'Sheet', text: 'Text', tag: 'Tag', binder: 'Binder' };

function renderResults(items, words) {
  let html = '', lastKind = null;
  items.forEach((r, i) => {
    if (r.kind !== lastKind) {
      html += '<div class="res-group">' + KIND_LABEL[r.kind] + '</div>';
      lastKind = r.kind;
    }
    const where = r.kind === 'binder' ? ago(r.binder.updated)
      : (r.sheet ? r.binder.title + ' · #' + r.sheet.slug : r.binder.title);
    html += '<button class="res' + (i === 0 ? ' is-sel' : '') + '" data-i="' + i + '">' +
      '<span class="res-main">' + highlight(r.title, words) + '</span>' +
      '<span class="res-sub">' + esc(where) + '</span></button>';
  });
  return html;
}

/** Mark every query word that is in the text, so why a row matched is visible. */
function highlight(text, words) {
  const raw = text.replace(/^[#>\s-]+/, '');
  if (!words.length) return esc(raw);
  // Longest word first, so "headings" claims the match before "heading" can.
  const rx = new RegExp('(' + words.slice().sort((a, b) => b.length - a.length)
    .map(rxEsc).join('|') + ')', 'gi');
  // Split on the matches and escape each piece separately: escaping around the
  // marks rather than inside them keeps a query like "amp" out of the middle of
  // an entity this function just wrote.
  return raw.split(rx)
    .map((part, i) => (i % 2 ? '<mark>' + esc(part) + '</mark>' : esc(part)))
    .join('');
}

function wireResults() {
  $$('#results .res').forEach((el) => {
    el.addEventListener('mouseenter', () => selectResult(+el.dataset.i));
    el.addEventListener('click', () => openResult(Pal.items[+el.dataset.i]));
  });
}

function selectResult(i) {
  const els = $$('#results .res');
  if (!els.length) return;
  Pal.sel = (i + els.length) % els.length;
  els.forEach((el, n) => el.classList.toggle('is-sel', n === Pal.sel));
  els[Pal.sel].scrollIntoView({ block: 'nearest' });
}

function openResult(r) {
  if (!r) return;
  closePalette();
  navigate(r.href);
  if (r.kind === 'tag') setTimeout(() => openColumn(r.tag), 60);
}


/* == 11. ANSWERS ==========================================================
   The answer comes out of the user's own Binders, on this device: retrieval
   over the text, not a second place for information to live (spec 13). When
   the browser ships an on-device model (Chrome's `LanguageModel`, i.e.
   Gemini Nano) it writes the actual sentence, still grounded only in the
   retrieved excerpts and still never leaving the device; without it, or if
   it fails, the plain keyword extraction below is the whole answer.
   Voice and typing arrive here the same way, and two phrasings are commands
   instead of questions, because "add a sheet about X" should add a sheet.     */

const STOP = new Set(('the a an of to in on for and or is are was were do does did what who when ' +
  'where why how about with that this it we i you my our should can could about').split(' '));

// Bumped on every ask() call so a slow on-device reply from an earlier,
// already-abandoned question can't clobber the palette after a newer one.
let askToken = 0;

async function ask(q) {
  const results = $('#results');
  const token = ++askToken;

  const add = /^(?:add|create|new)\s+(?:a\s+)?sheet\s*(?:about|for|called|titled|on)?\s*[:,-]?\s*(.+)$/i.exec(q);
  if (add) return commandAddSheet(add[1]);

  const rem = /^remind\s+me\s+(.+)$/i.exec(q);
  if (rem) return commandRemind(rem[1]);

  const terms = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  if (!terms.length) {
    results.innerHTML = '<div class="answer"><p class="answer-body">Ask about something in your text — a decision, a name, a number.</p></div>';
    return;
  }

  // Ask stays inside whatever Find already scoped to (spec 13's "your own
  // Binders" means the one you're standing in when you're in one, same as
  // the palette's own "SAVII INVOICES" vs "All Binders" label promises) —
  // otherwise an open question can get answered from some other Binder
  // entirely and there is no way to tell where that answer even came from.
  const inBinder = App.view === 'binder';
  const scope = inBinder ? [getBinder(App.binderId)].filter(Boolean) : DB.binders;

  // Rank sheets by how much of the question they actually contain.
  const hits = [];
  scope.forEach((b) => {
    parse(b.text).sheets.forEach((c) => {
      const body = c.lines.join(' ');
      const hay = (c.title + ' ' + body + ' ' + (c.tag || '')).toLowerCase();
      let s = 0;
      terms.forEach((t) => {
        const n = hay.split(t).length - 1;
        if (n) s += 10 + Math.min(n, 4) * 2;
        if (c.title.toLowerCase().includes(t)) s += 25;
      });
      if (s) hits.push({ b, c, s, body });
    });
  });
  hits.sort((x, y) => y.s - x.s);

  if (!hits.length) {
    results.innerHTML = '<div class="answer">' +
      '<p class="answer-body">Nothing in ' + (inBinder ? 'this Binder' : 'your Binders') + ' mentions that yet.</p>' +
      '<p class="answer-note">Searched ' + (inBinder ? esc(scope[0].title)
        : DB.binders.length + (DB.binders.length === 1 ? ' Binder' : ' Binders')) + ' on this device</p></div>';
    return;
  }

  const top = hits.slice(0, 3); // shown as "Go to" links below the answer
  const state = await onDeviceModelState();

  if (state === 'available') {
    results.innerHTML = '<div class="answer"><p class="answer-body answer-note">Thinking on-device…</p></div>';
    // The model gets a wider slice than the "Go to" list shows — more
    // material to actually find the answer in, without cluttering the nav.
    const reply = await answerOnDevice(q, hits.slice(0, 6), terms);
    // Bail if a newer question was asked, or the user left ask mode, meanwhile.
    if (token !== askToken || Pal.mode !== 'ask') return;
    if (reply) return renderAnswer(top, reply, terms, 'On-device AI · from your own text');
  }

  if (token !== askToken || Pal.mode !== 'ask') return;
  // "downloadable"/"downloading" fall through to the keyword answer instead
  // of stalling this question on a multi-minute model fetch — but say so,
  // so the fallback doesn't quietly look identical to "AI isn't coming".
  renderAnswer(top, null, terms, state === 'downloadable' || state === 'downloading'
    ? 'From your own text, on this device' + onDeviceDownloadSuffix(state)
    : 'From your own text, on this device');
}

/**
 * "available" | "downloadable" | "downloading" | "unavailable" — the last one
 * covering both an old browser with no LanguageModel at all and a real
 * "no" from the API (unsupported hardware/OS, no space, etc). Read-only:
 * this alone never triggers a download — see touchOnDeviceModel() for why
 * that has to happen elsewhere.
 */
async function onDeviceModelState() {
  if (typeof LanguageModel === 'undefined') return 'unavailable';
  try {
    return await LanguageModel.availability();
  } catch {
    return 'unavailable';
  }
}

// Once actual download progress has been observed, say how far along it is —
// "downloading" with no number yet just means it hasn't been asked to start.
let downloadProgress = null;

function onDeviceDownloadSuffix(state) {
  if (downloadProgress != null) return ' — downloading on-device AI (' + Math.round(downloadProgress * 100) + '%)';
  return state === 'downloading' ? ' — downloading on-device AI' : ' — on-device AI available soon, ask again later';
}

// Only ever kick off one download per page load — repeated asks while it's
// still "downloadable" shouldn't each start their own fetch of the model.
let warmingOnDeviceModel = false;

/**
 * Starts the one-time model download, if there is one to start. This has to
 * be called synchronously from inside a real, trusted key/click handler —
 * NOT after an `await` — because Chrome requires a fresh user gesture to
 * begin downloading Gemini Nano and that gesture expires the moment control
 * returns to the event loop. (LanguageModel.create() throws NotAllowedError
 * otherwise, silently leaving the model stuck on "downloadable" forever.)
 */
function touchOnDeviceModel() {
  if (typeof LanguageModel === 'undefined' || warmingOnDeviceModel) return;
  warmingOnDeviceModel = true;
  LanguageModel.create({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => { downloadProgress = e.loaded; });
    },
  }).then((s) => s.destroy()).catch((err) => {
    // Already available (nothing to download) and "no gesture" both land
    // here too, not just real failures — so this isn't logged as an error,
    // and the flag resets so the next keypress gets another try.
    warmingOnDeviceModel = false;
  });
}

/**
 * The lines of a sheet that actually carry the question's words, not just
 * however much of the sheet the first N characters happen to cover — a long
 * sheet (a table of invoices, say) can bury the one relevant line well past
 * any fixed cutoff otherwise. Falls back to the sheet's own start when none
 * of its lines individually match (it was still ranked a hit some other
 * way — e.g. its title), so there's always something to hand the model.
 */
function relevantLines(lines, terms, maxChars) {
  const scored = lines
    .map((l, i) => ({ i, l: l.trim() }))
    .filter((x) => x.l.length > 1)
    .map((x) => ({
      ...x,
      score: terms.reduce((acc, t) => acc + (x.l.toLowerCase().includes(t) ? 1 : 0), 0),
    }));
  const pool = (scored.some((x) => x.score) ? scored.filter((x) => x.score) : scored)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const x of pool) {
    if (used && used + x.l.length + 1 > maxChars) break;
    picked.push(x);
    used += x.l.length + 1;
  }
  // Back to document order so the model reads a coherent passage, not
  // whichever lines happened to score highest in whatever order that was.
  return picked.sort((a, b) => a.i - b.i).map((x) => x.l).join('\n');
}

/** Ask Gemini Nano, grounded only in the retrieved notes. Null on any
 * failure (model missing, quota, no user activation yet, …) so the caller
 * always has the keyword answer to fall back to. */
async function answerOnDevice(q, hits, terms) {
  const context = hits
    .map((h, i) => '[' + (i + 1) + '] ' + h.c.title + '\n' + relevantLines(h.c.lines, terms, 900))
    .join('\n\n');
  let session;
  try {
    session = await LanguageModel.create({
      initialPrompts: [{
        role: 'system',
        content: 'The notes below are from the user\'s own Binder. Answer the question using only ' +
          "what's in them, in 1-3 short sentences, as if you already knew it — don't mention " +
          '"notes" or how this information was given to you. If they don\'t say, say plainly that ' +
          "it isn't written down anywhere, without guessing.\n\n" + context,
      }],
    });
    return (await session.prompt(q)).trim() || null;
  } catch (err) {
    console.error('On-device AI answer failed, falling back to keyword search:', err);
    return null;
  } finally {
    if (session) session.destroy();
  }
}

/** Shared renderer for both the on-device answer and the keyword fallback.
 * `reply` is the model's prose, or null to fall back to extracted quotes. */
function renderAnswer(top, reply, questionTerms, note) {
  const results = $('#results');
  const body = reply
    ? reply.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
      .map((p) => '<p>' + p.split('\n').map(inline).join('<br>') + '</p>').join('')
    : (() => {
      const passages = top.map((h) => bestSentence(h.body || h.c.title, questionTerms)).filter(Boolean);
      return '<p>' + esc(top[0].c.title) + ' is where your text answers this:</p>' +
        passages.map((p) => '<blockquote class="answer-quote">' + inline(p) + '</blockquote>').join('');
    })();

  Pal.items = top.map((h) => ({
    kind: 'sheet', binder: h.b, sheet: h.c, title: h.c.title,
    href: linkTo(h.b.id, h.c.slug),
  }));

  results.innerHTML = '<div class="answer">' +
      '<div class="answer-body">' + body + '</div>' +
      '<p class="answer-note">' + esc(note) + '</p>' +
    '</div>' +
    '<div class="res-group">Go to</div>' +
    top.map((h, i) => '<button class="res' + (i === 0 ? ' is-sel' : '') + '" data-i="' + i + '">' +
      '<span class="res-main">' + esc(h.c.title) + '</span>' +
      '<span class="res-sub">' + esc(h.b.title) + ' · #' + esc(h.c.slug) + '</span></button>').join('');
  Pal.sel = 0;
  wireResults();
}

/** The sentence in a sheet that carries the most of the question. */
function bestSentence(text, terms) {
  const sentences = text.replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s*[|]\s*/).map((s) => s.trim())
    .filter((s) => s.length > 12 && !/^[#>`-]/.test(s));
  if (!sentences.length) return null;
  let best = null, bestScore = 0;
  sentences.forEach((s) => {
    const low = s.toLowerCase();
    const n = terms.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0);
    if (n > bestScore) { bestScore = n; best = s; }
  });
  return best || sentences[0];
}

/** Voice and typing both land here: speech becomes text becomes a sheet. */
function commandAddSheet(rest) {
  let binder = getBinder(App.binderId);
  if (!binder) binder = DB.binders[0] || newBinder('Notes');

  // "pricing. we decided on R$25" -> title is the first clause, body the rest.
  const split = rest.match(/^([^.:;\n]{2,60})(?:[.:;]\s*(.+))?$/s);
  const title = (split ? split[1] : rest).trim().replace(/\s+/g, ' ');
  const body = split && split[2] ? split[2].trim() : '';
  const text = binder.text.replace(/\s*$/, '') +
    '\n\n# ' + title.charAt(0).toUpperCase() + title.slice(1) + '\n\n' + body + '\n';
  writeBinder(binder, text);

  closePalette();
  const slug = parse(text).sheets.slice(-1)[0].slug;
  go(linkTo(binder.id, slug));
  toast('Sheet added');
}

function commandRemind(rest) {
  const binder = getBinder(App.binderId) || DB.binders[0];
  if (!binder) return toast('Start a Binder first');
  const when = parseWhen(rest.replace(/^(to|about)\s+/i, ''));
  if (!when) {
    toast('Try "remind me tomorrow 10:00 to call Joao"');
    return;
  }
  const doc = parse(binder.text);
  let sheet = doc.sheets.find((c) => /reminder/i.test(c.title));
  let text = binder.text.replace(/\s*$/, '');
  const line = '! ' + rest.replace(/^(to|about)\s+/i, '');
  if (sheet) {
    const lines = text.split('\n');
    lines.splice(sheet.line + 1 + sheet.lines.length, 0, line);
    text = lines.join('\n');
  } else {
    text += '\n\n# Reminders\n\n' + line + '\n';
  }
  writeBinder(binder, text);
  closePalette();
  App.doc = parse(binder.text);
  go(linkTo(binder.id, parse(binder.text).sheets.find((c) => /reminder/i.test(c.title)).slug));
  askNotificationPermission();
  scheduleReminders();
  toast('Reminder set for ' + when.label);
}


/* == VOICE ================================================================
   The microphone is an input method, not a mode (spec 14). Where the browser
   has no speech recognition the button says so and nothing else changes.    */

let recognizer = null;

function startListening() {
  const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Impl) { toast('This browser has no speech input'); return; }
  touchOnDeviceModel(); // a spoken question ends up in ask() same as a typed one
  stopListening();
  recognizer = new Impl();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;

  const input = $('#term-input');
  $('#mic').classList.add('is-live');
  setMode('ask');

  recognizer.onresult = (e) => {
    input.value = [...e.results].map((r) => r[0].transcript).join(' ').trim();
    if (e.results[e.results.length - 1].isFinal) ask(input.value.trim());
  };
  recognizer.onerror = () => { toast('Could not hear that'); stopListening(); };
  recognizer.onend = () => stopListening();
  recognizer.start();
}

function stopListening() {
  $('#mic').classList.remove('is-live');
  if (recognizer) { try { recognizer.abort(); } catch (e) {} recognizer = null; }
}


/* == 12. REMINDERS ========================================================
   A reminder is a line of text with a time in it (spec 19). Timers exist
   only while the app is open; the text is the record.                       */

let timers = [];

function allReminders() {
  const out = [];
  DB.binders.forEach((b) => {
    parse(b.text).sheets.forEach((c) => {
      c.reminders.forEach((r) => out.push({
        ...r, binderId: b.id, binderTitle: b.title, slug: c.slug, sheet: c.title,
        key: b.id + '/' + c.slug + '/' + r.at + '/' + r.text.slice(0, 24),
      }));
    });
  });
  return out.sort((a, b) => a.at - b.at);
}

function scheduleReminders() {
  timers.forEach(clearTimeout);
  timers = [];
  const now = Date.now();
  allReminders().forEach((r) => {
    const wait = r.at - now;
    if (wait <= 0 || wait > 6 * 3600e3 || DB.fired[r.key]) return;
    timers.push(setTimeout(() => fireReminder(r), wait));
  });
}

function fireReminder(r) {
  DB.fired[r.key] = true;
  saveDB();
  const body = r.text + ' — ' + r.binderTitle;
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification(r.sheet, { body, tag: r.key });
    n.onclick = () => { window.focus(); go(linkTo(r.binderId, r.slug)); };
  } else {
    toast(r.text);
  }
  refreshBell();
}

function askNotificationPermission() {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
}


/* == 13. NOTIFICATIONS ====================================================
   The bell exists only when there is something to say (spec 18).           */

function pendingNotifications() {
  const out = [];
  allReminders().forEach((r) => {
    if (r.at <= Date.now() && r.at > DB.seen) out.push({
      kind: 'reminder', text: r.text || r.sheet, when: r.label,
      where: r.binderTitle + ' · #' + r.slug, href: linkTo(r.binderId, r.slug), at: r.at,
    });
  });
  DB.binders.forEach((b) => {
    if (b.updated <= DB.seen) return;
    parse(b.text).sheets.forEach((c) => {
      if (!c.mentions.some((m) => m.toLowerCase() === String(DB.identity).toLowerCase())) return;
      out.push({
        kind: 'mention', text: 'You are mentioned in ' + c.title,
        when: ago(b.updated), where: b.title + ' · #' + c.slug,
        href: linkTo(b.id, c.slug), at: b.updated,
      });
    });
  });
  return out.sort((a, b) => b.at - a.at).slice(0, 12);
}

function refreshBell() {
  const list = pendingNotifications();
  const bell = $('#bell');
  bell.hidden = list.length === 0;
  bell.classList.toggle('is-live', list.length > 0);
  bell.setAttribute('aria-label', list.length + ' notifications');
  if (!list.length) $('#notifs').hidden = true;
}

function toggleNotifications() {
  const panel = $('#notifs');
  if (!panel.hidden) { panel.hidden = true; return; }
  const list = pendingNotifications();
  // Three columns across the bar: what kind, what it says, where and when.
  panel.innerHTML = list.map((n, i) =>
    '<button class="notif" data-i="' + i + '">' +
      '<span class="notif-kind' + (n.kind === 'mention' ? ' is-mention' : '') + '">' +
        (n.kind === 'mention' ? 'Mention' : 'Reminder') + '</span>' +
      '<span class="notif-text">' + esc(n.text) + '</span>' +
      '<span class="notif-where">' + esc(n.where) + ' · ' + esc(n.when) + '</span>' +
    '</button>').join('') +
    '<button class="notif" data-clear="1"><span class="notif-kind">Clear all</span></button>';
  panel.hidden = false;

  $$('.notif', panel).forEach((el) => el.addEventListener('click', () => {
    panel.hidden = true;
    if (el.dataset.clear) { DB.seen = Date.now(); saveDB(); refreshBell(); return; }
    go(list[+el.dataset.i].href);
  }));
}


/* == 14. EXPORT & PRINT ===================================================
   A Binder can leave as a single HTML file that needs nothing from Txtr:
   readable, printable, offline, and still holding its own source text so it
   can come back in (spec 21). Print uses the browser (spec 20).             */

const EXPORT_CSS = [
  ':root{color-scheme:dark;--ink:#16161f;--fg:#d5def5;--dim:#5b6488;--line:#2b2d42;--cyan:#7dcfff;--mag:#bb9af7;--blue:#7aa2f7;--orange:#ff9e64}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--ink);color:var(--fg);font:400 1.0625rem/1.7 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,sans-serif;letter-spacing:-.005em;padding:5rem 1.5rem 30vh}',
  'body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(60rem 40rem at 12% -10%,rgba(125,207,255,.10),transparent 70%),radial-gradient(55rem 38rem at 92% 108%,rgba(187,154,247,.09),transparent 70%)}',
  '.wrap{max-width:36rem;margin:0 auto;position:relative}',
  'h1{font-size:.6875rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 3.5rem}',
  'details{border-top:1px solid var(--line)}',
  'details:last-of-type{border-bottom:1px solid var(--line)}',
  'summary{cursor:pointer;padding:1.15rem 0;list-style:none;display:flex;align-items:baseline;justify-content:space-between;gap:1.25rem}',
  'summary::-webkit-details-marker{display:none}',
  'summary h2{font-size:1.5rem;font-weight:300;letter-spacing:-.022em;margin:0}',
  'summary:hover h2{color:var(--cyan)}',
  'details[open] summary h2{color:var(--cyan);text-shadow:0 0 18px rgba(125,207,255,.45)}',
  '.tag{flex:0 0 auto;font-size:.625rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--mag);background:rgba(187,154,247,.10);border:1px solid rgba(187,154,247,.28);border-radius:999px;padding:.3em .7em .26em;white-space:nowrap}',
  '.body{padding:0 0 3rem}',
  'a{color:var(--blue)}',
  'code{font:.8125em ui-monospace,Menlo,monospace;color:var(--cyan);background:#1d1e2b;border:1px solid var(--line);border-radius:5px;padding:.12em .38em}',
  'pre{font:.8125rem/1.75 ui-monospace,Menlo,monospace;background:rgba(10,10,16,.6);border:1px solid var(--line);border-left:2px solid var(--mag);border-radius:8px;padding:1.1rem;overflow-x:auto}',
  'pre code{border:0;background:none;color:#98a0c4;padding:0}',
  'h3{font-size:.75rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--cyan);margin:2.75em 0 1em}',
  'blockquote.quote{margin:1.85em 0;padding-left:1.35rem;border-left:2px solid var(--line);color:#98a0c4}',
  '.reply{border-left:2px solid var(--mag);padding-left:1.35rem;margin:-1.85em 0 1.85em}',
  '.reply-who{display:block;font-size:.625rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}',
  '.reminder{display:flex;gap:.85rem;font-size:.8125rem;color:var(--orange);border-left:2px solid var(--orange);background:linear-gradient(90deg,rgba(255,158,100,.10),transparent 70%);border-radius:0 8px 8px 0;padding:.7rem 1rem;margin:1.6em 0}',
  '.mention{color:var(--blue)}',
  '.task{list-style:none;margin-left:-1.35em}.task-box{font-family:ui-monospace,Menlo,monospace;font-size:.8125em;color:var(--dim);margin-right:.55em}',
  'hr{border:0;border-top:1px solid var(--line);margin:2.75em 0}',
  'footer{margin-top:4.5rem;font-size:.625rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--line)}',
  '@media print{body{background:#fff;color:#111;padding:0}body::before{display:none}details{border:0}.tag{display:none}',
  'details>.body{display:block!important}summary h2{font-size:19pt;font-weight:600;color:#111;text-shadow:none}pre,code{background:#f4f4f7;border-color:#ddd;color:#111}}',
].join('');

function buildExport(b) {
  const doc = parse(b.text);
  const sheets = doc.sheets.map((c) => {
    const tag = c.tag ? '<span class="tag">' + esc(c.tag) + '</span>' : '';
    return '<details id="' + esc(c.slug) + '">' +
      '<summary><h2>' + esc(c.title) + '</h2>' + tag + '</summary>' +
      '<div class="body">' + renderBody(c, { static: true }) + '</div></details>';
  }).join('\n');

  const lead = doc.lead.join('').trim()
    ? '<div class="body">' + renderBody({ line: -1, lines: doc.lead }, { static: true }) + '</div>' : '';

  // The source travels with the file, so this export can be pasted or
  // imported straight back into Txtr without losing anything.
  const source = b.text.replace(/<\/(script)/gi, '<\\/$1');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(b.title) + '</title><meta name="color-scheme" content="dark">' +
    '<style>' + EXPORT_CSS + '</style></head><body><div class="wrap">' +
    '<h1>' + esc(b.title) + '</h1>' + lead + sheets +
    '<footer>Binder saved ' + new Date().toLocaleString() + ' &middot; open, print or email this file</footer>' +
    '</div>' +
    '<script type="text/markdown" id="binder-source">' + source + '</' + 'script>' +
    '<script>document.addEventListener("DOMContentLoaded",function(){' +
    'var id=location.hash.slice(1);if(!id)return;var d=document.getElementById(id);' +
    'if(d){d.open=true;d.scrollIntoView();}});</' + 'script>' +
    '</body></html>';
}

function exportBinder(b) {
  if (!b) return;
  const blob = new Blob([buildExport(b)], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slugify(b.title) + '.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved ' + a.download);
}

/** The whole Binder, as the plain text it already is, on the clipboard —
 * paste it into any other editor and nothing is lost (spec 22). */
function copyBinderText(b) {
  if (!b) return;
  const text = b.text.trim() + '\n';
  if (!navigator.clipboard) return toast(text);
  navigator.clipboard.writeText(text)
    .then(() => toast('Copied as text. Paste it anywhere.'))
    .catch(() => toast('Could not copy — try Save as HTML instead'));
}

/** Import is a paste with a file picker in front of it — no wizard (spec 15). */
function importFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.txt,.html,text/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let text = String(reader.result);
      // An exported Binder carries its own source; use that instead of HTML.
      const m = /<script type="text\/markdown" id="binder-source">([\s\S]*?)<\/script>/i.exec(text);
      if (m) text = m[1].replace(/<\\\/script/gi, '</script');
      else if (/^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text);
      const first = /^#{1,2}\s+(.+)$/m.exec(text);
      const b = newBinder((first ? first[1] : file.name.replace(/\.[^.]+$/, '')).trim(), text);
      go(linkTo(b.id));
      toast('Imported ' + file.name);
    };
    reader.readAsText(file);
  };
  input.click();
}

/** Last-resort HTML paste: keep the headings, drop the markup. */
function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const walk = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.textContent;
    const tag = n.tagName ? n.tagName.toLowerCase() : '';
    const inner = walk(n);
    if (/^h[1-6]$/.test(tag)) return '\n\n# ' + inner.trim() + '\n';
    if (tag === 'li') return '\n- ' + inner.trim();
    if (tag === 'blockquote') return '\n> ' + inner.trim() + '\n';
    if (['p', 'div', 'section', 'br', 'tr'].includes(tag)) return inner + '\n\n';
    if (tag === 'a' && n.href) return '[' + inner + '](' + n.href + ')';
    if (tag === 'strong' || tag === 'b') return '**' + inner + '**';
    if (tag === 'em' || tag === 'i') return '*' + inner + '*';
    if (tag === 'code') return '`' + inner + '`';
    return inner;
  }).join('');
  return walk(d).replace(/\n{3,}/g, '\n\n').trim();
}

/** Print the whole Binder: every sheet open, no chrome (spec 20). */
function printBinder() {
  const wasOpen = App.open;
  $$('.sheet').forEach((li, i) => {
    const sheet = App.doc.sheets[i];
    const body = $('.sheet-body', li);
    body.innerHTML = '<div class="prose">' + renderBody(sheet, { static: true }) + '</div>';
    body.hidden = false;
    li.classList.remove('is-hidden');
  });
  window.print();
  setTimeout(() => { renderBinder(); if (wasOpen) expand(wasOpen, { scroll: false }); }, 300);
}

/** Print one sheet: the other rows are hidden for the duration. */
function printSheet(sheet) {
  document.body.classList.add('print-sheet-only');
  const li = sheetBySlug(sheet.slug);
  li.classList.add('is-print');
  window.print();
  setTimeout(() => {
    document.body.classList.remove('print-sheet-only');
    li.classList.remove('is-print');
  }, 300);
}


/* == 15. MENU =============================================================
   Everything that is not the text (spec 29), and the only documentation the
   product needs: the shortcuts for wherever you are right now live at the
   foot of this menu, so no strip of hints follows the text around. Nothing
   account-shaped is faked here: this build is the free client, and it says
   so.                                                                      */

function renderMenu() {
  const menu = $('#menu');
  const inBinder = App.view === 'binder';
  const openSheet = inBinder && App.open && App.doc.sheets.find((c) => c.slug === App.open);
  const item = (label, key, act) =>
    '<button class="menu-item" role="menuitem" data-act="' + act + '"><span>' + label + '</span>' +
    '<span class="menu-item-key">' + (key || '') + '</span></button>';

  menu.innerHTML =
    (inBinder
      ? item('New sheet', 'S', 'sheet') +
        (openSheet ? item('Copy sheet link', '', 'link') : '') +
        (openSheet ? item('Print sheet', '', 'print-sheet') : '') +
        item('Copy as text', '', 'copytext') +
        item('Save as HTML file', '&#8984;S', 'export') +
        item('Print Binder', '&#8984;P', 'print') +
        item('Rename Binder', '', 'rename') +
        '<hr class="menu-sep">'
      : '') +
    item('New Binder', 'B', 'new') +
    item('Open a file', '', 'import') +
    '<hr class="menu-sep">' +
    item('Your name for @mentions', '', 'identity') +
    item('Sync across devices', 'Pro', 'sync') +
    (openSheet ? '<hr class="menu-sep">' + '<button class="menu-item is-danger" role="menuitem" data-act="delete-sheet">' +
      '<span>Delete this sheet</span></button>' : '') +
    (inBinder ? '<hr class="menu-sep">' + '<button class="menu-item is-danger" role="menuitem" data-act="delete">' +
      '<span>Delete this Binder</span></button>' : '') +
    '<hr class="menu-sep">' + shortcutsBlock();

  $$('.menu-item', menu).forEach((el) => el.addEventListener('click', () => {
    closeMenu();
    menuAction(el.dataset.act);
  }));
}

/**
 * The keys for this screen, and only the ones that are not already a line in
 * the menu above: the items carry their own shortcut, so this block is the
 * navigation — moving, opening, going back — plus where you are.
 */
function shortcutsBlock() {
  const row = (what, ...keys) =>
    '<div class="menu-key"><span>' + what + '</span><span class="menu-keys">' +
    keys.map((k) => '<kbd>' + k + '</kbd>').join('') + '</span></div>';
  const rows = [];
  let where, count = '';

  if (App.view === 'binder' && App.open) {
    const list = visible();
    where = 'Writing';
    if (list.length) count = (App.cur + 1) + ' / ' + list.length;
    rows.push(
      row('Move the caret', '&#8593;', '&#8595;'),
      row('Turn the page', '&#8593;', '&#8595;'),
      row('Done writing', 'Esc'),
      row('Find or ask', '&#8984;K'),
      '<div class="menu-note">A line starting with # is a heading, and Enter ' +
      'turns it into a sheet of its own. Every keystroke is saved on this ' +
      'device.</div>');
  } else if (App.view === 'binder') {
    const list = visible();
    where = 'Binder';
    if (list.length) count = (App.cur + 1) + ' / ' + list.length;
    rows.push(row('Move', '&#8593;', '&#8595;'));
    if (App.doc && App.doc.tags.length) rows.push(row('Change tag', '&#8592;', '&#8594;'));
    rows.push(
      row('Write in a sheet', '&#8629;'),
      row('New sheet', 'S'),
      row('Find or ask', '&#8984;K'),
      row('Back to the shelf', 'Esc'));
  } else {
    where = 'Shelf';
    const items = $$('.shelf-item');
    if (items.length) count = (App.cur + 1) + ' / ' + items.length;
    rows.push(
      row('Move', '&#8593;', '&#8595;'),
      row('Open a Binder', '&#8629;'),
      row('Find or ask', '&#8984;K'));
  }

  return '<div class="menu-label"><span>' + where + '</span><span>' + count + '</span></div>' +
    rows.join('');
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

function menuAction(act) {
  const b = getBinder(App.binderId);
  const openSheet = App.open && App.doc.sheets.find((c) => c.slug === App.open);
  switch (act) {
    case 'sheet':   addSheet(); break;
    case 'link':    if (openSheet) copyLink(openSheet); break;
    case 'print-sheet': if (openSheet) printSheet(openSheet); break;
    case 'copytext': copyBinderText(b); break;
    case 'export':  exportBinder(b); break;
    case 'print':   printBinder(); break;
    case 'new':     createBinder(); break;
    case 'import':  importFile(); break;
    case 'rename':  renameBinder(); break;
    case 'delete-sheet': {
      if (!openSheet) break;
      const li = sheetBySlug(openSheet.slug);
      if (li) deleteSheet(+li.dataset.i);
      break;
    }
    case 'delete': {
      if (!b) break;
      const at = DB.binders.indexOf(b);
      deleteBinder(b.id);
      go('#/');
      toastUndo('Deleted "' + b.title + '"', () => {
        DB.binders.splice(Math.min(at, DB.binders.length), 0, b);
        saveDB();
        go(linkTo(b.id));
      });
      break;
    }
    case 'identity': {
      const name = prompt('Your name, for @mentions', DB.identity);
      if (name) { DB.identity = name.trim().replace(/^@/, ''); saveDB(); route(); toast('You are @' + DB.identity); }
      break;
    }
    case 'sync':
      toast('Sync is Pro. This client keeps everything on this device.');
      break;
  }
}

/**
 * A Binder is never empty, and it is never nameless either: press B and it
 * exists right away, on the shelf, its name being typed in place — the same
 * way a sheet's own title is typed once it exists, just one screen over.
 */
function createBinder() {
  if (App.namingBinderId) commitBinderName(false);   // finish naming a previous one first
  const b = newBinder('Untitled', '');   // no sheet yet — that is only "# " away
  App.namingBinderId = b.id;
  App.cur = 0;                        // newest Binder sits first
  if (App.view === 'shelf') renderShelf(); else go('#/');
}

/**
 * A sheet made while a tag column is open already belongs there — it only
 * lacks the word on its own heading line, so this just writes it (spec 9).
 */
function inheritColumnTag(sheet, preferredTag) {
  if (!sheet || sheet.tag) return;
  // Splitting a tagged sheet in two is still writing the same sheet, so the
  // half that just became its own gets the tag it was already carrying —
  // truer than whichever column happens to be on screen right now.
  const tag = preferredTag || (App.col !== 0 ? App.doc.tags[App.col - 1] : null);
  if (!tag) return;
  const b = getBinder(App.binderId);
  const lines = b.text.split('\n');
  lines[sheet.line] = lines[sheet.line].replace(/\s*$/, '') + '  #' + tag;
  writeBinder(b, lines.join('\n'));
  App.doc = parse(b.text);
}

/**
 * A new sheet, after the one being read, with the caret in its name. This is
 * the same edit as typing "# " and pressing Enter — it just does not need you
 * to be inside a sheet already.
 */
function addSheet() {
  const b = getBinder(App.binderId);
  if (!b || !App.doc) return;
  const openTag = App.open ? Edit.tag : null;
  if (App.open) writeOpenSheet();

  const lines = b.text.split('\n');
  const here = App.doc.sheets[currentSheetIndex()];
  let at = here ? here.line + 1 + here.lines.length : lines.length;
  while (at > 0 && !String(lines[at - 1] || '').trim()) at--;   // sit against the text
  lines.splice(at, 0, '', '# ');
  writeBinder(b, lines.join('\n'));

  App.doc = parse(b.text);
  inheritColumnTag(App.doc.sheets.find((c) => c.line === at + 1), openTag);
  const made = App.doc.sheets.find((c) => c.line === at + 1);
  renderBinder();
  if (!made) return;
  expand(made.slug, { scroll: true });
  const title = $('.sheet.is-open .sheet-title');
  if (title) placeCaret(title, 'start');
}

/**
 * Remove a sheet: its heading and its body, and nothing else in the Binder.
 * Deleting the sheet being written in leaves the caret at the end of the one
 * before it, the way backspacing out of anything else would.
 */
function deleteSheet(idx, { intoPrevious = false } = {}) {
  // One sheet, or several named by a single selection: either way it is one
  // edit and one "Undo", not each sheet's toast overwriting the last as it
  // goes.
  const idxs = [...new Set(Array.isArray(idx) ? idx : [idx])]
    .filter((i) => App.doc && App.doc.sheets[i]).sort((a, z) => a - z);
  const b = getBinder(App.binderId);
  if (!b || !idxs.length) return;
  const binderId = b.id;
  const sheets = idxs.map((i) => App.doc.sheets[i]);
  const name = sheets.length === 1
    ? (sheets[0].named ? sheets[0].title : 'the sheet')
    : sheets.length + ' sheets';

  Edit.dirty = false;                 // there is nothing left to write back
  const lines = b.text.split('\n');
  // Bottom to top: removing a sheet only ever shortens the file below it, so
  // the line numbers this loop hasn't reached yet stay valid throughout.
  const removed = [];
  for (let k = idxs.length - 1; k >= 0; k--) {
    const sheet = sheets[k];
    const next = App.doc.sheets[idxs[k] + 1];
    removed.unshift(lines.splice(sheet.line, (next ? next.line : lines.length) - sheet.line));
  }
  writeBinder(b, tidyLines(lines).join('\n') + '\n');

  App.open = null;
  App.doc = parse(b.text);
  App.col = Math.min(App.col, App.doc.tags.length);
  const firstIdx = idxs[0];
  const prev = App.doc.sheets[firstIdx - 1];
  const near = prev || App.doc.sheets[firstIdx] || null;
  renderBinder();
  renderChrome();
  scheduleReminders();
  refreshBell();

  if (intoPrevious && prev) {
    columnFor(prev.slug);
    expand(prev.slug, { scroll: true });
    const body = $('.prose', sheetBySlug(prev.slug));
    if (body) placeCaret(body.lastElementChild || body, 'end');
  } else {
    const li = near && sheetBySlug(near.slug);
    if (li) setCursor(visible().indexOf(li), { scroll: true });
    $('#stage').focus({ preventScroll: true });
  }

  // Anchored to the sheet before it, not to a line number: the document
  // keeps changing underneath the undo window, but a sheet's own slug does
  // not (spec 6), so that is what finds the way back for it.
  const afterSlug = prev ? prev.slug : null;
  toastUndo('Deleted ' + name, () => {
    const bb = getBinder(binderId);
    if (!bb) return;
    const backLines = bb.text.split('\n');
    const doc = parse(bb.text);
    const after = afterSlug && doc.sheets.find((c) => c.slug === afterSlug);
    let at = after ? after.line + 1 + after.lines.length : 0;
    while (at > 0 && !String(backLines[at - 1] || '').trim()) at--;
    backLines.splice(at, 0, ...removed.flat());
    writeBinder(bb, backLines.join('\n'));
    if (App.binderId !== binderId) return;
    App.doc = parse(bb.text);
    const restored = App.doc.sheets.find((c) => c.line === at);
    renderBinder();
    if (restored) { columnFor(restored.slug); expand(restored.slug, { scroll: true }); }
  });
}

/** Which sheet the reader is on: the open one, else the one under the cursor. */
function currentSheetIndex() {
  const li = $('.sheet.is-open') || visible()[App.cur];
  return li ? +li.dataset.i : -1;
}

function renameBinder() {
  const b = getBinder(App.binderId);
  if (!b) return;
  const name = prompt('Name this Binder', b.title);
  if (name && name.trim()) { b.title = name.trim(); b.updated = Date.now(); saveDB(); renderChrome(); }
}


function closeOverlays() {
  closeMenu();
  closeTagMenu();
  $('#notifs').hidden = true;
  if (Pal.open) closePalette();
}


/* == 16. KEYBOARD =========================================================
   Up and down move through sheets, left and right move through tags. That is
   the whole navigation model, and it is the same one touch uses (spec 30).  */

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const typing = e.target.matches('input, textarea, [contenteditable]');

  // The menu lists the keys for the screen behind it, so any key that could
  // change that screen closes it rather than leaving a stale list open.
  if (!$('#menu').hidden && (mod || !typing)) {
    closeMenu();
    if (e.key === 'Escape') { e.preventDefault(); return; }
  }

  // Global shortcuts work everywhere, including mid-sentence.
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    const b = getBinder(App.binderId);
    return b ? exportBinder(b) : toast('Open a Binder to save it');
  }
  // Cmd/Ctrl+P must go through printBinder(), not the browser's native
  // print: printBinder() populates every sheet body first, and the browser
  // dialog would otherwise print whatever sheets happen to already be
  // rendered (i.e. just the one that's open), leaving the rest blank.
  if (mod && e.key.toLowerCase() === 'p') {
    if (App.view !== 'binder') return;
    e.preventDefault();
    return printBinder();
  }
  // Cmd/Ctrl+Z undoes, Shift or Ctrl+Y redoes — ahead of the "typing owns the
  // rest" bail-out below, same as the other global shortcuts: the browser's
  // own undo only ever knew about keystrokes, never about a sheet appearing
  // or disappearing, so it is bypassed here rather than left half-working.
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }

  // A collapsed title is still ordinary text: select it (one of them, or a
  // run across several) and Backspace or Delete removes the sheet it names,
  // the same as selecting and deleting any other run of text would. This has
  // to run ahead of the "typing owns the rest" bail-out just below — the
  // title is contenteditable, so every keystroke while renaming one would
  // otherwise count as typing.
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && sel.toString().trim()) {
      const r = sel.getRangeAt(0);
      const idxs = $$('.sheet-title').map((title) => {
        const li = title.closest('.sheet');
        return (li && !li.classList.contains('is-open') && r.intersectsNode(title)) ? +li.dataset.i : -1;
      }).filter((i) => i > -1);
      if (idxs.length) {
        e.preventDefault();
        deleteSheet(idxs);
        return;
      }
    }
  }

  if (typing) return;                       // the text field owns everything else

  if (App.view === 'shelf') {
    const items = $$('.shelf-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); App.cur++; markShelfCursor(); scrollShelf(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); App.cur--; markShelfCursor(); scrollShelf(); }
    if (e.key === 'Enter' && items[App.cur]) items[App.cur].click();
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); createBinder(); }
    if (e.key === '/') { e.preventDefault(); openPalette(); }
    return;
  }

  switch (e.key) {
    case 'ArrowDown': case 'j':
      e.preventDefault(); step(1); break;
    case 'ArrowUp': case 'k':
      e.preventDefault(); step(-1); break;
    case 'ArrowRight':
      if (App.doc.tags.length) { e.preventDefault(); setColumn(App.col + 1); } break;
    case 'ArrowLeft':
      if (App.doc.tags.length) { e.preventDefault(); setColumn(App.col - 1); } break;
    case 'Enter': {
      e.preventDefault();
      const el = visible()[App.cur];
      if (!el) break;
      // A first Enter opens a heading to read, exactly like a click — the
      // caret stays out of it, so arrow keys still walk the list rather than
      // typing. Only a second Enter, on the sheet already open, is "click
      // again, into the text" and starts writing.
      if (App.open === el.dataset.slug) {
        const body = $('.prose', el);
        if (body) placeCaret(body.firstElementChild || body, 'start');
      } else {
        expand(el.dataset.slug);
      }
      break;
    }
    case 'Escape':
      if (App.open) collapse(); else go('#/');
      break;
    case 'b': case 'B':
      if (!mod) createBinder();
      break;
    case 's': case 'S':
      if (!mod) { e.preventDefault(); addSheet(); }
      break;
    case '/':
      e.preventDefault(); openPalette(); break;
  }
}

/** Moving with a sheet open reads like turning a page: the next one opens. */
function step(d) {
  const list = visible();
  if (!list.length) return;
  const next = Math.max(0, Math.min(App.cur + d, list.length - 1));
  if (App.open) expand(list[next].dataset.slug, { scroll: true });
  else setCursor(next);
}

function scrollShelf() {
  const el = $$('.shelf-item')[App.cur];
  // Moving the cursor is not a request to also recentre the page — only
  // scroll when the selected item is not already on screen.
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}


/* == 17. TOUCH ============================================================
   Vertical swiping is the browser's own scrolling with CSS snap, so a flick
   lands on a sheet instead of between two. Only the horizontal gesture needs
   code: left and right change tag (spec 31).                                */

function watchTouch() {
  const stage = $('#stage');
  let x0 = 0, y0 = 0, t0 = 0;

  stage.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
  }, { passive: true });

  stage.addEventListener('touchend', (e) => {
    if (App.view !== 'binder' || App.open || !App.doc.tags.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 600) return;
    if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      setColumn(App.col + (dx < 0 ? 1 : -1));
    }
  }, { passive: true });
}

/**
 * A row moving under the caret's own command (setCursor's scrollIntoView)
 * fires the same 'scroll' events an ordinary flick would — and a target more
 * than a screen away takes the smooth scroll several frames, and possibly a
 * snap point, to arrive at. Recomputing the cursor from scroll position on
 * every one of those frames raced the deliberate move and could leave the
 * highlight on whatever the animation was passing, not what was asked for.
 * This is the window during which watchScroll stands down and lets the
 * scroll it caused finish on its own.
 */
let scrollSyncSuppressed = false;
const clearScrollSuppress = debounce(() => { scrollSyncSuppressed = false; }, 500);
function suppressScrollSync() { scrollSyncSuppressed = true; clearScrollSuppress(); }

/** Scrolling is navigation too: the spine follows the sheet nearest the eye. */
function watchScroll() {
  const stage = $('#stage');
  let raf = 0;
  stage.addEventListener('scroll', () => {
    if (raf || App.view !== 'binder' || App.open || scrollSyncSuppressed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const list = visible();
      if (!list.length) return;
      const top = stage.getBoundingClientRect().top + 24;
      let best = 0, bestD = Infinity;
      list.forEach((el, i) => {
        const d = Math.abs($('.sheet-hit', el).getBoundingClientRect().top - top);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best !== App.cur) {
        App.cur = best;
        list.forEach((el, n) => el.classList.toggle('is-cur', n === best));
      }
    });
  }, { passive: true });
}


/* == 18. BOOT =============================================================
   Open Txtr and you are already using it: no landing page, no signup, no
   tour (spec 26). On the very first run the sample Binder is seeded from the
   text kept in index.html — it is a document, so it is stored as one.       */

function seedSample() {
  const src = $('#sample-binder');
  if (!src) return;
  newBinder(src.dataset.title || 'What is Txtr?', src.textContent.replace(/^\n+/, ''));
}

/**
 * The installed app has to work with no connection (spec 25), which is what
 * the service worker is for — but offline is the fallback, not the default:
 * sw.js itself fetches network-first, so being online always wins. This is
 * only the other half of that, for a copy of the app already open when a
 * newer one finishes installing in the background: the new one takes over
 * and the open tab reloads once to match it, instead of running stale until
 * someone thinks to quit and reopen it.
 */
function watchForUpdate() {
  if (!('serviceWorker' in navigator)) return;
  // The very first time a service worker is ever installed for this page it
  // takes control of the tab already open, and that alone fires the same
  // event a real update would — reloading then would just interrupt
  // whatever was happening for no reason, so only a *change* of controller
  // counts, not this page adopting its first one.
  const hadController = !!navigator.serviceWorker.controller;
  // Don't swallow this: a failed registration means offline silently never
  // works, with no other signal anywhere that anything is wrong.
  navigator.serviceWorker.register('sw.js').catch((err) => console.error('SW registration failed:', err));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    if (hadController) location.reload();
  });
}

function boot() {
  loadDB();
  if (!DB.binders.length) seedSample();
  watchForUpdate();

  // chrome
  $('#crumb-home').addEventListener('click', () => go('#/'));
  $('#crumb-binder').addEventListener('click', renameBinder);
  $('#search-btn').addEventListener('click', () => openPalette());
  $('#bell').addEventListener('click', (e) => { e.stopPropagation(); toggleNotifications(); });
  $('#menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#menu');
    if (!menu.hidden) return closeMenu();
    renderMenu();
    menu.hidden = false;
    $('#menu-btn').setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenu();
    if (!e.target.closest('#notifs') && !e.target.closest('#bell')) $('#notifs').hidden = true;
    if (!e.target.closest('#tag-menu') && !e.target.closest('.tag')) closeTagMenu();
  });

  // palette
  const input = $('#term-input');
  input.addEventListener('input', () => { if (Pal.mode === 'find') runPalette(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); return closePalette(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      setMode(Pal.mode === 'ask' ? 'find' : 'ask');
      if (Pal.mode === 'ask') { touchOnDeviceModel(); ask(input.value.trim()); } else runPalette();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectResult(Pal.sel + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectResult(Pal.sel - 1); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (Pal.mode === 'ask') { touchOnDeviceModel(); return ask(q); }
      if (Pal.items.length) return openResult(Pal.items[Pal.sel]);
      if (q) { touchOnDeviceModel(); setMode('ask'); ask(q); }
    }
  });
  $('#palette').addEventListener('mousedown', (e) => {
    if (e.target.id === 'palette') closePalette();
  });
  $('#mic').addEventListener('click', () => {
    if (recognizer) stopListening(); else startListening();
  });

  // routing and layout
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);

  watchTouch();
  watchScroll();

  route();
  scheduleReminders();
  refreshBell();
  setInterval(refreshBell, 60000);
}

boot();

/* Teach Us to Pray
 *
 * One small script, no dependencies. It loads its own files only, from the place
 * the app comes from: the language file, the Scripture file, and the Bible study
 * files (bible/index.json, then each book the first time it is opened). It never
 * sends anything about the person, and it uses no other website.
 *
 * What is kept, and where:
 * - Pray by myself: the words are kept for this visit in sessionStorage (erased when
 *   the tab closes), and in localStorage only if "keep my draft on this device" is on.
 * - Share Jesus: words are held in memory only and never stored, whatever that setting is.
 * - Bible study: the last chapter read and the translators' notes setting (localStorage),
 *   and books opened or downloaded (the Cache Storage named after the Bible version).
 * - Cross-references: each book's file, once opened (the Cache Storage named after the TSK version).
 * - Listen: its settings (speed, voice, announcements, keep screen on) and where listening
 *   stopped (localStorage).
 * - My study: notes and bookmarks the person made (localStorage), and a note being written
 *   (sessionStorage, until it is saved or cancelled).
 */
(() => {
  'use strict';

  // Languages that have a lang/<code>.json file. See README: "Adding a language".
  const LANGS = ['en'];
  const DRAFT_KEY = 'teach-us-to-pray-draft';
  const VISIT_KEY = 'teach-us-to-pray-visit';   // sessionStorage: this visit only
  const PLACE_KEY = 'teach-us-to-pray-place';   // the last chapter read, e.g. "JHN/3"
  const HIDE_NOTES_KEY = 'teach-us-to-pray-hide-notes';
  const HIDE_SAVED_KEY = 'teach-us-to-pray-hide-saved-line'; // the "Saved on this device" line was closed
  const HIDE_TIP_KEY = 'teach-us-to-pray-hide-verse-tip';     // the "Tap a verse number" line was closed
  const STUDY_KEY = 'teach-us-to-pray-study';                 // My study: notes and bookmarks
  const NOTE_DRAFT_KEY = 'teach-us-to-pray-note-draft';       // sessionStorage: a note not yet saved

  let L;            // language strings
  let S;            // scripture document
  let PRAY;         // "Pray by myself": the guided prayer
  let SHARE;        // "Share Jesus": a leader guiding someone else
  let keep = false; // "keep my draft on this device" (Pray by myself only)
  let flash = '';   // one-time status message for the next render
  let prayerDay = null; // the day fixed when the person taps Begin (memory only)
  let IDX;          // bible/index.json: the books, their shelves and sizes
  let TSKI = null;  // tsk/index.json: the cross-reference files and their sizes
  const BOOKS = new Map(); // books opened this visit, by code
  let refLinks = true;  // Scripture references link to their chapter (not during Share Jesus)
  let visitKept = false; // the words of this visit are safe in sessionStorage
  let downloading = false;

  const main = document.getElementById('main');

  /* ---------- small helpers ---------- */

  // Create an element. Text is always added as text, never as HTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ['MAT 18:21', 'MAT 18:22'] -> 'Matthew 18:21-22'
  function refLabel(group) {
    const [book, first] = group[0].split(' ');
    const last = group[group.length - 1].split(':')[1];
    return L.books[book] + ' ' + first + (group.length > 1 ? '-' + last : '');
  }

  // An excerpt can begin or end partway through a speech. An unmatched quotation mark at
  // the very start or very end of the excerpt is not shown. An unmatched opening mark
  // further in (after "said,") stays, so the reader sees where the speaker begins.
  // Only marks are removed, never words. A single mark goes only when it is unmatched
  // and is at the very edge, or touches a removed double mark, because the closing
  // single mark is also the apostrophe. tools/verify.py applies the same rule.
  function trimQuotes(t) {
    const letter = (c) => /\p{L}/u.test(c || '');
    const strayDouble = new Set();
    const straySingle = new Set();
    const openD = [];
    const openS = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '“') openD.push(i);
      else if (c === '”') { if (openD.length) openD.pop(); else strayDouble.add(i); }
      else if (c === '‘') openS.push(i);
      else if (c === '’' && !(letter(t[i - 1]) && letter(t[i + 1]))) {
        if (openS.length) openS.pop(); else straySingle.add(i);
      }
    }
    openD.forEach((i) => strayDouble.add(i));
    openS.forEach((i) => straySingle.add(i));
    const atEdge = (i) => i === 0 || i === t.length - 1;
    const drop = new Set([...strayDouble, ...straySingle].filter(atEdge));
    for (const i of [...drop]) {
      if (t[i] === '“' && straySingle.has(i + 1)) drop.add(i + 1);
      if (t[i] === '”' && straySingle.has(i - 1)) drop.add(i - 1);
    }
    return t.split('').filter((_, i) => !drop.has(i)).join('');
  }

  // The text of a group of verses, exactly as shown. It comes only from the Scripture file.
  const scripture = (group) => trimQuotes(group.map((r) => S.verses[r]).join(' '));
  const cite = (group) => refLabel(group) + ' · ' + S.abbreviation;

  // A passage of Scripture with its reference.
  function passage(group, extraClass) {
    return h('figure', { class: 'verse' + (extraClass ? ' ' + extraClass : '') },
      h('blockquote', null, h('p', null, scripture(group))),
      h('figcaption', null, refLinks ? h('a', { href: chapterHref(group[0]) }, cite(group)) : cite(group)));
  }
  // 'MAT 6:9a' -> '#/bible/MAT/6/9': the whole chapter, at that verse.
  function chapterHref(ref) {
    const [book, cv] = ref.split(' ');
    const [ch, v] = cv.split(':');
    return '#/bible/' + book + '/' + ch + '/' + parseInt(v, 10);
  }

  const paragraphs = (list) => list.map((t) => h('p', null, t));
  const ourNote = (text) => text && h('p', { class: 'note' }, h('strong', null, L.app.ourNoteLabel + ': '), text);

  /* ---------- the two ways through the app ---------- */

  // A flow holds one set of steps, the words typed for them, and where its screens live.
  function makeFlow(steps, opts) {
    return Object.assign({
      steps,
      answers: steps.map(() => ''),               // one entry per step, the person's own words
      parts: steps.map((st) => st.guided.map(() => '')), // the words typed under each question
      edited: new Set(),                          // steps changed on the read-through this visit
      borrowed: [],                               // Scripture prayers chosen to pray (Share Jesus)
    }, opts);
  }

  function resetFlow(F) {
    F.answers = F.steps.map(() => '');
    F.parts = F.steps.map((st) => st.guided.map(() => ''));
    F.edited.clear();
    F.borrowed = [];
  }

  // The prayer in order: each answered step, then any Scripture prayer chosen to borrow.
  // Nothing else is added: no opening, no closing, no "Amen".
  function prayerParts(F) {
    const own = F.steps.map((st, i) => ({ name: st.name, text: F.answers[i] })).filter((p) => p.text.trim());
    const lent = F.borrowed.map((r) => ({ name: refLabel([r]), text: scripture([r]), ref: [r] }));
    return own.concat(lent);
  }
  const anyWords = () => prayerParts(PRAY).length > 0 || prayerParts(SHARE).length > 0;
  // Plain text of the prayer, for Copy, Share and Save. Borrowed Scripture keeps its reference.
  const plain = (list) => list.map((p) => (p.ref ? p.text + '\n(' + cite(p.ref) + ')' : p.text)).join('\n\n');

  // Split only where the words already have punctuation (. , ; ? !) or a line break.
  // The words themselves are not changed; only the spaces between phrases are left out.
  function phrases(text) {
    return text.split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.,;?!]["'”’)]*)\s+/))
      .map((s) => s.trim()).filter(Boolean);
  }

  /* ---------- optional draft on this device (Pray by myself only) ---------- */

  // The kept draft (localStorage, only when switched on) comes first; otherwise the words
  // of this visit (sessionStorage), which the browser erases when the tab is closed.
  function loadDraft() {
    const text = (v) => (typeof v === 'string' ? v : '');
    const use = (saved) => {
      PRAY.answers = PRAY.answers.map((_, i) => text(saved.answers[i]));
      PRAY.parts = PRAY.parts.map((list, i) => list.map((_, k) => text(((saved.parts || [])[i] || [])[k])));
    };
    try {
      let saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (Array.isArray(saved)) saved = { answers: saved }; // first version stored a plain list
      if (saved && Array.isArray(saved.answers)) { use(saved); keep = true; return; }
    } catch (e) { /* storage unavailable: carry on without it */ }
    try {
      const visit = JSON.parse(sessionStorage.getItem(VISIT_KEY));
      if (visit && Array.isArray(visit.answers)) use(visit);
    } catch (e) { /* ignore */ }
  }
  function saveDraft() {
    const words = JSON.stringify({ answers: PRAY.answers, parts: PRAY.parts });
    try { sessionStorage.setItem(VISIT_KEY, words); visitKept = true; } catch (e) { visitKept = false; }
    if (!keep) return;
    try { localStorage.setItem(DRAFT_KEY, words); } catch (e) { /* ignore */ }
  }
  function forgetDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }
  function forgetVisit() {
    try { sessionStorage.removeItem(VISIT_KEY); } catch (e) { /* ignore */ }
  }

  function draftSection() {
    const box = h('input', {
      type: 'checkbox', id: 'keep', 'aria-describedby': 'keep-hint', checked: keep,
      onchange: (e) => { keep = e.target.checked; if (keep) saveDraft(); else forgetDraft(); },
    });
    const erase = h('button', {
      type: 'button', class: 'btn danger',
      onclick: () => {
        if (!window.confirm(L.draft.eraseConfirm)) return;
        resetFlow(PRAY);
        forgetDraft();
        forgetVisit();
        flash = L.draft.erased;
        render(true);
      },
    }, L.draft.erase);
    const section = h('section', { class: 'draft', 'aria-labelledby': 'draft-heading' },
      h('h2', { id: 'draft-heading' }, L.draft.heading),
      h('label', { class: 'check', for: 'keep' }, box, h('span', null, L.draft.toggle)),
      h('p', { class: 'hint', id: 'keep-hint' }, L.draft.explain),
      erase,
      h('p', { class: 'status', role: 'status' }, flash));
    flash = '';
    return section;
  }

  /* ---------- screens ---------- */

  // A large button on the welcome screen that starts one of the two ways.
  function choice(href, label, hint, extraClass, onclick) {
    return h('a', { class: 'btn choice ' + extraClass, href, onclick },
      h('strong', null, label), h('span', null, hint));
  }

  // Tapping Begin fixes "today" for this prayer, so the passages offered
  // do not change if the prayer runs past midnight.
  const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  const fixDay = () => { prayerDay = today(); };
  function beginLink(href, label) {
    return h('a', { class: 'btn primary grow', href, onclick: fixDay }, label);
  }

  function welcomeView() {
    const w = L.welcome;
    // Someone who has been reading carries on with one tap.
    const [pCode, pCh] = (store.get(PLACE_KEY) || '').split('/');
    const placeBook = pCode && IDX && bookInfo(pCode);
    return {
      nodes: [
        placeBook && h('p', { class: 'continue-top' }, h('a', { class: 'btn', href: '#/bible/' + pCode + '/' + pCh },
          fill(B().continue, { ref: chapterTitle(placeBook, pCh) }))),
        h('h1', null, w.heading),
        w.verses.map((r) => passage([r])),
        paragraphs(w.body),
        h('h2', null, w.choose),
        h('div', { class: 'choices' },
          choice('#/guide', w.byMyself, w.byMyselfHint, 'primary', fixDay),
          choice('#/share', L.share.name, w.shareHint, '')),
        h('p', null, h('a', { href: '#/why' }, w.whyLink)),
        draftSection(),
      ],
    };
  }

  function whyView() {
    return {
      title: L.why.heading,
      nodes: [
        h('h1', null, L.why.heading),
        L.why.sections.map((s) => [h('h2', null, s.heading), passage(s.verses)]),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/guide' }, L.nav.start)),
      ],
    };
  }

  // Which entries of a step's pool to show today. Chosen from the date alone,
  // so nothing about the person needs to be stored. The day is the one fixed at
  // Begin, or today if a step was opened directly.
  function todaysPassages(pool) {
    const perDay = Math.min(L.step.perDay, (pool || []).length);
    if (!perDay) return [[], []];
    const day = prayerDay == null ? today() : prayerDay;
    const start = (day * perDay) % pool.length;
    const picks = [];
    const rest = [];
    pool.forEach((g, j) => (((j - start + pool.length) % pool.length) < perDay ? picks : rest).push(g));
    return [picks, rest];
  }

  const progressText = (F, n) => L.step.progress.replace('{n}', n).replace('{total}', F.steps.length);
  // Where the person is: a bar of the steps, which opens to show the names of all of them.
  const stepMap = (F, i, progress) => h('details', { class: 'map' },
    h('summary', null,
      h('span', { class: 'progress' }, progress),
      h('span', { class: 'dots', 'aria-hidden': 'true' }, F.steps.map((_, j) => h('span', { class: j <= i ? 'done' : '' })))),
    h('ol', { class: 'names' }, F.steps.map((st, j) => h('li', { 'aria-current': j === i ? 'step' : null }, st.name))));
  // Each step keeps the words of its short questions; the step's words are those
  // joined with a space, so the step reads as one paragraph. Nothing is added to them.
  const joined = (F, i) => F.parts[i].filter((t) => t.trim()).join(' ');

  // "Pray by myself": a short start screen with the words of Jesus about praying simply.
  function guideIntroView() {
    const g = L.guide;
    return {
      title: g.introHeading,
      nodes: [
        h('h1', null, g.introHeading),
        passage(g.introVerses),
        paragraphs(g.intro),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          beginLink(PRAY.q(1, 1), g.begin)),
      ],
    };
  }

  // One short question on the screen at a time. Used by both ways through the app.
  function guideView(F, i, k) {
    const g = L.guide;
    const step = F.steps[i];
    const item = step.guided[k];
    const count = step.guided.length;
    const n = i + 1;
    const progress = progressText(F, n) + (count > 1 ? g.questionOf.replace('{k}', k + 1).replace('{count}', count) : '');
    const last = n === F.steps.length && k === count - 1;

    // If the words were changed on the read-through screen, keep them all: put them under the first question.
    if (joined(F, i) !== F.answers[i]) F.parts[i] = F.parts[i].map((_, q) => (q ? '' : F.answers[i]));
    const editedNote = F.edited.has(i) && count > 1 && h('p', { class: 'note' }, k ? g.editedFirst : g.editedHere);

    const nextHref = k + 1 < count ? F.q(n, k + 2) : last ? F.review : F.q(n + 1, 1);
    const backHref = k > 0 ? F.q(n, k) : i > 0 ? F.q(i, F.steps[i - 1].guided.length) : F.first;
    const nextLabel = () => (last ? F.toReview : F.parts[i][k].trim() ? L.nav.next : L.nav.skipQuestion);
    const next = h('a', { class: 'btn primary grow', href: nextHref }, nextLabel());

    // The box always starts with the person's own words or nothing at all.
    // Spell-check is off so that no browser service is sent what is typed.
    const update = () => {
      F.parts[i][k] = box.value; F.answers[i] = joined(F, i); F.edited.delete(i);
      next.textContent = nextLabel(); F.save();
    };
    const box = h('textarea', {
      id: 'words', class: 'short', rows: '4', autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': 'words-hint', oninput: update,
    });
    box.value = F.parts[i][k];

    // Prompts are for reflection only. Nothing is ever put in the box for the person.
    const cues = item.cues && h('div', { class: 'cues' },
      h('p', { id: 'cues-label' }, F.cuesLabel + ':'),
      h('ul', { 'aria-labelledby': 'cues-label' }, item.cues.map((cue) => h('li', null, cue))));
    const [picks, rest] = todaysPassages(step.related);

    return {
      title: progress + ': ' + step.name,
      nodes: [
        stepMap(F, i, progress),
        h('h1', null, step.name),
        step.verses.map((v) => passage(v, 'main')),
        ourNote(step.note),
        h('div', { class: 'ask' },
          h('label', { for: 'words' }, item.q),
          item.example && [h('h2', { class: 'small' }, g.exampleHeading), passage(item.example)],
          cues,
          editedNote,
          box,
          h('p', { class: 'hint', id: 'words-hint' }, F.hint)),
        F.needHelp && h('p', null, h('a', { href: F.needHelp }, L.share.needHelp)),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: backHref }, L.nav.back),
          next),
        picks.length > 0 && h('details', null, h('summary', null, L.step.relatedHeading), picks.map((v) => passage(v))),
        rest.length > 0 && h('details', null, h('summary', null, L.step.moreLink), rest.map((v) => passage(v))),
      ],
    };
  }

  // The whole prayer in one place, one box per step, to read through and make one's own before praying it.
  function reviewView(F) {
    const s = F.reviewText;
    const filled = F.steps.map((st, i) => ({ st, i })).filter(({ i }) => F.answers[i].trim());
    const backHref = F.q(F.steps.length, F.steps[F.steps.length - 1].guided.length);
    if (!filled.length && !F.borrowed.length) {
      if (!F.needHelp) return prayerView(F);
      // A prayer with no words cannot be prayed: offer the prayers from Scripture.
      return {
        title: s.heading,
        nodes: [
          h('h1', null, s.heading),
          h('p', { class: 'standout' }, s.empty),
          h('div', { class: 'actions nav' },
            h('a', { class: 'btn', href: backHref }, L.nav.back),
            h('a', { class: 'btn primary grow', href: F.needHelp }, s.toBorrow)),
        ],
      };
    }
    return {
      title: s.heading,
      nodes: [
        h('h1', null, s.heading),
        h('p', { class: 'standout', id: 'review-hint' }, s.hint),
        s.lineHint && h('p', { class: 'hint' }, s.lineHint),
        filled.map(({ st, i }) => {
          const id = 'review-' + (i + 1);
          // Spell-check is off so that no browser service is sent what is typed.
          const box = h('textarea', {
            id, rows: '4', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'review-hint',
            oninput: (e) => { F.answers[i] = e.target.value; F.edited.add(i); F.save(); },
          });
          box.value = F.answers[i];
          return h('div', { class: 'ask' }, h('label', { for: id }, st.name), box);
        }),
        // Scripture chosen to borrow is shown as it is, with its reference. It is not edited.
        F.borrowed.length > 0 && [
          h('h2', null, s.borrowedHeading),
          F.borrowed.map((r) => h('div', { class: 'borrowed' },
            passage([r]),
            h('button', {
              type: 'button', class: 'btn',
              onclick: () => { F.borrowed = F.borrowed.filter((x) => x !== r); render(true); },
            }, s.remove + ': ' + refLabel([r])))),
        ],
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: backHref }, L.nav.back),
          h('a', { class: 'btn primary grow', href: F.walk + '1' }, s.toWalk)),
      ],
    };
  }

  // Praying out loud. Pray by myself: one part at a time. Share Jesus: one phrase at a time,
  // for the leader to read and the other person to repeat.
  function prayWalkView(F, n) {
    const g = L.guide;
    const units = F.perPhrase
      ? prayerParts(F).flatMap((p) => phrases(p.text).map((t) => ({ name: p.name, text: t, ref: p.ref })))
      : prayerParts(F);
    if (!units.length) return F.perPhrase ? reviewView(F) : prayerView(F);
    const idx = Math.min(Math.max(n, 1), units.length) - 1;
    const u = units[idx];
    const lastPart = idx === units.length - 1;
    const progress = (F.perPhrase ? L.share.walk.progress : g.partOf).replace('{n}', idx + 1).replace('{total}', units.length);
    return {
      title: progress + ': ' + u.name,
      nodes: [
        h('p', { class: 'progress' }, progress + ' · ' + u.name),
        h('h1', { class: F.perPhrase ? 'visually-hidden' : null }, F.perPhrase ? progress : g.sayThis),
        h('div', { class: F.perPhrase ? 'aloud phrase' : 'aloud' }, h('p', null, u.text),
          u.ref && h('p', { class: 'cite' }, cite(u.ref))),
        F.perPhrase && h('p', { class: 'leader-line' }, L.share.walk.leaderLine),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: idx > 0 ? F.walk + idx : F.review }, L.nav.back),
          h('a', { class: 'btn primary grow', href: lastPart ? F.prayer : F.walk + (idx + 2) },
            lastPart ? F.finish : L.nav.next)),
      ],
    };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const t = h('textarea', { class: 'offscreen', readonly: true });
    t.value = text;
    document.body.append(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    t.remove();
    return ok;
  }

  // Save the prayer as a dated text file. The file is made in the browser; nothing is sent anywhere.
  function saveFile(text) {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const name = L.prayer.fileName + '-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '.txt';
    const url = URL.createObjectURL(new Blob([text.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
    const link = h('a', { href: url, download: name, class: 'offscreen' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function prayerView(F) {
    const list = prayerParts(F);
    const nodes = [h('h1', null, F.prayerText.heading)];
    if (!list.length) {
      nodes.push(h('p', null, L.prayer.empty),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: F.first }, L.guide.begin)));
    } else {
      const status = h('p', { class: 'status', role: 'status' });
      const text = plain(list);
      nodes.push(
        h('p', { class: 'no-print' }, F.prayerText.intro),
        // Only the person's own words, exactly as typed, in order, and any Scripture they chose.
        h('div', { class: 'prayer' }, list.map((p) => [h('p', null, p.text), p.ref && h('p', { class: 'cite' }, cite(p.ref))])),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'btn primary',
            onclick: async () => { status.textContent = (await copyText(text)) ? L.prayer.copied : L.prayer.copyFailed; },
          }, L.prayer.copy),
          // Share opens the device's own share sheet; the person chooses where the words go.
          navigator.share && h('button', {
            type: 'button', class: 'btn',
            onclick: () => { navigator.share({ text }).catch(() => {}); },
          }, L.prayer.share),
          h('button', {
            type: 'button', class: 'btn',
            onclick: () => { saveFile(text); status.textContent = L.prayer.saved; },
          }, L.prayer.save),
          h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, L.prayer.print),
          F === PRAY && h('a', { class: 'btn', href: '#/aloud' }, L.prayer.aloud),
          h('a', { class: 'btn', href: F.review }, L.prayer.edit)),
        status,
        F === SHARE && h('div', { class: 'actions' }, h('a', { class: 'btn primary grow', href: '#/share/after' }, L.share.prayer.next)));
    }
    if (F === PRAY) nodes.push(draftSection());
    return { title: F.prayerText.heading, nodes };
  }

  function aloudView() {
    const list = prayerParts(PRAY);
    if (!list.length) return prayerView(PRAY);
    return {
      title: L.prayer.aloudHeading,
      nodes: [
        h('h1', { class: 'progress' }, L.prayer.aloudHeading),
        h('div', { class: 'aloud' }, paragraphs(list.map((p) => p.text))),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/prayer' }, L.prayer.aloudClose)),
      ],
    };
  }

  /* ---------- Share Jesus: the screens that are not questions ---------- */

  // Leaving Share Jesus forgets what was typed, so the next person starts with nothing.
  const homeLink = (label) => h('a', { class: 'btn primary grow', href: '#/', onclick: () => resetFlow(SHARE) }, label);

  // Screen 1, for the leader. Starting here always begins with empty boxes.
  function shareStartView() {
    const s = L.share.start;
    return {
      title: s.name + ' | ' + L.share.name,
      nodes: [
        h('p', { class: 'progress' }, L.share.name),
        h('h1', null, s.name),
        s.verses.map((v) => passage(v)),
        ourNote(s.note),
        h('div', { class: 'ask' }, h('p', { class: 'small-label' }, s.askLabel + ':'), h('p', { class: 'say-aloud' }, s.ask)),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/' }, L.nav.back),
          h('a', { class: 'btn primary grow', href: '#/share/cost', onclick: () => resetFlow(SHARE) }, s.next)),
      ],
    };
  }

  // Screen 2, read together. Nothing said here is typed or put in the prayer.
  function shareCostView() {
    const s = L.share.cost;
    return {
      title: s.name + ' | ' + L.share.name,
      nodes: [
        h('p', { class: 'progress' }, L.share.name),
        h('h1', null, s.name),
        h('p', null, s.intro),
        s.verses.map((v) => passage(v)),
        ourNote(s.extraNote),
        s.extraVerses.map((v) => passage(v)),
        h('div', { class: 'ask' }, h('p', { class: 'small-label' }, L.share.start.askLabel + ':'), h('p', { class: 'say-aloud' }, s.ask)),
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: '#/share/not-today' }, s.no),
          h('a', { class: 'btn primary grow', href: SHARE.q(1, 1) }, s.yes)),
      ],
    };
  }

  function shareNotTodayView() {
    const s = L.share.notToday;
    resetFlow(SHARE);
    return {
      title: s.heading,
      nodes: [
        h('h1', null, s.heading),
        ourNote(s.note),
        h('div', { class: 'actions' }, homeLink(s.home)),
      ],
    };
  }

  // Screen 7: prayers from Scripture, for someone who cannot find words.
  function shareBorrowView() {
    const s = L.share.borrow;
    return {
      title: s.name + ' | ' + L.share.name,
      nodes: [
        h('p', { class: 'progress' }, L.share.name),
        h('h1', null, s.name),
        ourNote(s.note),
        s.prayers.map((r, j) => {
          const id = 'use-' + (j + 1);
          const box = h('input', {
            type: 'checkbox', id, checked: SHARE.borrowed.includes(r),
            onchange: (e) => {
              // Keep the order they are listed in, whatever order they are ticked.
              const on = new Set(SHARE.borrowed.filter((x) => x !== r));
              if (e.target.checked) on.add(r);
              SHARE.borrowed = s.prayers.filter((x) => on.has(x));
            },
          });
          return h('div', { class: 'borrowed' }, passage([r]),
            h('label', { class: 'check', for: id }, box, h('span', null, s.use + ': ' + refLabel([r]))));
        }),
        h('div', { class: 'actions nav' },
          h('button', { type: 'button', class: 'btn', onclick: () => history.back() }, L.nav.back),
          h('a', { class: 'btn primary grow', href: SHARE.review }, s.done)),
      ],
    };
  }

  // After the prayer: Scripture's assurance and honest warning, and next steps.
  // Nothing here says what the person's standing is. The Scripture is shown and left there.
  function shareAfterView() {
    const s = L.share.after;
    return {
      title: s.heading,
      nodes: [
        h('h1', null, s.heading),
        s.sections.map((sec) => [h('h2', null, sec.heading), sec.verses.map((v) => passage(v)), ourNote(sec.note)]),
        h('h2', null, s.nextHeading),
        h('ol', { class: 'next-steps' }, s.next.map((item) =>
          h('li', null, h('p', null, h('strong', null, item.link ? h('a', { href: '#/bible/' + item.link }, item.text) : item.text)),
            item.verses.map((v) => passage(v))))),
        ourNote(s.leaderNote),
        h('div', { class: 'actions' }, homeLink(s.home)),
      ],
    };
  }

  function aboutView() {
    const a = L.about;
    return {
      title: a.heading,
      nodes: [
        h('h1', null, a.heading),
        h('h2', null, a.whoHeading), paragraphs(a.who),
        h('h2', null, a.howHeading), paragraphs(a.how),
        h('h2', { id: 'install' }, a.installHeading), paragraphs(a.install),
        h('h2', null, a.privacyHeading), paragraphs(a.privacy),
        h('h2', null, a.sourcesHeading), paragraphs(a.sources),
        h('h2', null, a.doxologyHeading), h('p', null, a.doxology),
        h('h2', null, a.licenseHeading), h('p', null, a.license),
        a.sourceCodeUrl && h('p', null, h('a', { href: a.sourceCodeUrl, rel: 'noopener noreferrer' }, a.sourceCodeLabel)),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/' }, L.nav.back)),
      ],
    };
  }

  /* ---------- Bible study ---------- */

  // Books live in bible/<CODE>.json, made from the WEB files by tools/build_bible.py.
  // A book is kept on the device (Cache Storage) the first time it is opened.
  const B = () => L.bible;
  const bookInfo = (code) => IDX.books.find((b) => b.code === code);
  // "John 3", "Psalm 23": the source gives Psalms its own word for one chapter.
  const chapterTitle = (info, ch) => (info.chapterName || info.name) + ' ' + ch;
  const bibleCacheName = () => 'teach-us-to-pray-bible-' + IDX.version;
  const fill = (text, values) => Object.entries(values).reduce((t, [k, v]) => t.split('{' + k + '}').join(v), text);
  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  const sizes = () => ({
    download: mb(IDX.books.reduce((n, b) => n + b.download, 0)),
    stored: mb(IDX.books.reduce((n, b) => n + b.size, 0)),
  });
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // Opening a cache creates it, so only open it to store something; to read, ask without opening.
  async function openCache() {
    try { return window.caches ? await caches.open(bibleCacheName()) : null; } catch (e) { return null; }
  }
  async function keptHere(url) {
    try { return window.caches && await caches.has(bibleCacheName()) ? await caches.match(url, { cacheName: bibleCacheName() }) : null; } catch (e) { return null; }
  }

  // Open a book: from this device if it is kept here, otherwise download it and keep it.
  async function getBook(code) {
    if (BOOKS.has(code)) return BOOKS.get(code);
    const url = 'bible/' + code + '.json';
    let res = await keptHere(url);
    let saved = !!res;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error('not found');
      const cache = await openCache();
      if (cache) { try { await cache.put(url, res.clone()); saved = true; } catch (e) { /* storage full */ } }
    }
    const book = await res.json();
    book.saved = saved;
    BOOKS.set(code, book);
    return book;
  }

  async function savedCount() {
    try { if (!window.caches || !(await caches.has(bibleCacheName()))) return 0; } catch (e) { return 0; }
    const cache = await openCache();
    if (!cache) return 0;
    const files = new Set((await cache.keys()).map((r) => r.url.split('/').pop()));
    return IDX.books.filter((b) => files.has(b.code + '.json')).length;
  }

  // "Keep the whole Bible on this device": download every book not yet kept here.
  async function keepWholeBible(status) {
    if (downloading) return false;
    downloading = true;
    const cache = await openCache();
    let ok = !!cache;
    try {
      const have = new Set((await cache.keys()).map((r) => r.url.split('/').pop()));
      let n = 0;
      for (const b of IDX.books) {
        const url = 'bible/' + b.code + '.json';
        if (!have.has(b.code + '.json')) {
          const res = await fetch(url);
          if (!res.ok) throw new Error('download');
          await cache.put(url, res);
        }
        n += 1;
        status.textContent = fill(B().downloading, { n, total: IDX.books.length });
      }
      BOOKS.forEach((book) => { book.saved = true; });
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
      status.textContent = B().allHere;
    } catch (e) {
      ok = false;
      status.textContent = B().stopped;
    }
    downloading = false;
    return ok;
  }

  // The offline section of the Bible study screen. It fills in once it knows what is kept here.
  function offlineSection(after) {
    const status = h('p', { class: 'status', role: 'status' });
    const body = h('div');
    const section = h('section', { class: 'offline-section', 'aria-labelledby': 'offline-heading' },
      h('h2', { id: 'offline-heading' }, B().offlineHeading),
      h('p', null, B().offlineText), body, status,
      !after && TSKI && xrefOfflinePart());
    if (!window.caches) return section;
    savedCount().then((n) => {
      if (n >= IDX.books.length) {
        body.replaceChildren(
          h('p', { class: 'saved-line' }, B().allHere),
          h('button', {
            type: 'button', class: 'btn danger',
            onclick: async () => { await caches.delete(bibleCacheName()); BOOKS.clear(); render(false); },
          }, B().remove),
          h('p', { class: 'hint' }, B().removeHint));
      } else {
        const keepBtn = h('button', {
          type: 'button', class: 'btn primary',
          onclick: async () => { keepBtn.disabled = true; if (await keepWholeBible(status)) { if (after) after(); else render(false); } else keepBtn.disabled = false; },
        }, B().keepAll);
        body.replaceChildren(keepBtn, h('p', { class: 'hint' }, fill(B().keepAllSize, sizes())));
      }
    });
    return section;
  }

  // "John 3:16", "Ps 23", "1 John 1:9", "Psalm 151", "Romans" -> { code, ch, v }
  function findPassage(query) {
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const findBook = (name) => {
      const q = norm(name);
      if (!q) return null;
      return IDX.books.find((b) => norm(b.name) === q) || IDX.books.find((b) => norm(b.code) === q)
        || IDX.books.find((b) => norm(b.name).startsWith(q)) || null;
    };
    const m = query.trim().match(/^(.+?)\s*(\d+)(?:\s*[:.]\s*(\d+))?\s*$/);
    if (m) {
      const book = findBook(m[1]);
      const ch = parseInt(m[2], 10);
      // A chapter the book does not have opens the book's list of chapters.
      if (book && ch >= 1 && ch <= book.chapters) return { code: book.code, ch, v: m[3] ? parseInt(m[3], 10) : null };
      if (book && !findBook(query)) return { code: book.code, ch: null, v: null };
    }
    const whole = findBook(query);
    return whole ? { code: whole.code, ch: null, v: null } : null;
  }
  const passageHref = (p) => '#/bible/' + p.code + (p.ch ? '/' + p.ch + (p.v ? '/' + p.v : '') : '');

  function searchForm(q, shelf) {
    const input = h('input', { type: 'search', id: 'bible-q', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    input.value = q || '';
    const select = h('select', { id: 'bible-shelf' },
      h('option', { value: 'all' }, B().allBooks),
      Object.entries(B().shelves).map(([k, name]) => h('option', { value: k }, name)));
    select.value = shelf || 'all';
    return h('form', {
      class: 'bible-form', role: 'search',
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) location.hash = '#/bible/search/' + encodeURIComponent(input.value.trim()) + '/' + select.value;
      },
    },
    h('label', { for: 'bible-q' }, B().searchLabel), input,
    h('label', { for: 'bible-shelf', class: 'small-label' }, B().searchIn), select,
    h('button', { type: 'submit', class: 'btn' }, B().search));
  }

  function bibleHomeView() {
    const place = store.get(PLACE_KEY);
    const [pCode, pCh] = (place || '').split('/');
    const placeBook = pCode && bookInfo(pCode);
    const goInput = h('input', { type: 'text', id: 'bible-go', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'bible-go-hint', enterkeyhint: 'go' });
    const goStatus = h('p', { class: 'status', role: 'status' });
    return {
      title: B().heading,
      nodes: [
        h('h1', null, B().heading),
        h('div', { class: 'actions' },
          placeBook && h('a', { class: 'btn primary', href: '#/bible/' + pCode + '/' + pCh },
            fill(B().continue, { ref: chapterTitle(placeBook, pCh) })),
          h('a', { class: 'btn', href: '#/study' }, T().myStudy), listenContinue()),
        h('form', {
          class: 'bible-form',
          onsubmit: (e) => {
            e.preventDefault();
            const found = findPassage(goInput.value);
            if (found) location.hash = passageHref(found);
            else goStatus.textContent = B().notFound;
          },
        },
        h('label', { for: 'bible-go' }, B().goLabel), goInput,
        h('p', { class: 'hint', id: 'bible-go-hint' }, B().goHint),
        h('button', { type: 'submit', class: 'btn' }, B().go), goStatus),
        searchForm('', 'all'),
        Object.entries(B().shelves).map(([shelf, name]) => h('section', { class: 'shelf-section', 'aria-labelledby': 'shelf-' + shelf },
          h('h2', { id: 'shelf-' + shelf }, name),
          shelf === 'ap' && [h('p', { class: 'hint' }, B().apLine), h('p', { class: 'hint' }, B().greekLine)],
          h('ul', { class: 'book-list' }, IDX.books.filter((b) => b.shelf === shelf).map((b) =>
            h('li', null, h('a', { href: '#/bible/' + b.code }, b.name)))))),
        offlineSection(),
      ],
    };
  }

  function bookView(info) {
    if (info.chapters === 1) return chapterView(info, 1, null);
    return {
      title: info.name,
      nodes: [
        h('p', { class: 'shelf' }, B().shelves[info.shelf]),
        h('h1', null, info.name),
        h('h2', null, B().chapters),
        h('ul', { class: 'chapter-grid' }, Array.from({ length: info.chapters }, (_, i) =>
          h('li', null, h('a', { href: '#/bible/' + info.code + '/' + (i + 1), 'aria-label': fill(B().chapterLabel, { n: i + 1 }) }, String(i + 1))))),
        h('div', { class: 'actions nav' }, h('a', { class: 'btn', href: '#/bible' }, B().books)),
      ],
    };
  }

  // The chapter before or after, across books, in shelf order.
  function neighbour(info, ch, step) {
    const i = IDX.books.indexOf(info);
    if (ch + step >= 1 && ch + step <= info.chapters) return { info, ch: ch + step };
    const other = IDX.books[i + step];
    return other ? { info: other, ch: step > 0 ? 1 : other.chapters } : null;
  }

  // A small numbered button for a translators' note. The note opens just below its paragraph.
  function noteButton(n, ref, text, para) {
    const btn = h('button', {
      type: 'button', class: 'fn', 'aria-expanded': 'false', 'aria-label': fill(B().noteMarker, { n }),
      onclick: () => {
        const open = main.querySelector('aside.tnote');
        const wasMine = open && open.dataset.n === String(n);
        if (open) { open.remove(); main.querySelectorAll('.fn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
        if (wasMine) return;
        const close = h('button', { type: 'button', class: 'btn small', onclick: () => { aside.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } }, B().close);
        const aside = h('aside', { class: 'tnote', 'data-n': String(n) },
          h('p', { class: 'tnote-label' }, fill(B().noteHeading, { ref })),
          h('p', null, text), close);
        para.after(aside);
        btn.setAttribute('aria-expanded', 'true');
        close.focus();
      },
    }, String(n));
    return btn;
  }

  const HEADING_KINDS = new Set(['d', 's', 's1', 's2', 'ms', 'ms1', 'ms2', 'mr', 'sp', 'is', 'is1']);

  // The words of each verse sit in a span (data-v), so bookmarks can tint them. A verse number
  // is a button that opens the verse's panel for bookmarks and notes.
  function chapterText(book, chapter) {
    const showNotes = store.get(HIDE_NOTES_KEY) !== '1';
    const info = bookInfo(book.code);
    const wrap = h('div', { class: 'text' });
    const numbers = [];
    let n = 0;
    let verse = null;
    let first = null;
    for (const [kind, ...tokens] of chapter.b) {
      if (kind === 'b') { wrap.append(h('div', { class: 'gap', 'aria-hidden': 'true' })); continue; }
      const heading = HEADING_KINDS.has(kind);
      const para = h('p', { class: 'k-' + kind + (heading ? ' heading' : '') });
      let span = null;
      const into = () => {
        if (heading || first == null) return para;
        if (!span) { span = h('span', { class: 'vt', 'data-v': String(first) }); para.append(span); }
        return span;
      };
      for (const t of tokens) {
        if (typeof t === 'string') into().append(t);
        else if (typeof t === 'number' || t.v) {
          verse = typeof t === 'number' ? t : t.v;
          first = parseInt(String(verse), 10);
          numbers.push(first);
          const v = first;
          const btn = h('button', {
            type: 'button', class: 'vn', id: 'v' + v, 'aria-expanded': 'false',
            'aria-label': fill(T().verseButton, { v: verse }),
            onclick: () => versePanel(btn, info, chapter.n, v, numbers),
          }, String(verse));
          para.append(btn);
          span = null;
        } else if (t.f != null && showNotes) {
          n += 1;
          into().append(noteButton(n, chapterTitle(info, chapter.n) + (verse ? ':' + verse : ''), t.f, para));
        }
      }
      wrap.append(para);
    }
    markChapter(wrap, book.code, chapter.n);
    return wrap;
  }

  function chapterView(info, ch, verse) {
    const ready = BOOKS.get(info.code);
    const build = (book) => {
      const chapter = book.chapters[ch - 1];
      if (!chapter) return null;
      store.set(PLACE_KEY, info.code + '/' + ch);
      const status = h('p', { class: 'status', role: 'status' });
      const prev = neighbour(info, ch, -1);
      const next = neighbour(info, ch, 1);
      const link = (x) => x && h('a', { class: 'btn' + (x === next ? ' primary grow' : ''), href: '#/bible/' + x.info.code + '/' + x.ch }, chapterTitle(x.info, x.ch));
      const notesBox = h('input', {
        type: 'checkbox', id: 'show-notes', 'aria-describedby': 'show-notes-hint', checked: store.get(HIDE_NOTES_KEY) !== '1',
        onchange: (e) => { store.set(HIDE_NOTES_KEY, e.target.checked ? null : '1'); render(false); },
      });
      return {
        title: chapterTitle(info, ch),
        verse,
        after: () => {
          const v = reopenVerse;
          reopenVerse = null;
          const btn = v && document.getElementById('v' + v);
          if (btn) btn.click();
        },
        nodes: [
          h('p', { class: 'shelf' }, B().shelves[info.shelf]),
          h('h1', null, chapterTitle(info, ch)),
          listenSlot(info, ch),
          // Once closed, the line stays closed on this device. "Not on this device yet" always shows.
          book.saved && store.get(HIDE_SAVED_KEY) !== '1' && h('p', { class: 'saved-line dismissible' }, B().saved,
            h('button', {
              type: 'button', class: 'dismiss', 'aria-label': B().close,
              onclick: (e) => { store.set(HIDE_SAVED_KEY, '1'); e.currentTarget.parentElement.remove(); main.querySelector('h1').focus(); },
            }, '×')),
          store.get(HIDE_TIP_KEY) !== '1' && h('p', { class: 'tip dismissible' }, T().tip,
            h('button', {
              type: 'button', class: 'dismiss', 'aria-label': B().close,
              onclick: (e) => { store.set(HIDE_TIP_KEY, '1'); e.currentTarget.parentElement.remove(); main.querySelector('h1').focus(); },
            }, '×')),
          chapterText(book, chapter),
          h('div', { class: 'actions' },
            h('a', { class: 'btn', href: '#/bible' }, B().books),
            info.chapters > 1 && h('a', { class: 'btn', href: '#/bible/' + info.code }, B().chapters),
            h('button', {
              type: 'button', class: 'btn',
              onclick: async () => { status.textContent = (await copyText(location.href)) ? B().linkCopied : L.prayer.copyFailed; },
            }, B().copyLink)),
          status,
          h('div', { class: 'reader-settings' },
            h('label', { class: 'check', for: 'show-notes' }, notesBox, h('span', null, B().showNotes)),
            h('p', { class: 'hint', id: 'show-notes-hint' }, B().showNotesHint)),
          h('div', { class: 'actions nav' }, link(prev), link(next)),
        ],
      };
    };
    if (ready) return build(ready);
    const later = getBook(info.code).then(build, () => ({
      title: info.name,
      nodes: [
        h('p', { class: 'shelf' }, B().shelves[info.shelf]),
        h('h1', null, chapterTitle(info, ch)),
        h('p', { class: 'standout' }, fill(B().notHere, { book: info.name })),
        h('div', { class: 'actions nav' }, h('a', { class: 'btn', href: '#/bible' }, B().books)),
      ],
    }));
    later.loading = { title: info.name, nodes: [h('p', { class: 'status', role: 'status' }, fill(B().opening, { book: info.name }))] };
    return later;
  }

  // Every verse of a book as plain text, for searching. Headings and notes are left out.
  function versesOf(book) {
    if (book.verses) return book.verses;
    const out = [];
    for (const chapter of book.chapters) {
      let cur = null;
      for (const [kind, ...tokens] of chapter.b) {
        if (HEADING_KINDS.has(kind)) continue;
        for (const t of tokens) {
          if (typeof t === 'number' || (t && t.v)) { cur = { ch: chapter.n, v: typeof t === 'number' ? t : t.v, text: '' }; out.push(cur); }
          else if (typeof t === 'string' && cur) cur.text += t;
        }
        if (cur) cur.text += ' ';
      }
    }
    out.forEach((x) => { x.text = x.text.replace(/\s+/g, ' ').trim(); });
    book.verses = out;
    return out;
  }

  function searchView(query, shelf) {
    const q = decodeURIComponent(query || '');
    const books = IDX.books.filter((b) => shelf === 'all' || !B().shelves[shelf] || b.shelf === shelf);
    const words = q.toLowerCase().replace(/’/g, "'").split(/\s+/).filter(Boolean);
    const noteHits = words.length ? STUDY.notes.filter((n) => words.every((w) => ((n.title || '') + ' ' + (n.text || '')).toLowerCase().replace(/’/g, "'").includes(w))) : [];
    const head = [h('h1', null, B().searchLabel), searchForm(q, shelf),
      noteHits.length > 0 && h('section', { class: 'note-hits' }, h('h2', null, T().inMyNotes),
        h('ul', { class: 'backlinks' }, noteHits.map((n) => h('li', null, h('a', { href: '#/study/note/' + n.id }, noteName(n)),
          n.code && h('span', { class: 'muted' }, ' · ' + rangeLabel(n))))))];
    const run = async () => {
      if (window.caches && (await savedCount()) < IDX.books.length) {
        return {
          title: B().searchLabel,
          nodes: [head, h('p', { class: 'standout' }, fill(B().needAll, sizes())), offlineSection(() => render(false))],
        };
      }
      const found = [];
      for (const info of books) {
        const book = await getBook(info.code);
        for (const x of versesOf(book)) {
          const t = x.text.toLowerCase().replace(/’/g, "'");
          if (words.every((w) => t.includes(w))) found.push({ info, x });
        }
      }
      const shown = found.slice(0, 200);
      const pattern = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")).join('|') + ')', 'gi');
      const marked = (text) => text.split(pattern).map((part, i) => (i % 2 ? h('mark', null, part) : part));
      return {
        title: B().searchLabel,
        nodes: [
          head,
          h('p', { class: 'standout', role: 'status' }, found.length
            ? fill(found.length === 1 ? B().foundOne : B().found, { n: found.length, q })
            : fill(B().none, { q })),
          found.length > 200 && h('p', { class: 'hint' }, B().first200),
          h('ol', { class: 'results' }, shown.map(({ info, x }) => h('li', null,
            h('a', { href: '#/bible/' + info.code + '/' + x.ch + '/' + String(x.v).split('-')[0] }, chapterTitle(info, x.ch) + ':' + x.v),
            h('p', null, marked(x.text))))),
        ],
      };
    };
    if (!words.length) return { title: B().searchLabel, nodes: head };
    const later = run().catch(() => ({ title: B().searchLabel, nodes: [head, h('p', { class: 'standout' }, B().stopped)] }));
    later.loading = { title: B().searchLabel, nodes: head };
    return later;
  }

  function bibleView(a, b, c) {
    if (a === 'search') return searchView(b, c || 'all');
    const info = a && bookInfo(a);
    if (!info) return bibleHomeView();
    const ch = parseInt(b, 10);
    if (!ch) return bookView(info);
    if (ch < 1 || ch > info.chapters) return bookView(info);
    return chapterView(info, ch, parseInt(c, 10) || null);
  }

  /* ---------- Cross-references: the Treasury of Scripture Knowledge ---------- */

  // tsk/<CODE>.json, made from the CrossWire TSK by tools/build_tsk.py: for each verse, groups of
  // [heading in the KJV's words or null, references]. A reference is "PSA 33:6", "1JN 4:9-10",
  // "ISA 13:1-14:32", or "?" + the TSK's own words when it matches no verse with text in the WEB.
  // "ROM 16:25=ROM 14:24": the one remapping (KJV Romans 16:25-27 is WEB Romans 14:24-26, as the
  // WEB's note says). It is labelled as the TSK wrote it and previews the WEB's verses.
  // Each book's file is kept on the device when first opened, in its own cache (TSK in sw.js).
  const X = () => L.xref;
  const XREFS = new Map();
  const tskCacheName = () => 'teach-us-to-pray-tsk-' + TSKI.version;
  const tskInfo = (code) => TSKI.books.find((b) => b.code === code);
  const tskSizes = () => ({
    download: mb(TSKI.books.reduce((n, b) => n + b.download, 0)),
    stored: mb(TSKI.books.reduce((n, b) => n + b.size, 0)),
  });
  let downloadingTsk = false;

  async function getXrefs(code) {
    if (XREFS.has(code)) return XREFS.get(code);
    const url = 'tsk/' + code + '.json';
    let res = null;
    try { if (window.caches && await caches.has(tskCacheName())) res = await caches.match(url, { cacheName: tskCacheName() }); } catch (e) { res = null; }
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error('not found');
      try { if (window.caches) await (await caches.open(tskCacheName())).put(url, res.clone()); } catch (e) { /* storage full */ }
    }
    const data = await res.json();
    XREFS.set(code, data);
    return data;
  }

  async function tskSavedCount() {
    try {
      if (!window.caches || !(await caches.has(tskCacheName()))) return 0;
      const files = new Set((await (await caches.open(tskCacheName())).keys()).map((r) => r.url.split('/').pop()));
      return TSKI.books.filter((b) => files.has(b.code + '.json')).length;
    } catch (e) { return 0; }
  }

  async function keepAllXrefs(status) {
    if (downloadingTsk) return false;
    downloadingTsk = true;
    let ok = true;
    try {
      const cache = await caches.open(tskCacheName());
      const have = new Set((await cache.keys()).map((r) => r.url.split('/').pop()));
      let n = 0;
      for (const b of TSKI.books) {
        const url = 'tsk/' + b.code + '.json';
        if (!have.has(b.code + '.json')) {
          const res = await fetch(url);
          if (!res.ok) throw new Error('download');
          await cache.put(url, res);
        }
        n += 1;
        status.textContent = fill(X().downloading, { n, total: TSKI.books.length });
      }
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
      status.textContent = X().allHere;
    } catch (e) {
      ok = false;
      status.textContent = B().stopped;
    }
    downloadingTsk = false;
    return ok;
  }

  // The cross-references part of "Offline reading": a separate download.
  function xrefOfflinePart() {
    const status = h('p', { class: 'status', role: 'status' });
    const body = h('div', { class: 'xref-offline' });
    if (!window.caches) return null;
    tskSavedCount().then((n) => {
      if (n >= TSKI.books.length) {
        body.replaceChildren(
          h('p', { class: 'saved-line' }, X().allHere),
          h('button', { type: 'button', class: 'btn danger', onclick: async () => { await caches.delete(tskCacheName()); XREFS.clear(); render(false); } }, X().remove),
          status);
      } else {
        const keepBtn = h('button', {
          type: 'button', class: 'btn',
          onclick: async () => { keepBtn.disabled = true; if (await keepAllXrefs(status)) render(false); else keepBtn.disabled = false; },
        }, X().keep);
        body.replaceChildren(keepBtn, h('p', { class: 'hint' }, fill(X().keepSize, tskSizes())), status);
      }
    });
    return body;
  }

  // "PSA 33:6" -> { code, ch, v1, v2, ch2 } ; label "Psalm 33:6"
  function parseXref(r) {
    const m = r.match(/^(\S+) (\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/);
    if (!m) return null;
    const ch = +m[2];
    const v1 = +m[3];
    const ch2 = m[4] ? +m[4] : ch;
    const v2 = m[5] ? +m[5] : v1;
    return { code: m[1], ch, v1, ch2, v2 };
  }
  function xrefLabel(x) {
    const info = bookInfo(x.code);
    const name = info.chapterName || info.name;
    if (x.ch2 !== x.ch) return name + ' ' + x.ch + ':' + x.v1 + '-' + x.ch2 + ':' + x.v2;
    return name + ' ' + x.ch + ':' + x.v1 + (x.v2 > x.v1 ? '-' + x.v2 : '');
  }

  // One reference: a button that previews the verse in WEB text, a link for a span of chapters
  // (too long to preview), or plain text when it matches no verse in the WEB.
  function xrefItem(r) {
    if (r[0] === '?') return h('li', { class: 'xref-plain' }, r.slice(1));
    const [shown, target] = r.split('=');
    const x = parseXref(target || shown);
    const label = parseXref(shown);
    if (!x || !bookInfo(x.code)) return h('li', { class: 'xref-plain' }, r);
    const href = '#/bible/' + x.code + '/' + x.ch + '/' + x.v1;
    if (x.ch2 !== x.ch) return h('li', null, h('a', { class: 'xref-link', href }, xrefLabel(label)));
    const li = h('li');
    const btn = h('button', {
      type: 'button', class: 'xref', 'aria-expanded': 'false',
      onclick: async () => {
        const open = li.querySelector('.xref-preview');
        if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
        const box = h('div', { class: 'xref-preview' }, h('p', { class: 'status' }, fill(B().opening, { book: bookInfo(x.code).name })));
        li.append(box);
        btn.setAttribute('aria-expanded', 'true');
        try {
          const book = await getBook(x.code);
          const text = versesOf(book).filter((y) => y.ch === x.ch && +String(y.v).split('-')[0] >= x.v1 && +String(y.v).split('-')[0] <= x.v2).map((y) => y.text).join(' ');
          box.replaceChildren(...[h('blockquote', null, h('p', null, text)),
            target && h('p', { class: 'hint' }, X().romansLine),
            h('a', { class: 'btn small', href }, X().openChapter)].filter(Boolean));
        } catch (e) {
          box.replaceChildren(h('p', { class: 'hint' }, fill(B().notHere, { book: bookInfo(x.code).name })));
        }
      },
    }, xrefLabel(label));
    li.append(btn);
    return li;
  }

  const FIRST_REFS = 5;
  function xrefGroups(groups) {
    return groups.map(([heading, refs]) => {
      const list = h('ul', { class: 'xref-list' }, refs.slice(0, FIRST_REFS).map(xrefItem));
      const more = refs.length > FIRST_REFS && h('button', {
        type: 'button', class: 'btn small',
        onclick: (e) => { refs.slice(FIRST_REFS).forEach((r) => list.append(xrefItem(r))); e.currentTarget.remove(); },
      }, fill(X().showAll, { n: refs.length }));
      // The TSK ends each heading with a period ("gave."); it is left off on screen only.
      // The stored data keeps it, exactly as the TSK wrote it.
      return h('div', { class: 'xref-group' }, heading && h('p', { class: 'xref-heading' }, heading.replace(/\.$/, '')), list, more);
    });
  }

  // The closed "Cross-references" section in a verse panel. It loads the book's file when opened.
  function xrefSection(info, ch, v) {
    if (!TSKI || !tskInfo(info.code)) return null;
    const body = h('div', { class: 'xref-body' });
    let loaded = false;
    const section = h('details', {
      class: 'xref-section',
      ontoggle: async () => {
        if (!section.open || loaded) return;
        loaded = true;
        body.replaceChildren(h('p', { class: 'status' }, fill(B().opening, { book: info.name })));
        try {
          const data = await getXrefs(info.code);
          const groups = data.verses[ch + ':' + v] || [];
          body.replaceChildren(...[
            h('p', { class: 'xref-source' }, X().source),
            groups.some((g) => g[0]) && h('p', { class: 'hint' }, X().kjv),
            xrefGroups(groups)].flat().filter(Boolean));
          section.scrollIntoView({ block: 'nearest' });
        } catch (e) {
          loaded = false;
          body.replaceChildren(h('p', { class: 'hint' }, fill(X().notHere, { book: info.name })));
        }
      },
    }, h('summary', null, X().heading), body);
    return section;
  }

  /* ---------- My study: bookmarks and notes ---------- */

  // Kept in localStorage under STUDY_KEY, on this device only, and only because the person
  // made them. A note being written is kept for the visit in sessionStorage (NOTE_DRAFT_KEY)
  // until it is saved or cancelled. Nothing from the prayer screens ever becomes a note.
  const T = () => L.study;
  const COLORS = ['gold', 'blue', 'green', 'rose', 'purple', 'gray'];
  let STUDY = null;
  let reopenVerse = null; // reopen a verse's panel after the chapter is drawn again

  function emptyStudy() { return { app: 'teach-us-to-pray', version: 1, colors: {}, bookmarks: [], notes: [], lastBackup: null }; }
  function loadStudy() {
    try {
      const d = JSON.parse(localStorage.getItem(STUDY_KEY));
      if (d && Array.isArray(d.notes) && Array.isArray(d.bookmarks)) return Object.assign(emptyStudy(), d);
    } catch (e) { /* storage unavailable */ }
    return emptyStudy();
  }
  function saveStudy() {
    try { localStorage.setItem(STUDY_KEY, JSON.stringify(STUDY)); return true; } catch (e) { return false; }
  }
  const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const now = () => new Date().toISOString();
  const colorName = (c) => (STUDY.colors[c] || '').trim() || T().colors[c];
  const normTitle = (t) => (t || '').trim().toLowerCase();

  const sessionGet = (k) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } };
  const sessionSet = (k, v) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  // "John 3:16" or "John 3:16-18"
  function rangeLabel(r) {
    const info = bookInfo(r.code);
    return (info ? chapterTitle(info, r.ch) : r.code + ' ' + r.ch) + ':' + r.v1 + (r.v2 > r.v1 ? '-' + r.v2 : '');
  }
  const rangeHref = (r) => '#/bible/' + r.code + '/' + r.ch + '/' + r.v1;
  const covers = (r, code, ch, v) => r.code === code && r.ch === ch && v >= r.v1 && v <= (r.v2 || r.v1);
  function noteName(n) {
    if ((n.title || '').trim()) return n.title.trim();
    if (n.code) return fill(T().noteTitleOn, { ref: rangeLabel(n) });
    const first = (n.text || '').trim().split('\n')[0];
    return first ? (first.length > 60 ? first.slice(0, 60) + '…' : first) : T().untitled;
  }
  const byOrder = (a, b) => IDX.books.findIndex((x) => x.code === a.code) - IDX.books.findIndex((x) => x.code === b.code) || a.ch - b.ch || a.v1 - b.v1;

  // References and [[note titles]] in a note, in the order they appear.
  // A reference needs a chapter and verse ("Rom 8:28"), or a whole book name and a chapter ("Psalm 23").
  const LINK = /\[\[([^\]\n]+)\]\]|((?:[1-4] ?)?[A-Z][a-z]+(?: (?:of )?[A-Z][a-z]+)*)\.? (\d{1,3})(?::(\d{1,3})(?: ?[-–] ?(\d{1,3}))?)?/g;
  function resolveRef(name, ch, v1, v2) {
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const words = name.split(' ');
    for (let i = 0; i < words.length; i++) {
      const q = norm(words.slice(i).join(' '));
      if (!q || /^\d+$/.test(q)) continue;
      const book = IDX.books.find((b) => norm(b.name) === q || norm(b.chapterName || '') === q || norm(b.code) === q)
        || (v1 && q.replace(/^\d/, '').length >= 2 && IDX.books.find((b) => norm(b.name).startsWith(q)));
      if (book && ch >= 1 && ch <= book.chapters) {
        const start = v1 ? parseInt(v1, 10) : 1;
        return { code: book.code, ch: parseInt(ch, 10), v1: start, v2: v2 ? Math.max(start, parseInt(v2, 10)) : start, lead: words.slice(0, i).join(' '), whole: !v1 };
      }
    }
    return null;
  }
  function scanNote(text, onText, onRef, onTitle) {
    LINK.lastIndex = 0;
    let at = 0;
    let m;
    while ((m = LINK.exec(text))) {
      if (m[1] != null) { onText(text.slice(at, m.index)); onTitle(m[1], m[0]); at = LINK.lastIndex; continue; }
      const ref = resolveRef(m[2], m[3], m[4], m[5]);
      if (!ref) { LINK.lastIndex = m.index + 1; continue; }
      const lead = ref.lead ? ref.lead + ' ' : '';
      onText(text.slice(at, m.index) + lead);
      onRef(ref, m[0].slice(lead.length));
      at = LINK.lastIndex;
    }
    onText(text.slice(at));
  }
  const refsIn = (text) => { const out = []; scanNote(text || '', () => {}, (r) => out.push(r), () => {}); return out; };
  const titlesIn = (text) => { const out = []; scanNote(text || '', () => {}, () => {}, (t) => out.push(normTitle(t))); return out; };
  // The newest note with this title, so a [[link]] always opens one note.
  const noteByTitle = (t) => STUDY.notes.filter((n) => normTitle(n.title) === normTitle(t)).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))[0];

  // The note's words exactly as typed, with references and [[titles]] made into links.
  function linkedText(text) {
    const out = [];
    scanNote(text,
      (t) => { if (t) out.push(t); },
      (r, shown) => out.push(h('a', { class: 'reflink', href: rangeHref(r) }, shown)),
      (t, shown) => { const n = noteByTitle(t); out.push(n ? h('a', { class: 'notelink', href: '#/study/note/' + n.id }, shown) : shown); });
    return out;
  }

  // Bookmarks and notes drawn into a chapter: tint, a hidden "Bookmarked: …" for screen readers,
  // and a small button after a verse that has a note.
  function markChapter(wrap, code, ch) {
    const spans = (v) => [...wrap.querySelectorAll('.vt[data-v="' + v + '"]')];
    for (const b of STUDY.bookmarks.filter((x) => x.code === code && x.ch === ch)) {
      for (let v = b.v1; v <= (b.v2 || b.v1); v++) spans(v).forEach((s) => s.classList.add('mark', 'mark-' + b.color));
      const first = spans(b.v1)[0];
      if (first) first.prepend(h('span', { class: 'visually-hidden' }, fill(T().bookmarked, { name: colorName(b.color) }) + '. '));
    }
    for (const n of STUDY.notes.filter((x) => x.code === code && x.ch === ch)) {
      const last = spans(n.v2 || n.v1).pop();
      if (last) last.append(h('a', { class: 'mynote-btn', href: '#/study/note/' + n.id, 'aria-label': fill(T().noteButton, { ref: rangeLabel(n) }) }, '✎'));
    }
  }

  // The panel under a verse: bookmark colours, write or edit a note, and notes that mention it.
  function versePanel(btn, info, ch, v, verseNumbers) {
    const open = main.querySelector('aside.vpanel');
    const wasMine = open && open.dataset.v === String(v);
    if (open) { open.remove(); main.querySelectorAll('.vn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
    if (wasMine) return;
    const code = info.code;
    const mark = STUDY.bookmarks.find((b) => b.code === code && b.ch === ch && b.v1 === v);
    const note = STUDY.notes.filter((n) => n.code === code && n.ch === ch && n.v1 === v).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))[0];
    const later = verseNumbers.filter((x) => x >= v);
    const through = h('select', { id: 'through' }, later.map((x) => h('option', { value: x }, String(x))));
    const start = (mark || note || {}).v2 || v;
    through.value = String(start);
    const title = h('p', { class: 'vpanel-title', tabindex: '-1' }, rangeLabel({ code, ch, v1: v, v2: start }));
    const write = h('a', { class: 'btn primary', href: '#' }, note ? T().editNote : T().writeNote);
    const v2 = () => parseInt(through.value, 10);
    const setWrite = () => { write.href = note ? '#/study/edit/' + note.id : '#/study/new/' + code + '/' + ch + '/' + v + '/' + v2(); };
    setWrite();
    through.addEventListener('change', () => { title.textContent = rangeLabel({ code, ch, v1: v, v2: v2() }); setWrite(); });
    const redraw = () => { saveStudy(); reopenVerse = v; render(false); };
    const mentions = STUDY.notes.filter((n) => n.code !== code || n.ch !== ch || n.v1 !== v).filter((n) => refsIn(n.text).some((r) => covers(r, code, ch, v)));
    const close = h('button', { type: 'button', class: 'btn small', onclick: () => { aside.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } }, B().close);
    const aside = h('aside', { class: 'vpanel', 'data-v': String(v), 'aria-label': rangeLabel({ code, ch, v1: v, v2: v }) },
      title,
      h('label', { for: 'through', class: 'small-label' }, T().throughVerse), through,
      h('p', { class: 'small-label' }, T().bookmark),
      h('div', { class: 'swatches' }, COLORS.map((c) => h('button', {
        type: 'button', class: 'sw sw-' + c + (mark && mark.color === c ? ' on' : ''), 'aria-pressed': String(!!mark && mark.color === c),
        onclick: () => {
          if (mark) Object.assign(mark, { color: c, v2: v2(), updated: now() });
          else STUDY.bookmarks.push({ id: newId(), code, ch, v1: v, v2: v2(), color: c, updated: now() });
          redraw();
        },
      }, h('span', { class: 'dot', 'aria-hidden': 'true' }), colorName(c)))),
      mark && h('button', { type: 'button', class: 'btn danger small', onclick: () => { STUDY.bookmarks = STUDY.bookmarks.filter((b) => b !== mark); redraw(); } }, T().removeBookmark),
      h('div', { class: 'actions' }, write),
      mentions.length > 0 && [h('p', { class: 'small-label' }, T().mentions),
        h('ul', { class: 'backlinks' }, mentions.map((n) => h('li', null, h('a', { href: '#/study/note/' + n.id }, noteName(n)))))],
      xrefSection(info, ch, v),
      close);
    (btn.closest('p') || btn).after(aside);
    btn.setAttribute('aria-expanded', 'true');
    // Focus the title, not the "Through verse" list: focusing a list opens its picker on phones.
    title.focus({ preventScroll: true });
    // Keep the whole panel in view, clear of the pinned Back/Next bar (scroll-margin in app.css).
    aside.scrollIntoView({ block: 'nearest' });
  }

  // Writing or editing a note. Saved only when "Save note" is tapped; until then it is kept
  // for this visit in sessionStorage, so a tab the phone closes in the background loses nothing.
  function noteEditView(target) {
    const existing = target.id ? STUDY.notes.find((n) => n.id === target.id) : null;
    if (target.id && !existing) return myStudyView();
    const range = existing ? (existing.code ? existing : null) : (target.code ? target : null);
    const key = existing ? 'edit:' + existing.id : 'new:' + (range ? [range.code, range.ch, range.v1, range.v2].join('/') : '');
    const draft = sessionGet(NOTE_DRAFT_KEY);
    const mine = draft && draft.key === key ? draft : null;
    const titleBox = h('input', { type: 'text', id: 'note-title', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'note-title-hint' });
    const textBox = h('textarea', { id: 'note-text', rows: '8', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'note-text-hint' });
    titleBox.value = mine ? mine.title : existing ? existing.title || '' : '';
    textBox.value = mine ? mine.text : existing ? existing.text || '' : '';
    const keepDraft = () => sessionSet(NOTE_DRAFT_KEY, { key, title: titleBox.value, text: textBox.value });
    titleBox.addEventListener('input', () => { keepDraft(); dupOk = false; });
    textBox.addEventListener('input', keepDraft);
    const status = h('p', { class: 'status', role: 'status' });
    const away = () => (existing ? '#/study/note/' + existing.id : range ? rangeHref(range) : '#/study');
    let dupOk = false;
    const save = () => {
      if (!titleBox.value.trim() && !textBox.value.trim()) { sessionSet(NOTE_DRAFT_KEY, null); location.hash = away(); return; }
      const clash = normTitle(titleBox.value) && STUDY.notes.some((n) => n !== existing && normTitle(n.title) === normTitle(titleBox.value));
      if (clash && !dupOk) { dupOk = true; status.textContent = fill(T().dupTitle, { title: titleBox.value.trim() }); return; }
      const note = existing || Object.assign({ id: newId(), created: now() }, range ? { code: range.code, ch: range.ch, v1: range.v1, v2: range.v2 } : {});
      Object.assign(note, { title: titleBox.value, text: textBox.value, updated: now() });
      if (!existing) STUDY.notes.push(note);
      if (!saveStudy()) { status.textContent = T().saveFailed; return; }
      sessionSet(NOTE_DRAFT_KEY, null);
      flash = T().saved;
      location.hash = '#/study/note/' + note.id;
    };
    const heading = range ? fill(T().noteOn, { ref: rangeLabel(range) }) : existing ? noteName(existing) : T().newNote;
    return {
      title: heading,
      nodes: [
        h('h1', null, heading),
        h('div', { class: 'ask' },
          h('label', { for: 'note-title' }, T().titleLabel), titleBox,
          h('p', { class: 'hint', id: 'note-title-hint' }, T().titleHint)),
        h('div', { class: 'ask' },
          h('label', { for: 'note-text' }, T().noteLabel), textBox,
          h('p', { class: 'hint', id: 'note-text-hint' }, T().noteHint)),
        status,
        h('div', { class: 'actions nav' },
          h('button', { type: 'button', class: 'btn', onclick: () => { sessionSet(NOTE_DRAFT_KEY, null); location.hash = away(); } }, T().cancel),
          h('button', { type: 'button', class: 'btn primary grow', onclick: save }, T().save)),
        existing && h('div', { class: 'actions' }, h('button', {
          type: 'button', class: 'btn danger',
          onclick: () => {
            if (!window.confirm(T().deleteConfirm)) return;
            STUDY.notes = STUDY.notes.filter((n) => n !== existing);
            saveStudy();
            sessionSet(NOTE_DRAFT_KEY, null);
            location.hash = range ? rangeHref(range) : '#/study';
          },
        }, T().delete)),
      ],
    };
  }

  function noteView(id) {
    const note = STUDY.notes.find((n) => n.id === id);
    if (!note) return myStudyView();
    const status = h('p', { class: 'status', role: 'status' }, flash);
    flash = '';
    const linkers = STUDY.notes.filter((n) => n !== note && normTitle(note.title) && titlesIn(n.text).includes(normTitle(note.title)));
    const build = (verseText) => ({
      title: noteName(note),
      nodes: [
        status,
        h('h1', null, noteName(note)),
        note.copy && h('p', { class: 'badge' }, T().olderCopy),
        note.code && h('figure', { class: 'verse' },
          verseText && h('blockquote', null, h('p', null, verseText)),
          h('figcaption', null, h('a', { href: rangeHref(note) }, rangeLabel(note) + ' · ' + S.abbreviation))),
        h('div', { class: 'mynote' }, h('p', { class: 'mynote-label' }, T().noteLabel), h('p', { class: 'mynote-text' }, linkedText(note.text || ''))),
        linkers.length > 0 && [h('h2', null, T().linkedFrom), h('ul', { class: 'backlinks' }, linkers.map((n) => h('li', null, h('a', { href: '#/study/note/' + n.id }, noteName(n)))))],
        h('div', { class: 'actions nav' },
          h('a', { class: 'btn', href: note.code ? rangeHref(note) : '#/study' }, note.code ? fill(T().backTo, { ref: chapterTitle(bookInfo(note.code), note.ch) }) : T().myStudy),
          h('a', { class: 'btn primary grow', href: '#/study/edit/' + note.id }, T().editNote)),
      ],
    });
    if (!note.code) return build(null);
    // The verse text comes from the Bible files, as everywhere else. Offline and not kept: the reference alone.
    const later = getBook(note.code).then((book) => build(versesOf(book).filter((x) => covers(note, note.code, x.ch, parseInt(x.v, 10))).map((x) => x.text).join(' ')), () => build(null));
    later.loading = { title: noteName(note), nodes: [h('h1', null, noteName(note))] };
    return later;
  }

  // Backups: a readable text file of everything in My study. Restoring adds only what is new.
  function backupText() {
    return JSON.stringify({ app: 'teach-us-to-pray', kind: 'backup', version: 1, saved: now(),
      colors: STUDY.colors, bookmarks: STUDY.bookmarks, notes: STUDY.notes }, null, 2);
  }
  function saveBackup() {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const name = T().fileName + '-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '.json';
    const url = URL.createObjectURL(new Blob([backupText()], { type: 'application/json;charset=utf-8' }));
    const link = h('a', { href: url, download: name, class: 'offscreen' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    STUDY.lastBackup = now();
    saveStudy();
  }
  // Every note and bookmark has an ID, so the same file opened twice adds nothing.
  // A note changed on both devices is kept twice; the older one is marked as an older copy.
  function mergeBackup(doc) {
    const str = (x) => (typeof x === 'string' ? x : '');
    const int = (x) => (Number.isInteger(x) && x > 0 ? x : null);
    const cleanRange = (x) => (bookInfo(x.code) && int(x.ch) && int(x.v1) ? { code: x.code, ch: x.ch, v1: x.v1, v2: Math.max(x.v1, int(x.v2) || x.v1) } : {});
    const same = (a, b) => str(a.title) === str(b.title) && str(a.text) === str(b.text) && a.code === b.code && a.ch === b.ch && a.v1 === b.v1 && a.v2 === b.v2;
    let notes = 0;
    let bookmarks = 0;
    for (const raw of doc.notes) {
      if (!raw || typeof raw.id !== 'string') continue;
      const n = Object.assign({ id: raw.id, title: str(raw.title), text: str(raw.text), created: str(raw.created), updated: str(raw.updated) }, cleanRange(raw), raw.copy ? { copy: true } : {});
      if (STUDY.notes.some((x) => same(x, n))) continue;
      const mine = STUDY.notes.find((x) => x.id === n.id);
      if (!mine) { STUDY.notes.push(n); notes += 1; continue; }
      if (n.updated < mine.updated) STUDY.notes.push(Object.assign(n, { id: newId(), copy: true }));
      else { Object.assign(mine, { id: newId(), copy: true }); STUDY.notes.push(n); }
      notes += 1;
    }
    for (const raw of doc.bookmarks) {
      if (!raw || typeof raw.id !== 'string' || !COLORS.includes(raw.color)) continue;
      const b = Object.assign({ id: raw.id, color: raw.color, updated: str(raw.updated) }, cleanRange(raw));
      if (!b.code) continue;
      const mine = STUDY.bookmarks.find((x) => x.id === b.id || (x.code === b.code && x.ch === b.ch && x.v1 === b.v1));
      if (!mine) { STUDY.bookmarks.push(b); bookmarks += 1; } else if (b.updated > mine.updated) Object.assign(mine, b, { id: mine.id });
    }
    for (const c of COLORS) if (!(STUDY.colors[c] || '').trim() && doc.colors && typeof doc.colors[c] === 'string') STUDY.colors[c] = doc.colors[c];
    return { notes, bookmarks };
  }
  async function openBackup(file, status) {
    let doc = null;
    try { doc = JSON.parse(await file.text()); } catch (e) { doc = null; }
    if (!doc || doc.app !== 'teach-us-to-pray' || doc.kind !== 'backup' || !Array.isArray(doc.notes) || !Array.isArray(doc.bookmarks)) {
      status.textContent = T().notBackup;
      return;
    }
    if (!window.confirm(T().openConfirm)) return;
    const added = mergeBackup(doc);
    saveStudy();
    const count = (n, one, many) => (n === 1 ? one : fill(many, { n }));
    flash = fill(T().added, {
      notes: count(added.notes, T().notesOne, T().notesMany),
      bookmarks: count(added.bookmarks, T().bookmarksOne, T().bookmarksMany),
    });
    render(false);
  }

  function myStudyView() {
    const status = h('p', { class: 'status', role: 'status' }, flash);
    flash = '';
    const search = h('input', { type: 'search', id: 'notes-q', autocomplete: 'off', spellcheck: 'false' });
    const notes = [...STUDY.notes].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const items = notes.map((n) => {
      const li = h('li', null, h('a', { href: '#/study/note/' + n.id }, noteName(n)),
        n.code && h('span', { class: 'muted' }, ' · ' + rangeLabel(n)),
        n.copy && h('span', { class: 'badge' }, T().olderCopy));
      li.dataset.text = ((n.title || '') + ' ' + (n.text || '')).toLowerCase();
      return li;
    });
    search.addEventListener('input', () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      items.forEach((li) => { li.hidden = !words.every((w) => li.dataset.text.includes(w)); });
    });
    const names = COLORS.map((c) => h('input', { type: 'text', id: 'name-' + c, value: colorName(c), 'aria-label': T().colors[c], autocomplete: 'off', spellcheck: 'false' }));
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'offscreen', 'aria-hidden': 'true', tabindex: '-1' });
    const backupStatus = h('p', { class: 'status', role: 'status' });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) openBackup(fileInput.files[0], backupStatus); fileInput.value = ''; });
    // "22 November 2026"
    const longDate = (d) => d.getDate() + ' ' + d.toLocaleDateString(L.meta.lang, { month: 'long' }) + ' ' + d.getFullYear();
    const last = STUDY.lastBackup ? longDate(new Date(STUDY.lastBackup)) : T().never;
    const marks = COLORS.map((c) => [c, STUDY.bookmarks.filter((b) => b.color === c).sort(byOrder)]).filter(([, list]) => list.length);
    return {
      title: T().myStudy,
      nodes: [
        h('h1', null, T().myStudy),
        status,
        h('div', { class: 'bible-form' }, h('label', { for: 'notes-q' }, T().searchNotes), search),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/study/new' }, T().newNote)),
        h('h2', null, T().bookmarks),
        marks.length ? marks.map(([c, list]) => h('div', { class: 'group' },
          h('p', { class: 'gl' }, h('span', { class: 'dot dot-' + c, 'aria-hidden': 'true' }), colorName(c)),
          h('ul', null, list.map((b) => h('li', null, h('a', { href: rangeHref(b) }, rangeLabel(b)))))))
          : h('p', { class: 'muted' }, T().noBookmarks),
        h('details', { class: 'names-form' }, h('summary', null, T().nameColors),
          h('div', { class: 'name-grid' }, COLORS.map((c, i) => h('div', { class: 'name-row' }, h('span', { class: 'dot dot-' + c, 'aria-hidden': 'true' }), names[i]))),
          h('button', {
            type: 'button', class: 'btn',
            onclick: () => { COLORS.forEach((c, i) => { STUDY.colors[c] = names[i].value.trim() === T().colors[c] ? '' : names[i].value.trim(); }); saveStudy(); render(false); },
          }, T().saveNames)),
        h('h2', null, T().notes),
        items.length ? h('ul', { class: 'notes' }, items) : h('p', { class: 'muted' }, T().noNotes),
        h('section', { class: 'backup', 'aria-labelledby': 'backup-heading' },
          h('h2', { id: 'backup-heading' }, T().backupHeading),
          h('p', null, T().backupText),
          h('p', { class: 'warn' }, h('strong', null, T().backupWarnStrong), ' ' + T().backupWarn),
          h('p', { class: 'muted' }, fill(T().lastBackup, { date: last })),
          h('p', { class: 'hint' }, T().keepSafe),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn primary', onclick: () => { saveBackup(); render(false); } }, T().saveBackup),
            h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, T().openBackup)),
          fileInput, backupStatus,
          h('div', { class: 'actions' }, h('button', {
            type: 'button', class: 'btn danger',
            onclick: () => {
              if (!window.confirm(T().eraseAllConfirm)) return;
              STUDY = emptyStudy();
              saveStudy();
              sessionSet(NOTE_DRAFT_KEY, null);
              render(false);
            },
          }, T().eraseAll))),
      ],
    };
  }

  // #/study, #/study/note/<id>, #/study/edit/<id>, #/study/new, #/study/new/<CODE>/<ch>/<v1>/<v2>
  function studyView(sub, a, b, c, d) {
    if (sub === 'note') return noteView(a);
    if (sub === 'edit') return noteEditView({ id: a });
    if (sub === 'new') {
      const info = a && bookInfo(a);
      const ch = parseInt(b, 10);
      const v1 = parseInt(c, 10);
      if (info && ch >= 1 && ch <= info.chapters && v1 >= 1) return noteEditView({ code: info.code, ch, v1, v2: Math.max(v1, parseInt(d, 10) || v1) });
      return noteEditView({});
    }
    return myStudyView();
  }

  /* ---------- Use offline: the whole app on this device ---------- */

  // The files the service worker stores on the first visit: the whole of Pray by myself and
  // Share Jesus. Must equal FILES in sw.js (tools/verify.py checks this).
  const APP_FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'lang/en.json', 'scripture/en-web.json',
    'bible/index.json', 'tsk/index.json', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
  const O = () => L.offline;
  const offlineSizes = () => ({
    download: mb(IDX.books.reduce((n, b) => n + b.download, 0) + (TSKI ? TSKI.books.reduce((n, b) => n + b.download, 0) : 0)),
    stored: mb(IDX.books.reduce((n, b) => n + b.size, 0) + (TSKI ? TSKI.books.reduce((n, b) => n + b.size, 0) : 0)),
  });

  // How many of the app's own files are stored. Looked up afresh each time, so it stays true
  // after an app update (the new version stores its files under a new name).
  async function appFilesHere() {
    if (!window.caches) return 0;
    let n = 0;
    for (const f of APP_FILES) {
      try { if (await caches.match(new URL(f, location.href).href, { ignoreSearch: true })) n += 1; } catch (e) { /* ignore */ }
    }
    return n;
  }

  // Ask the phone to keep this app's data rather than clear it when space runs low.
  async function askToKeep() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  }

  async function keepEverything(status) {
    if (downloading || downloadingTsk) return false;
    downloading = true;
    downloadingTsk = true;
    let ok = true;
    try {
      // The app itself is stored by the service worker on the first visit; if it is missing, ask it again.
      if ((await appFilesHere()) < APP_FILES.length && navigator.serviceWorker) {
        const reg = await navigator.serviceWorker.register('sw.js');
        await reg.update().catch(() => {});
        await navigator.serviceWorker.ready;
      }
      const jobs = IDX.books.map((b) => [bibleCacheName(), 'bible/' + b.code + '.json'])
        .concat(TSKI ? TSKI.books.map((b) => [tskCacheName(), 'tsk/' + b.code + '.json']) : []);
      const open = {};
      for (const name of new Set(jobs.map((j) => j[0]))) {
        const cache = await caches.open(name);
        open[name] = { cache, have: new Set((await cache.keys()).map((r) => new URL(r.url).pathname.split('/').slice(-2).join('/'))) };
      }
      let n = 0;
      for (const [name, url] of jobs) {
        if (!open[name].have.has(url)) {
          const res = await fetch(url);
          if (!res.ok) throw new Error('download');
          await open[name].cache.put(url, res);
        }
        n += 1;
        status.textContent = fill(O().downloading, { n, total: jobs.length });
      }
      BOOKS.forEach((book) => { book.saved = true; });
      await askToKeep();
      status.textContent = '';
    } catch (e) {
      ok = false;
      status.textContent = B().stopped;
    }
    downloading = false;
    downloadingTsk = false;
    return ok;
  }

  function offlineView() {
    const list = h('ul', { class: 'offline-status' });
    const actions = h('div', { class: 'offline-actions' });
    const status = h('p', { class: 'status', role: 'status' });
    // Each part says its state in words; the check mark is only decoration.
    const row = (label, done, text) => h('li', { class: done ? 'here' : 'missing' },
      h('span', { class: 'part' }, label + ': '), h('span', null, text), done && h('span', { class: 'tick', 'aria-hidden': 'true' }, ' ✓'));
    const check = async () => {
      const [app, bible, xref] = await Promise.all([appFilesHere(), savedCount(), TSKI ? tskSavedCount() : 0]);
      const nb = IDX.books.length;
      const nx = TSKI ? TSKI.books.length : 0;
      const appOk = app >= APP_FILES.length;
      const bibleOk = bible >= nb;
      const xrefOk = xref >= nx;
      const all = appOk && bibleOk && xrefOk;
      list.replaceChildren(
        row(O().appPart, appOk, appOk ? O().here : O().notYet),
        row(O().biblePart, bibleOk, bibleOk ? O().here : fill(O().partial, { n: bible, total: nb })),
        row(O().xrefPart, xrefOk, xrefOk ? O().here : fill(O().partial, { n: xref, total: nx })));
      if (all) await askToKeep();
      const keep = h('button', {
        type: 'button', class: 'btn primary',
        onclick: async () => { keep.disabled = true; await askToKeep(); await keepEverything(status); check(); },
      }, O().keep);
      actions.replaceChildren(...[
        all ? h('p', { class: 'saved-line' }, O().done) : keep,
        !all && h('p', { class: 'hint' }, fill(O().size, offlineSizes())),
        bible > 0 && h('button', { type: 'button', class: 'btn danger', onclick: async () => { await caches.delete(bibleCacheName()); BOOKS.clear(); check(); } }, B().remove),
        bible > 0 && h('p', { class: 'hint' }, B().removeHint),
        xref > 0 && h('button', { type: 'button', class: 'btn danger', onclick: async () => { await caches.delete(tskCacheName()); XREFS.clear(); check(); } }, X().remove),
      ].filter(Boolean));
    };
    if (window.caches) check();
    return {
      title: O().heading,
      nodes: [h('h1', null, O().heading), h('p', null, O().intro), list, actions, status, h('p', { class: 'hint' }, T().keepSafe)],
    };
  }

  /* ---------- router ---------- */

  function questionView(F, a, b) {
    const i = parseInt(a, 10) - 1;
    if (!F.steps[i]) return null;
    const count = F.steps[i].guided.length;
    return guideView(F, i, Math.min(Math.max(parseInt(b, 10) || 1, 1), count) - 1);
  }

  function shareView(sub, a) {
    if (sub === 'cost') return shareCostView();
    if (sub === 'not-today') return shareNotTodayView();
    if (sub === 'q') return questionView(SHARE, a, 1);
    if (sub === 'borrow') return shareBorrowView();
    if (sub === 'review') return reviewView(SHARE);
    if (sub === 'pray') return prayWalkView(SHARE, parseInt(a, 10) || 1);
    if (sub === 'prayer') return prayerView(SHARE);
    if (sub === 'after') return shareAfterView();
    return shareStartView();
  }

  let renderToken = 0;
  function render(moveFocus) {
    const token = ++renderToken;
    const [name, arg, arg2, arg3, arg4, arg5] = location.hash.replace(/^#\/?/, '').split('/');
    // References link to their chapter everywhere except while leading someone in Share Jesus.
    refLinks = name !== 'share';
    let view = null;
    if (name === 'step') view = questionView(PRAY, arg, arg2);
    else if (name === 'share') view = shareView(arg, arg2);
    else if (name === 'guide') view = guideIntroView();
    else if (name === 'review') view = reviewView(PRAY);
    else if (name === 'pray') view = prayWalkView(PRAY, parseInt(arg, 10) || 1);
    else if (name === 'prayer') view = prayerView(PRAY);
    else if (name === 'aloud') view = aloudView();
    else if (name === 'about') view = aboutView();
    else if (name === 'why') view = whyView();
    else if (name === 'bible') view = bibleView(arg, arg2, arg3);
    else if (name === 'study') view = studyView(arg, arg2, arg3, arg4, arg5);
    else if (name === 'offline') view = offlineView();
    if (!view) view = welcomeView();

    // Share Jesus is held between two people, so its text is larger.
    document.body.classList.toggle('together', name === 'share');
    document.body.classList.toggle('reading', name === 'bible' || name === 'study');
    // A book that is not open yet: show "Opening…" until it is ready.
    if (typeof view.then === 'function') {
      show(view.loading, moveFocus);
      view.then((ready) => { if (token === renderToken) show(ready, moveFocus); });
      return;
    }
    show(view, moveFocus);
  }

  function show(view, moveFocus) {
    main.replaceChildren(...[view.nodes].flat(Infinity).filter(Boolean));
    document.title = view.title ? view.title + ' | ' + L.app.name : L.app.name;
    const target = view.verse && document.getElementById('v' + view.verse);
    if (moveFocus) {
      const heading = main.querySelector('h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      window.scrollTo(0, 0);
    }
    if (target) {
      target.classList.add('hit');
      target.scrollIntoView({ block: 'center' });
    }
    if (view.after) view.after();
    if (P.open) listenHighlight();
  }

  /* ---------- Listen: Bible study read aloud by a voice stored on the device ---------- */

  // The player speaks only with voices the device says are stored on it, in English. Online
  // voices (Google's, Microsoft's "Online" voices, Android "network" voices) are never offered,
  // and every utterance is given its voice, so the browser's default voice is never used.
  // One verse is one utterance (Chrome stops long ones), and the next verse is queued while
  // one is read, so phones read without a gap. Pause cancels and Play starts that verse again,
  // because pause() and resume() are unreliable on Android.
  // Kept on this device (localStorage): the settings below and where listening stopped.
  const LISTEN_KEY = 'teach-us-to-pray-listen';             // speed, voice, announcements, keep screen on
  const LISTEN_PLACE_KEY = 'teach-us-to-pray-listen-place'; // where listening stopped, e.g. "JHN/3/16"
  const LN = () => L.listen;
  const isLocalVoice = (v) => v.localService === true && !/online|network/i.test(v.name + ' ' + v.voiceURI) && !/^google/i.test(v.name);
  const englishVoice = (v) => /^en([-_]|$)/i.test(v.lang || '');
  const canSpeak = () => !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  // Reading runs on from book to book, and from Malachi into Matthew. It stops after
  // Revelation and after the last book of the Apocrypha (decided at content review).
  const runsOn = (from, to) => !!to && (from.shelf === to.shelf || (from.shelf === 'ot' && to.shelf === 'nt'));
  const coarse = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  let LS = { rate: 1, voice: null, announce: true, wake: false };
  let VOICES = [];
  let voicesWait = null;
  let quietRoute = false; // the next route change follows the reading: do not move focus
  const P = { open: false, playing: false, busy: false, code: null, ch: null, list: null, i: 0, queued: -1, token: 0, held: [], msg: '', sleepAt: 0, sleepTimer: null, lock: null, idleSince: 0 };
  const PL = {}; // the player's elements

  function localVoices() {
    return canSpeak() ? speechSynthesis.getVoices().filter((v) => isLocalVoice(v) && englishVoice(v)) : [];
  }
  // Voices arrive late in some browsers. Wait up to two seconds for them.
  function voicesReady() {
    if (!canSpeak()) return Promise.resolve([]);
    if (voicesWait) return voicesWait;
    voicesWait = new Promise((resolve) => {
      const done = () => { VOICES = localVoices(); resolve(VOICES); };
      if (speechSynthesis.getVoices().length) { done(); return; }
      const t = setTimeout(done, 2000);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); done(); }, { once: true });
    });
    return voicesWait;
  }
  function currentVoice() {
    const lang = (navigator.language || 'en').toLowerCase().replace('_', '-');
    return VOICES.find((v) => v.voiceURI === LS.voice)
      || VOICES.find((v) => v.default) || VOICES.find((v) => v.lang.toLowerCase().replace('_', '-') === lang) || VOICES[0] || null;
  }
  function saveListen() { store.set(LISTEN_KEY, JSON.stringify(LS)); }

  function listenPlace() {
    const [code, ch, v] = (store.get(LISTEN_PLACE_KEY) || '').split('/');
    const info = code && bookInfo(code);
    const c = parseInt(ch, 10);
    if (!info || !(c >= 1 && c <= info.chapters)) return null;
    const verse = parseInt(v, 10) || 0;
    return { code, ch: c, v: verse, ref: chapterTitle(info, c) + (verse > 0 ? ':' + verse : '') };
  }
  const itemRef = (item) => chapterTitle(bookInfo(P.code), P.ch) + (item && item.v > 0 ? ':' + item.v : '');

  // A chapter as the player reads it: the announcement, the Psalm title, then each verse.
  // Only the words are read: never verse numbers, translators' notes, cross-references or
  // headings. Psalm titles are read, except Psalm 119's letter headings (decided at content
  // review). Square brackets are not read; omitted verses (no words) are left out.
  const LISTEN_CHAPTERS = new Map();
  function listenItems(book, ch) {
    const key = book.code + '/' + ch;
    if (LISTEN_CHAPTERS.has(key)) return LISTEN_CHAPTERS.get(key);
    const info = bookInfo(book.code);
    const titles = (book.code === 'PSA' && ch !== 119) || book.code === 'PS2';
    const items = [];
    let cur = null;
    let first = null;
    let last = null;
    for (const [kind, ...tokens] of book.chapters[ch - 1].b) {
      if (kind === 'd') {
        if (titles && cur === null) items.push({ v: 0, text: tokens.filter((t) => typeof t === 'string').join(' ') });
        continue;
      }
      if (HEADING_KINDS.has(kind)) continue;
      for (const t of tokens) {
        if (typeof t === 'number' || (t && t.v)) {
          const [a, b] = String(typeof t === 'number' ? t : t.v).split('-').map(Number);
          if (first === null) first = a;
          last = Math.max(last || 0, b || a);
          cur = { v: a, text: '' };
          items.push(cur);
        } else if (typeof t === 'string' && cur) cur.text += t;
      }
      if (cur) cur.text += ' ';
    }
    const words = items.map((x) => ({ v: x.v, text: x.text.replace(/[[\]]/g, '').replace(/—{2,}/g, ' ').replace(/\s+/g, ' ').trim() }))
      .filter((x) => /[a-z0-9]/i.test(x.text));
    const sp = LN().spoken[book.code] || [info.name, info.name];
    const N = LN().narrator;
    const one = first === last;
    const values = { book: sp[0], n: ch, first, last };
    let line;
    if (info.chapters === 1) line = fill(one ? N.bookOne : N.book, values);
    else if (info.chapterName) line = fill(one ? N.psalmOne : N.psalm, values);
    else line = fill(one ? N.chapterOne : N.chapter, values);
    const out = [{ v: null, narr: true, text: (ch === 1 ? fill(N.opening, { name: sp[1] }) + ' ' : '') + line }, ...words];
    LISTEN_CHAPTERS.set(key, out);
    return out;
  }

  // The chapter on screen, as "CODE/ch", or null.
  function shownChapter() {
    const [name, code, ch] = location.hash.replace(/^#\/?/, '').split('/');
    const info = name === 'bible' && code && bookInfo(code);
    if (!info) return null;
    const c = ch ? parseInt(ch, 10) : (info.chapters === 1 ? 1 : null);
    return c ? code + '/' + c : null;
  }

  function announce(text) {
    if (!PL.live) return;
    PL.live.textContent = '';
    setTimeout(() => { PL.live.textContent = text; }, 60);
  }

  // The verse being read, in a high-contrast style, kept in view.
  function listenHighlight() {
    document.querySelectorAll('.reading-now').forEach((e) => e.classList.remove('reading-now'));
    if (!P.open || !P.list || shownChapter() !== P.code + '/' + P.ch) return;
    const item = P.list[P.i];
    if (!item || item.narr) return;
    const els = item.v === 0 ? main.querySelectorAll('.text p.k-d') : main.querySelectorAll('.text .vt[data-v="' + item.v + '"]');
    els.forEach((e) => e.classList.add('reading-now'));
    const first = els[0];
    if (!first) return;
    const r = first.getBoundingClientRect();
    const bottom = window.innerHeight - (PL.bar ? PL.bar.offsetHeight : 0);
    if (r.top < 0 || r.bottom > bottom) first.scrollIntoView({ block: 'center' });
  }

  function paint() {
    if (!PL.bar) return;
    PL.bar.hidden = !P.open;
    document.body.classList.toggle('listening', P.open);
    PL.play.textContent = P.playing ? LN().pause : LN().play;
    const place = listenPlace();
    const item = P.list && P.list[P.i];
    PL.ref.textContent = P.playing && P.list ? fill(LN().reading, { ref: itemRef(item) })
      : place ? fill(LN().continueFrom, { ref: place.ref }) : '';
    PL.msg.textContent = P.msg;
    PL.msg.hidden = !P.msg;
    PL.prev.disabled = !P.list;
    PL.next.disabled = !P.list;
    if (PL.wake) PL.wake.setAttribute('aria-pressed', LS.wake ? 'true' : 'false');
    document.documentElement.style.setProperty('--player-h', P.open ? PL.bar.offsetHeight + 'px' : '0px');
    listenHighlight();
  }

  // Keep the screen on while reading, only if the person turned it on. A wake lock ends
  // when the app leaves the screen; it is asked for again when the person comes back.
  async function holdScreen() {
    if (!LS.wake || !P.playing || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    if (P.lock && !P.lock.released) return;
    try { P.lock = await navigator.wakeLock.request('screen'); } catch (e) { P.lock = null; }
  }
  function releaseScreen() {
    if (P.lock) { try { P.lock.release(); } catch (e) { /* ignore */ } }
    P.lock = null;
  }

  function utter(k, tok) {
    const item = P.list[k];
    const voice = currentVoice();
    if (!item || !voice) return;
    const u = new SpeechSynthesisUtterance(item.text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = LS.rate;
    u.onstart = () => {
      if (tok !== P.token) return;
      P.i = k;
      P.idleSince = 0;
      if (item.narr) {
        const next = P.list.find((x) => !x.narr);
        if (next) store.set(LISTEN_PLACE_KEY, P.code + '/' + P.ch + '/' + next.v);
      } else store.set(LISTEN_PLACE_KEY, P.code + '/' + P.ch + '/' + item.v);
      // Fetch the next book while the end of this one is read.
      const info = bookInfo(P.code);
      if (P.ch === info.chapters && k >= P.list.length - 3) {
        const nb = neighbour(info, P.ch, 1);
        if (nb && runsOn(info, nb.info)) getBook(nb.info.code).catch(() => {});
      }
      paint();
    };
    u.onend = () => { if (tok === P.token) itemEnded(k); };
    u.onerror = (e) => {
      if (tok !== P.token || e.error === 'interrupted' || e.error === 'canceled') return;
      interrupted();
    };
    P.held.push(u); // held so the browser does not drop it before it ends
    P.queued = k;
    speechSynthesis.speak(u);
  }

  function speakFrom(i) {
    speechSynthesis.cancel();
    P.token += 1;
    P.held = [];
    P.i = i;
    P.msg = '';
    P.playing = true;
    P.idleSince = 0;
    const tok = P.token;
    utter(i, tok);
    if (i + 1 < P.list.length) utter(i + 1, tok);
    holdScreen();
    paint();
  }

  function itemEnded(k) {
    if (P.sleepAt && Date.now() >= P.sleepAt) { sleepEnded(); return; }
    if (k >= P.list.length - 1) { nextChapter(); return; }
    P.i = k + 1;
    if (P.queued < k + 2 && k + 2 < P.list.length) utter(k + 2, P.token);
  }

  // Stopped by the device (a call, the screen locking, another app): the place is kept,
  // and the player shows "Continue from".
  function interrupted() {
    P.token += 1;
    P.playing = false;
    P.busy = false;
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    releaseScreen();
    paint();
    const place = listenPlace();
    if (place) announce(fill(LN().sr.paused, { ref: place.ref }));
  }
  function stopWith(message) {
    interrupted();
    P.msg = message;
    paint();
    announce(message);
  }

  function setChapter(book, ch) {
    P.code = book.code;
    P.ch = ch;
    P.list = listenItems(book, ch).filter((x) => !x.narr || LS.announce);
  }

  // At the end of a chapter: the next one, across books, but not past Revelation or the Apocrypha.
  async function nextChapter() {
    const info = bookInfo(P.code);
    const nb = neighbour(info, P.ch, 1);
    if (!nb || !runsOn(info, nb.info)) { shelfEnded(info.shelf); return; }
    const following = shownChapter() === P.code + '/' + P.ch;
    const tok = P.token;
    P.busy = true;
    let book;
    try { book = await getBook(nb.info.code); } catch (e) {
      P.busy = false;
      store.set(LISTEN_PLACE_KEY, nb.info.code + '/' + nb.ch + '/1');
      stopWith(fill(LN().notHere, { book: nb.info.name }));
      return;
    }
    P.busy = false;
    if (tok !== P.token || !P.playing) return;
    setChapter(book, nb.ch);
    speakFrom(0);
    if (following) { quietRoute = true; location.hash = '#/bible/' + nb.info.code + '/' + nb.ch; }
    announce(fill(LN().sr.chapter, { chapter: chapterTitle(nb.info, nb.ch) }));
  }

  function shelfEnded(shelf) {
    const message = fill(LN().shelfEnd, { shelf: B().shelves[shelf] });
    const voice = currentVoice();
    P.token += 1;
    const tok = P.token;
    store.set(LISTEN_PLACE_KEY, null);
    const finish = () => { if (tok === P.token) stopWith(message); };
    if (!voice) { finish(); return; }
    const u = new SpeechSynthesisUtterance(fill(LN().shelfEnd, { shelf: LN().shelfSpoken[shelf] }));
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = LS.rate;
    u.onend = finish;
    u.onerror = finish;
    P.held = [u];
    speechSynthesis.speak(u);
  }

  function sleepEnded() {
    P.sleepAt = 0;
    clearTimeout(P.sleepTimer);
    if (PL.sleep) PL.sleep.value = '0';
    const place = listenPlace();
    stopWith(fill(LN().sleepDone, { ref: place ? place.ref : '' }));
  }
  function setSleep(minutes) {
    clearTimeout(P.sleepTimer);
    P.sleepAt = minutes ? Date.now() + minutes * 60000 : 0;
    if (minutes) P.sleepTimer = setTimeout(() => { if (P.sleepAt && Date.now() >= P.sleepAt - 1000) { if (P.playing) sleepEnded(); else P.sleepAt = 0; } }, minutes * 60000);
    announce(minutes ? fill(LN().sr.sleepOn, { n: minutes }) : LN().sr.sleepOff);
  }

  // iPhone Safari speaks only when a tap starts it: start with a silent utterance in the tap itself.
  function unlockSpeech() {
    const voice = currentVoice();
    if (!voice) return;
    const u = new SpeechSynthesisUtterance('');
    u.voice = voice;
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  // Start reading a chapter, from its beginning or from verse v.
  async function startListening(code, ch, v) {
    unlockSpeech();
    P.open = true;
    P.msg = '';
    paint();
    let book;
    try { book = await getBook(code); } catch (e) { stopWith(fill(LN().notHere, { book: bookInfo(code).name })); return; }
    setChapter(book, ch);
    let i = 0;
    if (v != null) {
      const at = P.list.findIndex((x) => x.v === v);
      i = at > 0 ? at : 0;
    }
    speakFrom(i);
    announce(fill(LN().sr.playing, { ref: itemRef(P.list[i]) }));
  }

  function togglePlay() {
    if (P.playing) {
      interrupted();
      return;
    }
    if (P.list) {
      unlockSpeech();
      speakFrom(Math.min(P.i, P.list.length - 1));
      announce(fill(LN().sr.playing, { ref: itemRef(P.list[P.i]) }));
      return;
    }
    const place = listenPlace();
    if (place) startListening(place.code, place.ch, place.v);
  }

  // Previous or next verse, into the chapter before or after (where reading runs on).
  async function stepVerse(d) {
    if (!P.list || P.busy) return;
    let k = P.i + d;
    while (k >= 0 && k < P.list.length && P.list[k].narr) k += d;
    if (k >= 0 && k < P.list.length) {
      P.i = k;
      store.set(LISTEN_PLACE_KEY, P.code + '/' + P.ch + '/' + P.list[k].v);
      if (P.playing) speakFrom(k); else paint();
      return;
    }
    const info = bookInfo(P.code);
    const nb = neighbour(info, P.ch, d);
    if (!nb || !(d > 0 ? runsOn(info, nb.info) : runsOn(nb.info, info))) return;
    const following = shownChapter() === P.code + '/' + P.ch;
    const playing = P.playing;
    if (playing) interrupted();
    P.busy = true;
    let book;
    try { book = await getBook(nb.info.code); } catch (e) { P.busy = false; stopWith(fill(LN().notHere, { book: nb.info.name })); return; }
    P.busy = false;
    setChapter(book, nb.ch);
    let i = d > 0 ? 0 : P.list.length - 1;
    if (d > 0 && !playing) i = P.list.findIndex((x) => !x.narr);
    P.i = i;
    if (!P.list[i].narr) store.set(LISTEN_PLACE_KEY, P.code + '/' + P.ch + '/' + P.list[i].v);
    if (following) { quietRoute = true; location.hash = '#/bible/' + nb.info.code + '/' + nb.ch; }
    if (playing) speakFrom(i); else paint();
  }

  function closePlayer() {
    interrupted();
    P.open = false;
    P.msg = '';
    paint();
    const target = main.querySelector('.listen-slot button') || main;
    target.focus();
  }

  function buildPlayer() {
    const label = (id, text) => h('label', { for: id }, text);
    PL.live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    PL.ref = h('p', { class: 'player-ref' });
    PL.msg = h('p', { class: 'player-msg', hidden: true });
    PL.play = h('button', { type: 'button', class: 'btn primary player-play', onclick: togglePlay }, LN().play);
    PL.prev = h('button', { type: 'button', class: 'btn', onclick: () => stepVerse(-1) }, LN().prev);
    PL.next = h('button', { type: 'button', class: 'btn', onclick: () => stepVerse(1) }, LN().next);
    PL.speed = h('select', {
      id: 'listen-speed',
      onchange: (e) => { LS.rate = parseFloat(e.target.value); saveListen(); if (P.playing) speakFrom(P.i); },
    }, LN().speeds.map((s) => h('option', { value: String(s) }, fill(LN().speedLabel, { n: String(s) }))));
    PL.speed.value = String(LS.rate);
    PL.voice = h('select', {
      id: 'listen-voice',
      onchange: (e) => { LS.voice = e.target.value; saveListen(); if (P.playing) speakFrom(P.i); },
    });
    PL.sleep = h('select', { id: 'listen-sleep', onchange: (e) => setSleep(parseInt(e.target.value, 10)) },
      h('option', { value: '0' }, LN().sleepOff),
      LN().sleepMinutes.map((n) => h('option', { value: String(n) }, fill(LN().sleepLabel, { n }))));
    const announceBox = h('input', {
      type: 'checkbox', id: 'listen-announce', checked: LS.announce,
      onchange: (e) => { LS.announce = e.target.checked; saveListen(); },
    });
    let wakePart = null;
    if (coarse()) {
      if (navigator.wakeLock) {
        PL.wake = h('button', {
          type: 'button', class: 'btn', 'aria-pressed': 'false', 'aria-describedby': 'listen-wake-hint',
          onclick: () => { LS.wake = !LS.wake; saveListen(); if (LS.wake) holdScreen(); else releaseScreen(); paint(); },
        }, LN().wake);
        wakePart = [PL.wake, h('p', { class: 'hint', id: 'listen-wake-hint' }, LN().wakeHint)];
      } else wakePart = h('p', { class: 'hint' }, LN().wakeNone);
    }
    PL.bar = h('section', { class: 'player', 'aria-label': LN().player, hidden: true },
      h('div', { class: 'player-top' }, PL.ref,
        h('button', { type: 'button', class: 'btn small player-close', onclick: closePlayer }, LN().close)),
      PL.msg,
      h('div', { class: 'player-controls' }, PL.prev, PL.play, PL.next),
      h('details', { class: 'player-more' },
        h('summary', null, LN().settings),
        h('div', { class: 'player-grid' },
          h('div', null, label('listen-speed', LN().speed), PL.speed),
          h('div', null, label('listen-sleep', LN().sleep), PL.sleep),
          h('div', { class: 'wide' }, label('listen-voice', LN().voice), PL.voice)),
        h('label', { class: 'check', for: 'listen-announce' }, announceBox, h('span', null, LN().announce)),
        wakePart,
        h('p', { class: 'hint' }, coarse() ? LN().phoneLine : LN().keys)),
      PL.live);
    document.body.insertBefore(PL.bar, document.querySelector('footer.site'));
    if (window.ResizeObserver) new ResizeObserver(() => { if (P.open) document.documentElement.style.setProperty('--player-h', PL.bar.offsetHeight + 'px'); }).observe(PL.bar);
  }

  function fillVoices() {
    const current = currentVoice();
    PL.voice.replaceChildren(...VOICES.map((v) => h('option', { value: v.voiceURI }, v.name)));
    if (current) PL.voice.value = current.voiceURI;
  }

  // The Listen button on a chapter. With no voice stored on the device, a plain message instead.
  function listenSlot(info, ch) {
    const box = h('div', { class: 'listen-slot' });
    if (!canSpeak()) { box.append(h('p', { class: 'hint' }, LN().noVoice)); return box; }
    voicesReady().then((voices) => {
      if (!voices.length) { box.replaceChildren(h('p', { class: 'hint' }, LN().noVoice)); return; }
      const place = listenPlace();
      const here = place && place.code === info.code && place.ch === ch && place.v > 0;
      box.replaceChildren(h('div', { class: 'actions listen-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => startListening(info.code, ch, null) }, LN().listen),
        here && h('button', { type: 'button', class: 'btn', onclick: () => startListening(place.code, place.ch, place.v) },
          fill(LN().continueFrom, { ref: place.ref }))));
    });
    return box;
  }
  // "Continue from" on the Bible study home screen, after listening stopped.
  function listenContinue() {
    const box = h('span', { class: 'listen-continue' });
    const place = listenPlace();
    if (!place || !canSpeak()) return box;
    voicesReady().then((voices) => {
      if (!voices.length) return;
      box.append(h('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          unlockSpeech();
          quietRoute = true;
          location.hash = '#/bible/' + place.code + '/' + place.ch;
          startListening(place.code, place.ch, place.v);
        },
      }, fill(LN().continueFrom, { ref: place.ref })));
    });
    return box;
  }

  function initListen() {
    try { LS = Object.assign(LS, JSON.parse(store.get(LISTEN_KEY)) || {}); } catch (e) { /* defaults */ }
    if (!canSpeak()) return;
    buildPlayer();
    voicesReady().then(fillVoices);
    speechSynthesis.addEventListener('voiceschanged', () => { VOICES = localVoices(); fillVoices(); });
    document.addEventListener('keydown', (e) => {
      if (!P.open || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (t && (t.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
      if (e.key === ' ') {
        if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return; // they use Space themselves
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        stepVerse(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !P.playing) return;
      if (speechSynthesis.paused) { interrupted(); return; } // iPhone pauses speech when the screen locks
      holdScreen();
    });
    // While the app is on screen: reading that stopped by itself shows "Continue from".
    setInterval(() => {
      if (!P.playing || P.busy || document.visibilityState !== 'visible') { P.idleSince = 0; return; }
      if (speechSynthesis.speaking || speechSynthesis.pending) { P.idleSince = 0; return; }
      if (!P.idleSince) { P.idleSince = Date.now(); return; }
      if (Date.now() - P.idleSince > 4000) interrupted();
    }, 2000);
  }

  async function start() {
    const wanted = (navigator.languages || [navigator.language || '']).map((l) => l.slice(0, 2).toLowerCase());
    const lang = wanted.find((l) => LANGS.includes(l)) || LANGS[0];
    L = await (await fetch('lang/' + lang + '.json')).json();
    S = await (await fetch(L.meta.scriptureFile)).json();
    IDX = await (await fetch('bible/index.json')).json();
    try { TSKI = await (await fetch('tsk/index.json')).json(); } catch (e) { TSKI = null; }
    STUDY = loadStudy();

    document.documentElement.lang = L.meta.lang;
    document.documentElement.dir = L.meta.dir;
    document.querySelector('meta[name="description"]').content = L.app.description;
    document.getElementById('brand').textContent = L.app.name;
    document.getElementById('about-link').textContent = L.nav.about;
    document.getElementById('bible-link').textContent = L.nav.bible;
    document.getElementById('credit').textContent = L.app.translationCredit;
    document.getElementById('offline-link').textContent = L.nav.offline;
    const skip = document.getElementById('skip');
    skip.textContent = L.app.skipToContent;
    skip.addEventListener('click', (e) => { e.preventDefault(); main.focus(); });

    PRAY = makeFlow(L.steps, {
      q: (n, k) => '#/step/' + n + '/' + k, first: '#/guide', review: '#/review', walk: '#/pray/', prayer: '#/prayer',
      save: saveDraft, cuesLabel: L.step.cuesLabel, hint: L.guide.hint, toReview: L.guide.toReview, finish: L.guide.finish,
      reviewText: { heading: L.guide.reviewHeading, hint: L.guide.reviewHint, toWalk: L.guide.toAloud },
      prayerText: L.prayer,
    });
    // Share Jesus words are held in memory only: save() never writes them anywhere.
    SHARE = makeFlow(L.share.steps, {
      q: (n) => '#/share/q/' + n, first: '#/share/cost', review: '#/share/review', walk: '#/share/pray/', prayer: '#/share/prayer',
      save: () => {}, cuesLabel: L.share.ideasLabel, hint: L.share.hint, toReview: L.share.review.heading, finish: L.share.walk.finish,
      needHelp: '#/share/borrow', perPhrase: true, reviewText: L.share.review, prayerText: L.share.prayer,
    });
    loadDraft();
    initListen();
    // The skip link's target is #main, which is not a screen: never route to it.
    // A route change made by Listen following the reading leaves the focus where it is.
    window.addEventListener('hashchange', () => { if (location.hash === '#main') return; const quiet = quietRoute; quietRoute = false; render(!quiet); });
    render(false);

    if ('serviceWorker' in navigator) {
      const hadWorker = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Never reload while there are words on the screen that are not kept anywhere.
        // Pray by myself words survive a reload in sessionStorage; Share Jesus words would not.
        if (!hadWorker || reloaded || downloading || downloadingTsk || prayerParts(SHARE).length || (!visitKept && !keep && anyWords())) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
    }
  }

  start();
})();

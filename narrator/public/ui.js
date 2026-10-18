// Interface behaviour that isn't core app logic (that's app.js): the Settings and History sheets,
// the Reasoning segmented control, tap-to-repeat on the alert card, and the hazard highlight /
// vibration on new alerts. Loaded after app.js. If this file fails, every control still works
// as a plain form control.
(() => {
  const $ = (id) => document.getElementById(id);
  const settingsBtn = $('settingsBtn');
  const historyBtn = $('historyBtn');
  const logSheet = $('logSheet');
  const sheet = $('sheet');
  const backdrop = $('sheetBackdrop');
  const closeBtn = $('sheetClose');
  const card = $('current');
  const reasoning = $('reasoning');

  // ---------- bottom sheets (Settings, History) ----------
  // One backdrop; at most one sheet open. Close with ✕, the backdrop, Escape, or a swipe down on
  // the handle or header.
  let openSheet = null;   // { el, opener }
  function showSheet(el, opener, focus) {
    if (openSheet) hideSheet(false);
    el.hidden = false;
    backdrop.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    openSheet = { el, opener };
    focus.focus();
  }
  function hideSheet(refocus = true) {
    if (!openSheet) return;
    const { el, opener } = openSheet;
    openSheet = null;
    el.hidden = true;
    backdrop.hidden = true;
    el.style.transform = '';
    opener.setAttribute('aria-expanded', 'false');
    if (refocus) opener.focus();
  }
  const closeSheet = hideSheet;
  settingsBtn.addEventListener('click', () => (sheet.hidden ? showSheet(sheet, settingsBtn, closeBtn) : hideSheet()));
  closeBtn.addEventListener('click', () => hideSheet());
  backdrop.addEventListener('click', () => hideSheet());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSheet(); });

  // Swipe down on the handle or header to close.
  let drag = null; // { el, start }
  for (const el of document.querySelectorAll('.sheet')) {
    for (const grip of el.querySelectorAll('.sheet-handle, .sheet-head')) {
      grip.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return; // the close button handles its own taps
        drag = { el, start: e.clientY };
        el.classList.add('dragging');
      });
    }
  }
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.el.style.transform = `translateY(${Math.max(0, e.clientY - drag.start)}px)`;
  });
  document.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const { el, start } = drag;
    drag = null;
    el.classList.remove('dragging');
    if (e.clientY - start > 80) closeSheet();
    else el.style.transform = '';
  });

  // ---------- Reasoning: segmented buttons drive the hidden <select> that app.js reads ----------
  const segments = [...document.querySelectorAll('.segmented [data-value]')]; // not the History filter (data-filter)
  function showReasoning() {
    for (const b of segments) b.setAttribute('aria-checked', String(b.dataset.value === reasoning.value));
  }
  for (const b of segments) {
    b.addEventListener('click', () => {
      if (reasoning.value === b.dataset.value) return;
      reasoning.value = b.dataset.value;
      reasoning.dispatchEvent(new Event('change')); // app.js saves the choice
      showReasoning();
    });
  }
  showReasoning(); // app.js has already restored the saved value

  // ---------- tap the alert card to hear it again ----------
  function repeatAlert() {
    const text = card.dataset.alert;
    if (!text || !window.Speech) return;
    Speech.unlock();
    Speech.say(text);
  }
  card.addEventListener('click', repeatAlert);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); repeatAlert(); }
  });

  // ---------- new alert: hazard highlight, short vibration, arrival animation ----------
  const HAZARD = /\b(stairs?|steps?|curb|drop|hole|pothole|close|car|cars|bike|bikes|cyclists?|vehicles?|approaching)\b/i;
  let lastAlert = card.dataset.alert || '';
  new MutationObserver(() => {
    const text = card.dataset.alert || '';
    const labelled = !!(text && window.Filter && Filter.hazardLabel(text)); // "Trip hazard: …" etc.
    card.classList.toggle('hazard', !!text && (labelled || HAZARD.test(text)));
    if (!text || text === lastAlert) { lastAlert = text; return; }
    lastAlert = text;
    if (navigator.vibrate) navigator.vibrate(40);
    card.classList.remove('fresh');
    void card.offsetWidth; // restart the animation
    card.classList.add('fresh');
  }).observe(card, { attributes: true, attributeFilter: ['data-alert'] });

  // ---------- History sheet: every reply kept on this phone (log.js) ----------
  // "Spoken" shows what the user heard; "All replies" adds what the filter dropped (repeats,
  // nothing new, replies that arrived too late) and errors, dimmed: useful for checking the prompt
  // and the filter on a walk. Tap a row to hear it again.
  if (window.Log && logSheet) {
    const list = $('logList'), more = $('logMore'), count = $('logCount');
    const copyBtn = $('logCopy'), clearBtn = $('logClear');
    const filters = [...logSheet.querySelectorAll('[data-filter]')];
    const PAGE = 300; // rows rendered at once; "Show older" adds more
    const TAGS = { alert: 'alert', correction: 'correction', answer: 'answer', hint: 'hint', repeat: 'repeat', 'n/a': 'nothing new', late: 'too late', error: 'error' };
    let filter = 'spoken';
    try { if (localStorage.getItem('logFilter') === 'all') filter = 'all'; } catch { /* storage blocked */ }
    let limit = PAGE;

    const tagOf = (e) => ((e.kind === 'alert' || e.kind === 'correction') && window.Filter && Filter.hazardLabel(e.text) ? 'hazard' : TAGS[e.kind]);
    function row(e) {
      const li = document.createElement('li');
      li.className = `log-row kind-${e.kind.replace('/', '')}${Log.isSpoken(e) ? '' : ' dim'}${tagOf(e) === 'hazard' ? ' hazard' : ''}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'log-item';
      const time = Log.time(e.t), tag = tagOf(e) + (e.mode === 'low' ? ' · reasoning' : '');
      const extra = filter === 'all' && e.ms !== undefined ? ` · ${e.ms} ms` : '';
      const part = (tagName, cls, text) => { const n = document.createElement(tagName); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
      const meta = part('span', 'log-meta');
      meta.append(part('time', '', time), part('span', 'log-tag', tag + extra));
      b.append(meta, part('span', 'log-text', e.text));
      b.setAttribute('aria-label', `${time}, ${tag}: ${e.text}`);
      b.addEventListener('click', () => { if (window.Speech) { Speech.unlock(); Speech.say(e.text); } });
      li.appendChild(b);
      return li;
    }
    function showCount() {
      const spoken = Log.entries('spoken').length;
      count.textContent = `${spoken} spoken · ${Log.length} replies kept on this phone (last ${Log.MAX})`;
    }
    function render() {
      for (const b of filters) b.setAttribute('aria-checked', String(b.dataset.filter === filter));
      const items = Log.entries(filter).reverse();
      list.replaceChildren(...items.slice(0, limit).map(row));
      more.hidden = items.length <= limit;
      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'log-empty';
        li.textContent = filter === 'spoken' ? 'Nothing spoken yet. Tap Start.' : 'No replies yet. Tap Start.';
        list.replaceChildren(li);
      }
      showCount();
    }
    function openLog() { limit = PAGE; render(); showSheet(logSheet, historyBtn, $('logClose')); }
    historyBtn.addEventListener('click', () => (logSheet.hidden ? openLog() : hideSheet()));
    $('logClose').addEventListener('click', () => hideSheet());
    // The faded lines under the alert open the full history too.
    const recent = $('history');
    recent.addEventListener('click', openLog);
    recent.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLog(); } });

    for (const b of filters) {
      b.addEventListener('click', () => {
        if (filter === b.dataset.filter) return;
        filter = b.dataset.filter;
        try { localStorage.setItem('logFilter', filter); } catch { /* storage blocked */ }
        limit = PAGE;
        render();
      });
    }
    more.addEventListener('click', () => { limit += PAGE; render(); });

    // New replies appear at the top while the sheet is open.
    Log.onAdd((e) => {
      if (logSheet.hidden) return;
      if (filter === 'all' || Log.isSpoken(e)) {
        if (list.firstChild && list.firstChild.classList.contains('log-empty')) list.replaceChildren();
        list.prepend(row(e));
        while (list.children.length > limit) list.lastChild.remove();
      }
      showCount();
    });

    function flash(btn, text) {
      const old = btn.dataset.label || btn.textContent;
      btn.dataset.label = old;
      btn.textContent = text;
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
    copyBtn.addEventListener('click', async () => {
      const text = Log.toText(filter);
      if (!text) { flash(copyBtn, 'Empty'); return; }
      try {
        await navigator.clipboard.writeText(text);
        flash(copyBtn, 'Copied');
      } catch { // no clipboard API (plain HTTP) or refused: select a temporary textarea instead
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
        ta.remove();
        flash(copyBtn, ok ? 'Copied' : 'Copy failed');
      }
    });
    clearBtn.addEventListener('click', () => {
      if (!Log.length) return;
      if (!window.confirm(`Delete all ${Log.length} replies from this phone's history?`)) return;
      Log.clear();
      render();
    });
  }
})();

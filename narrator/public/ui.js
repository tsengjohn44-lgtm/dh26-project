// Interface behaviour that isn't core app logic (that's app.js): the settings sheet, the
// Reasoning segmented control, tap-to-repeat on the alert card, and the hazard highlight /
// vibration on new alerts. Loaded after app.js. If this file fails, every control still works
// as a plain form control.
(() => {
  const $ = (id) => document.getElementById(id);
  const settingsBtn = $('settingsBtn');
  const sheet = $('sheet');
  const backdrop = $('sheetBackdrop');
  const closeBtn = $('sheetClose');
  const card = $('current');
  const reasoning = $('reasoning');

  // ---------- settings sheet ----------
  function openSheet() {
    sheet.hidden = false;
    backdrop.hidden = false;
    settingsBtn.setAttribute('aria-expanded', 'true');
    closeBtn.focus();
  }
  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    sheet.style.transform = '';
    settingsBtn.setAttribute('aria-expanded', 'false');
    settingsBtn.focus();
  }
  settingsBtn.addEventListener('click', () => (sheet.hidden ? openSheet() : closeSheet()));
  closeBtn.addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // Swipe down on the handle or header to close.
  let dragStart = null;
  for (const grip of sheet.querySelectorAll('.sheet-handle, .sheet-head')) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // the close button handles its own taps
      dragStart = e.clientY;
      sheet.classList.add('dragging');
    });
  }
  document.addEventListener('pointermove', (e) => {
    if (dragStart === null) return;
    sheet.style.transform = `translateY(${Math.max(0, e.clientY - dragStart)}px)`;
  });
  document.addEventListener('pointerup', (e) => {
    if (dragStart === null) return;
    const dy = e.clientY - dragStart;
    dragStart = null;
    sheet.classList.remove('dragging');
    if (dy > 80) closeSheet();
    else sheet.style.transform = '';
  });

  // ---------- Reasoning: segmented buttons drive the hidden <select> that app.js reads ----------
  const segments = [...document.querySelectorAll('.segmented [data-value]')];
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
})();

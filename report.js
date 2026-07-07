// TrainDoc report.js v14 (1.2.0)

// ─── Standalone mode ──────────────────────────────────────────────────────────
// When this file is opened as a shared .html (no extension), chrome APIs are
// unavailable. All reads/writes go through _mem, pre-seeded from embedded data.
const STANDALONE = (() => {
  try { return typeof chrome === 'undefined' || typeof chrome.storage === 'undefined'; }
  catch(e) { return true; }
})();
const _mem = STANDALONE ? (window.__TRAINDOC_DATA__ || {}) : {};

function storageGet(keys, cb) {
  if (STANDALONE) {
    const r = {}; keys.forEach(k => { if (k in _mem) r[k] = _mem[k]; }); cb(r); return;
  }
  chrome.storage.local.get(keys, cb);
}
function storageSet(obj) {
  if (STANDALONE) { Object.assign(_mem, obj); return; }
  chrome.storage.local.set(obj);
}

const docEl          = document.getElementById('doc');
const emptyEl        = document.getElementById('emptyState');
const btnPrint       = document.getElementById('btnPrint');
const btnNew         = document.getElementById('btnNew');
const btnExport      = document.getElementById('btnExport');
const exportMenu     = document.getElementById('exportMenu');
const logoInput      = document.getElementById('logoInput');
const logoInputLeft  = document.getElementById('logoInputLeft');
const screenshotInput= document.getElementById('screenshotInput');
const printTip       = document.getElementById('printTip');

let pendingScreenshotStep = null;  // step object awaiting image upload

let liveSteps        = [];
let guideTitleText   = 'How to: [click to name this guide]';
const TITLE_PLACEHOLDER = 'How to: [click to name this guide]';
let guideDescText    = '';
let draggedNum       = null;   // step number being dragged
let activeRedactBtn   = null;   // currently active redact button
let activeAnnotateBtn = null;   // currently active annotate button
let lastSyncTimestamp = 0;     // max timestamp of steps loaded from storage
let docRendered      = false;  // true once renderDoc() has been called

// ─── Init ─────────────────────────────────────────────────────────────────────

storageGet(['steps', 'logoUrl', 'customLogo', 'customLogoLeft', 'suggestedTitle', 'guideDescription', 'isRecording', 'isPaused'],
  ({ steps, logoUrl, customLogo, customLogoLeft, suggestedTitle, guideDescription, isRecording, isPaused }) => {
  updateRecBadge(isRecording, isPaused);
  if (!steps || steps.length === 0) return;
  liveSteps = steps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
  lastSyncTimestamp = Math.max(...steps.map(s => s.timestamp || 0), 0);
  if (suggestedTitle && suggestedTitle !== TITLE_PLACEHOLDER) guideTitleText = suggestedTitle;
  if (guideDescription) guideDescText = guideDescription;
  emptyEl.remove();
  renderDoc(logoUrl, customLogo || null, customLogoLeft || null);
  docRendered = true;
});

// ─── Live updates from recording (extension mode only) ───────────────────────

if (!STANDALONE) chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'STATE_UPDATE') return;
  storageGet(['steps', 'isRecording', 'isPaused', 'logoUrl', 'customLogo', 'customLogoLeft', 'suggestedTitle', 'guideDescription'],
    ({ steps, isRecording, isPaused, logoUrl, customLogo, customLogoLeft, suggestedTitle, guideDescription }) => {

    updateRecBadge(isRecording, isPaused);

    const storageSteps = steps || [];

    // First render if report wasn't shown yet (tab opened before any steps existed)
    if (!docRendered && storageSteps.length > 0) {
      liveSteps = storageSteps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
      lastSyncTimestamp = Math.max(...storageSteps.map(s => s.timestamp || 0), 0);
      if (suggestedTitle && suggestedTitle !== TITLE_PLACEHOLDER) guideTitleText = suggestedTitle;
      if (guideDescription) guideDescText = guideDescription;
      emptyEl?.remove();
      renderDoc(logoUrl, customLogo || null, customLogoLeft || null);
      docRendered = true;
      return;
    }

    // Append truly new steps (by timestamp, so user edits/deletes are preserved)
    const newSteps = storageSteps.filter(s => (s.timestamp || 0) > lastSyncTimestamp);
    if (newSteps.length === 0) {
      // Recording stopped — update title and description if user hasn't edited them yet
      if (!isRecording && !isPaused) {
        if (suggestedTitle && suggestedTitle !== TITLE_PLACEHOLDER) {
          const h2 = docEl.querySelector('.cover h2');
          if (h2 && (h2.textContent === TITLE_PLACEHOLDER || h2.textContent === guideTitleText)) {
            h2.textContent = suggestedTitle;
            guideTitleText = suggestedTitle;
          }
        }
        if (guideDescription) {
          const descEl = docEl.querySelector('.guide-desc');
          if (descEl && (!guideDescText || descEl.dataset.empty)) {
            descEl.textContent = guideDescription;
            descEl.removeAttribute('data-empty');
            guideDescText = guideDescription;
          }
        }
      }
      return;
    }

    // Append new steps to liveSteps and DOM
    const section = document.getElementById('stepsSection');
    newSteps.forEach(s => {
      lastSyncTimestamp = Math.max(lastSyncTimestamp, s.timestamp || 0);
      const newStep = { ...s, stepNumber: liveSteps.length + 1 };
      liveSteps.push(newStep);
      // Compute the section-local number for this step
      const withNums = withLocalNumbers(liveSteps);
      newStep.localNumber = withNums[withNums.length - 1].localNumber;
      if (section) section.appendChild(makeStepEl(newStep));
    });

    const sc = document.getElementById('coverStepCount');
    if (sc) sc.textContent = `${liveSteps.length} steps captured`;
    updateSummary();

    // Apply suggested title when recording stops, even if final steps arrived simultaneously
    if (!isRecording && !isPaused && suggestedTitle) {
      const h2 = docEl.querySelector('.cover h2');
      const defaultTitle = 'How to: [click to name this guide]';
      if (h2 && (h2.textContent === defaultTitle || h2.textContent === guideTitleText)) {
        h2.textContent = suggestedTitle;
        guideTitleText = suggestedTitle;
      }
    }
  });
});

function updateRecBadge(isRecording, isPaused) {
  const badge = document.getElementById('recBadge');
  const label = document.getElementById('recLabel');
  if (!badge || !label) return;
  badge.className = 'rec-badge';
  if (isRecording)   { badge.classList.add('recording'); label.textContent = 'Recording'; }
  else if (isPaused) { badge.classList.add('paused');    label.textContent = 'Paused'; }
}

// ─── Full document render ─────────────────────────────────────────────────────

function renderDoc(logoUrl, customLogoData, customLogoLeftData) {
  docEl.innerHTML = '';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Cover
  const cover = document.createElement('div');
  cover.className = 'cover';

  // LEFT logo — defaults to "Add logo" placeholder (client / context logo)
  const leftLogoWrap = document.createElement('div');
  leftLogoWrap.className = 'logo-wrap';
  leftLogoWrap.title = 'Click to upload a logo';
  buildLogoEl(leftLogoWrap, customLogoLeftData || null);
  const leftHint = document.createElement('div');
  leftHint.className = 'logo-hint';
  leftHint.textContent = customLogoLeftData ? 'Change logo' : 'Add logo';
  leftLogoWrap.appendChild(leftHint);
  leftLogoWrap.addEventListener('click', () => logoInputLeft.click());

  // RIGHT logo — defaults to the Healthy Together / persistent customLogo
  const rightLogoWrap = document.createElement('div');
  rightLogoWrap.className = 'logo-wrap logo-wrap-right';
  rightLogoWrap.title = 'Click to change logo';
  buildLogoEl(rightLogoWrap, customLogoData || logoUrl);
  const rightHint = document.createElement('div');
  rightHint.className = 'logo-hint';
  rightHint.textContent = 'Change logo';
  rightLogoWrap.appendChild(rightHint);
  rightLogoWrap.addEventListener('click', () => logoInput.click());

  const badge = document.createElement('div');
  badge.className = 'cover-badge';
  badge.textContent = 'Training Guide';

  const top = document.createElement('div');
  top.className = 'cover-top';
  top.appendChild(leftLogoWrap);
  top.appendChild(badge);
  top.appendChild(rightLogoWrap);

  const h2 = document.createElement('h2');
  h2.contentEditable = 'true';
  h2.spellcheck = false;
  h2.textContent = guideTitleText;
  h2.addEventListener('input', () => { guideTitleText = h2.textContent; });

  // Editable description block — auto-generated on stop, editable by user
  const descBlock = document.createElement('div');
  descBlock.className = 'guide-desc';
  descBlock.contentEditable = 'true';
  descBlock.spellcheck = true;
  if (guideDescText) {
    descBlock.textContent = guideDescText;
  } else {
    descBlock.dataset.empty = 'true';
  }
  descBlock.addEventListener('focus', () => {
    descBlock.removeAttribute('data-empty');
    if (!descBlock.textContent) descBlock.textContent = '';
  });
  descBlock.addEventListener('blur', () => {
    guideDescText = descBlock.textContent.trim();
    if (!guideDescText) descBlock.dataset.empty = 'true';
    storageSet({ guideDescription: guideDescText });
  });
  descBlock.addEventListener('input', () => { guideDescText = descBlock.textContent; });

  const meta = document.createElement('div');
  meta.className = 'cover-meta';
  const ds = document.createElement('span');
  ds.dataset.label = 'Date'; ds.textContent = `${dateStr} at ${timeStr}`;
  meta.appendChild(ds);

  // Show the domain where the recording took place
  const firstUrl = liveSteps.find(s => s.url)?.url;
  if (firstUrl) {
    try {
      const host = new URL(firstUrl).hostname;
      const domEl = document.createElement('span');
      domEl.dataset.label = 'Recorded on';
      domEl.textContent = host;
      meta.appendChild(domEl);
    } catch(_) {}
  }

  cover.appendChild(top); cover.appendChild(h2); cover.appendChild(descBlock); cover.appendChild(meta);
  docEl.appendChild(cover);

  // Steps section
  const section = document.createElement('div');
  section.className = 'steps'; section.id = 'stepsSection';
  const heading = document.createElement('div');
  heading.className = 'steps-heading';
  heading.textContent = 'Step-by-step walkthrough';
  section.appendChild(heading);
  withLocalNumbers(liveSteps).forEach(step => section.appendChild(makeStepEl(step)));
  docEl.appendChild(section);

  // Summary section
  docEl.appendChild(buildSummarySection());

  // RIGHT logo upload (persistent Healthy Together logo)
  logoInput.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target.result;
      storageSet({ customLogo: data });
      buildLogoEl(rightLogoWrap, data);
      rightHint.textContent = 'Change logo';
    };
    reader.readAsDataURL(file);
  });

  // LEFT logo upload (context / client logo)
  logoInputLeft.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target.result;
      storageSet({ customLogoLeft: data });
      buildLogoEl(leftLogoWrap, data);
      leftHint.textContent = 'Change logo';
    };
    reader.readAsDataURL(file);
  });
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

function buildLogoEl(wrap, src) {
  Array.from(wrap.children).forEach(c => {
    if (!c.classList.contains('logo-hint')) c.remove();
  });
  if (src) {
    const img = document.createElement('img');
    img.className = 'logo-img'; img.alt = 'logo'; img.src = src;
    img.addEventListener('error', () => { img.remove(); wrap.insertBefore(buildPlaceholderEl(), wrap.querySelector('.logo-hint')); });
    wrap.insertBefore(img, wrap.querySelector('.logo-hint'));
  } else {
    wrap.insertBefore(buildPlaceholderEl(), wrap.querySelector('.logo-hint'));
  }
}

function buildPlaceholderEl() {
  const div = document.createElement('div');
  div.className = 'logo-placeholder';
  div.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>';
  const lbl = document.createElement('span');
  lbl.textContent = 'Add logo'; div.appendChild(lbl);
  return div;
}

// ─── Per-section local step numbering ────────────────────────────────────────

// Returns a copy of the steps array with a `localNumber` property on each non-section,
// non-note step that resets to 1 at every section divider.
function withLocalNumbers(steps) {
  let local = 0;
  return steps.map(s => {
    if (s.isSection) { local = 0; return { ...s, localNumber: null }; }
    if (s.isNote)    { return { ...s, localNumber: null }; }
    local++;
    return { ...s, localNumber: local };
  });
}

// ─── Step type → number circle color ─────────────────────────────────────────

function stepTypeClass(elementType) {
  const et = (elementType || '').toLowerCase();
  if (['pageload', 'navigation'].includes(et)) return 'type-nav';
  if (['change', 'select', 'input', 'textarea', 'submit'].includes(et)) return 'type-form';
  if (['search', 'dropdown', 'combobox', 'searchbox'].includes(et)) return 'type-search';
  if (['toast', 'manual'].includes(et)) return 'type-notify';
  return ''; // default indigo for button/link clicks
}

// ─── Step element ─────────────────────────────────────────────────────────────

function makeDragHandlers(el, step) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    draggedNum = step.stepNumber;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.step.drag-over').forEach(s => s.classList.remove('drag-over'));
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (draggedNum !== step.stepNumber) {
      document.querySelectorAll('.step.drag-over').forEach(s => s.classList.remove('drag-over'));
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    if (draggedNum == null || draggedNum === step.stepNumber) return;
    const fromIdx = liveSteps.findIndex(s => s.stepNumber === draggedNum);
    const toIdx   = liveSteps.findIndex(s => s.stepNumber === step.stepNumber);
    const [moved] = liveSteps.splice(fromIdx, 1);
    // After removing fromIdx, elements after it shift left by 1.
    // If the target was after the source, adjust by -1 to land at the correct position.
    const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
    liveSteps.splice(insertIdx, 0, moved);
    liveSteps = liveSteps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    draggedNum = null;
    rerenderSteps();
  });
}

function makeStepEl(step) {
  const el = document.createElement('div');
  el.dataset.num = step.stepNumber;

  // ── Section divider ────────────────────────────────────────────────────────
  if (step.isSection) {
    el.className = 'step step-section' + (step.isTabSwitch ? ' tab-switch' : '');
    makeDragHandlers(el, step);

    const grip = document.createElement('div');
    grip.className = 'drag-handle';
    grip.title = 'Drag to reorder';
    grip.innerHTML = '<svg viewBox="0 0 8 14" fill="currentColor" width="10" height="16" style="display:block"><circle cx="2" cy="2" r="1.5"/><circle cx="6" cy="2" r="1.5"/><circle cx="2" cy="7" r="1.5"/><circle cx="6" cy="7" r="1.5"/><circle cx="2" cy="12" r="1.5"/><circle cx="6" cy="12" r="1.5"/></svg>';
    grip.addEventListener('mousedown', () => { el.draggable = true; });

    const title = document.createElement('div');
    title.className = 'section-title';
    title.contentEditable = 'true';
    title.spellcheck = false;
    title.textContent = step.description || '';
    title.dataset.placeholder = 'Section title…';
    title.addEventListener('mousedown', () => { el.draggable = false; });
    title.addEventListener('blur', () => {
      el.draggable = true;
      const s = liveSteps.find(x => x.stepNumber === step.stepNumber);
      if (s) s.description = title.textContent;
      updateSummary();
    });

    const inner = document.createElement('div');
    inner.className = 'section-inner';
    inner.appendChild(grip);

    if (step.isTabSwitch) {
      // Wrap title + domain URL in a column, add badge on right
      const textCol = document.createElement('div');
      textCol.className = 'section-text-col';
      textCol.appendChild(title);

      let domain = '';
      try { domain = new URL(step.url || '').hostname; } catch(_) {}
      if (domain) {
        const urlEl = document.createElement('div');
        urlEl.className = 'section-tab-url';
        urlEl.textContent = domain;
        textCol.appendChild(urlEl);
      }
      inner.appendChild(textCol);

      const badge = document.createElement('div');
      badge.className = 'section-tab-badge';
      badge.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" width="10" height="10"><path d="M2 10 L10 2"/><path d="M5 2 h5 v5"/></svg> Tab Switch`;
      inner.appendChild(badge);
    } else {
      inner.appendChild(title);
    }

    el.appendChild(inner);
    el.appendChild(buildActionsBar(step, el, null, null));
    return el;
  }

  // ── Regular / note / custom step ───────────────────────────────────────────
  // step-short: no screenshot → flows without a forced page break in print
  const isShort = step.isNote || (!step.screenshot && !step.isCustom);
  el.className = 'step' + (step.isNote ? ' step-note' : '') + (isShort ? ' step-short' : '');
  makeDragHandlers(el, step);

  // Header
  const header = document.createElement('div');
  header.className = 'step-header';

  const grip = document.createElement('div');
  grip.className = 'drag-handle';
  grip.title = 'Drag to reorder';
  grip.innerHTML = '<svg viewBox="0 0 8 14" fill="currentColor" width="10" height="16" style="display:block"><circle cx="2" cy="2" r="1.5"/><circle cx="6" cy="2" r="1.5"/><circle cx="2" cy="7" r="1.5"/><circle cx="6" cy="7" r="1.5"/><circle cx="2" cy="12" r="1.5"/><circle cx="6" cy="12" r="1.5"/></svg>';
  // Prevent contenteditable drag from firing on children
  grip.addEventListener('mousedown', () => { el.draggable = true; });

  const numEl = document.createElement('div');
  numEl.className = 'step-number';
  numEl.textContent = step.localNumber ?? step.stepNumber;

  const textWrap = document.createElement('div');
  textWrap.className = 'step-text';

  if (step.isNote) {
    const badge = document.createElement('div');
    badge.className = 'note-badge';
    badge.textContent = '✏ Note';
    textWrap.appendChild(badge);
  }

  const desc = document.createElement('div');
  desc.className = 'step-description';
  desc.contentEditable = 'true';
  desc.spellcheck = false;
  desc.textContent = step.description || '';
  desc.dataset.placeholder = step.isNote ? 'Type your note here…' : 'Enter step title…';
  // Disable drag on description so text selection works
  desc.addEventListener('mousedown', () => { el.draggable = false; });
  desc.addEventListener('blur', () => {
    el.draggable = true;
    // Sync edit back to liveSteps and summary
    const s = liveSteps.find(x => x.stepNumber === step.stepNumber);
    if (s) s.description = desc.textContent;
    updateSummary();
  });
  textWrap.appendChild(desc);

  if (!step.isNote && !step.isCustom && step.url) {
    const urlEl = document.createElement('div');
    urlEl.className = 'step-url';
    let urlDisplay = step.url;
    try {
      const u = new URL(step.url);
      urlDisplay = u.hostname + u.pathname;
      if (urlDisplay.length > 72) urlDisplay = urlDisplay.substring(0, 70) + '…';
    } catch(_) {}
    urlEl.textContent = urlDisplay;
    textWrap.appendChild(urlEl);
  }

  header.appendChild(grip); header.appendChild(numEl); header.appendChild(textWrap);
  el.appendChild(header);

  // Screenshot
  if (!step.isNote) {
    if (step.screenshot) {
      const wrap = document.createElement('div');
      wrap.className = 'screenshot-wrap';
      const img = document.createElement('img');
      img.className = 'step-screenshot';
      img.loading = 'lazy'; img.src = step.screenshot; img.alt = `Step ${step.stepNumber}`;
      img.addEventListener('load', () => {
        if (img.naturalHeight > img.naturalWidth * 1.1) img.classList.add('portrait');
      });
      wrap.appendChild(img);
      if (step.annotations?.length) buildAnnotationLayer(step, img, wrap);
      el.appendChild(wrap);
      el.appendChild(buildActionsBar(step, el, wrap, img));
    } else if (step.isCustom) {
      // Custom step with no screenshot yet — show clickable upload area
      const uploadArea = document.createElement('div');
      uploadArea.className = 'upload-placeholder';
      uploadArea.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="3"/>
          <path d="M3 9h18M9 3v6"/>
          <circle cx="8" cy="14" r="1.5" fill="currentColor" stroke="none"/>
          <path d="m21 21-4-4m0 0a6 6 0 1 0-8.485-8.485A6 6 0 0 0 17 17z" opacity="0"/>
          <path d="M12 14l2 2 4-4"/>
        </svg>
        <span class="upload-label">Click to upload a screenshot</span>
        <span class="upload-sub">PNG, JPG, or any image from your computer</span>`;
      uploadArea.addEventListener('click', () => {
        pendingScreenshotStep = step;
        screenshotInput.click();
      });
      el.appendChild(uploadArea);
      el.appendChild(buildActionsBar(step, el, null, null));
    } else {
      const ns = document.createElement('div');
      ns.className = 'no-screenshot'; ns.textContent = 'No screenshot available';
      el.appendChild(ns);
      el.appendChild(buildActionsBar(step, el, null, null));
    }
  } else {
    el.appendChild(buildActionsBar(step, el, null, null));
  }

  return el;
}

// ─── Actions bar ─────────────────────────────────────────────────────────────

function buildActionsBar(step, el, screenshotWrap, img) {
  const bar = document.createElement('div');
  bar.className = 'step-actions';

  // Add section below (first button)
  const addSectionBtn = makeActionBtn('addSection', 'Add section below');
  addSectionBtn.title = 'Insert a section divider below — use to mark transitions between different parts of the guide';
  addSectionBtn.addEventListener('click', () => {
    const idx = liveSteps.findIndex(s => s.stepNumber === step.stepNumber);
    const newSection = {
      stepNumber: 0,
      isSection: true,
      description: '',
      url: '',
      pageTitle: '',
      screenshot: null,
      timestamp: Date.now()
    };
    liveSteps.splice(idx + 1, 0, newSection);
    liveSteps = liveSteps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    rerenderSteps();
    setTimeout(() => {
      const newEl = docEl.querySelector(`.step[data-num="${idx + 2}"] .section-title`);
      if (newEl) { newEl.focus(); newEl.closest('.step').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 60);
  });
  bar.appendChild(addSectionBtn);

  // Add page below (second button)
  const addPageBtn = makeActionBtn('addPage', 'Add page below');
  addPageBtn.title = 'Insert a new step below with a custom title and uploaded screenshot';
  addPageBtn.addEventListener('click', () => {
    const idx = liveSteps.findIndex(s => s.stepNumber === step.stepNumber);
    const newStep = {
      stepNumber: 0,
      isCustom: true,
      description: '',
      url: '',
      pageTitle: '',
      screenshot: null,
      timestamp: Date.now()
    };
    liveSteps.splice(idx + 1, 0, newStep);
    liveSteps = liveSteps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    rerenderSteps();
    setTimeout(() => {
      const newEl = docEl.querySelector(`.step[data-num="${idx + 2}"]`);
      if (newEl) {
        newEl.querySelector('.step-description')?.focus();
        newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 60);
  });
  bar.appendChild(addPageBtn);

  // Redact area (only for steps with screenshots)
  if (img && screenshotWrap) {
    const redactBtn = makeActionBtn('redact', 'Redact area');
    redactBtn.title = 'Click then drag on the screenshot to pixelate sensitive info';
    redactBtn.addEventListener('click', () => {
      if (redactBtn.classList.contains('active')) {
        // Cancel redact mode
        removeRedactOverlay(screenshotWrap);
        redactBtn.classList.remove('active');
        redactBtn.querySelector('span').textContent = 'Redact area';
        activeRedactBtn = null;
      } else {
        // Cancel any other active redact
        if (activeRedactBtn) activeRedactBtn.click();
        redactBtn.classList.add('active');
        redactBtn.querySelector('span').textContent = 'Cancel redact';
        activeRedactBtn = redactBtn;
        startRedactMode(screenshotWrap, img, step, () => {
          redactBtn.classList.remove('active');
          redactBtn.querySelector('span').textContent = 'Redact area';
          activeRedactBtn = null;
        });
      }
    });
    bar.appendChild(redactBtn);

    // Annotate — draw a highlight circle on the screenshot
    const annotateBtn = makeActionBtn('annotate', 'Highlight area');
    annotateBtn.title = 'Click and drag to draw a circle or oval highlight on the screenshot';
    annotateBtn.addEventListener('click', () => {
      if (annotateBtn.classList.contains('active')) {
        removeAnnotateOverlay(screenshotWrap);
        annotateBtn.classList.remove('active');
        annotateBtn.querySelector('span').textContent = 'Highlight area';
        activeAnnotateBtn = null;
      } else {
        // Cancel any other active mode
        if (activeAnnotateBtn) activeAnnotateBtn.click();
        if (activeRedactBtn) activeRedactBtn.click();
        annotateBtn.classList.add('active');
        annotateBtn.querySelector('span').textContent = 'Cancel highlight';
        activeAnnotateBtn = annotateBtn;
        startAnnotateMode(screenshotWrap, img, step, () => {
          annotateBtn.classList.remove('active');
          annotateBtn.querySelector('span').textContent = 'Highlight area';
          activeAnnotateBtn = null;
        });
      }
    });
    bar.appendChild(annotateBtn);
  }

  bar.appendChild(document.createElement('div')).className = 'spacer'; // flex spacer

  // Remove — label changes based on what's being removed
  const removeLabel = step.isSection ? 'Remove section'
    : step.isNote   ? 'Remove note'
    : step.isCustom ? 'Remove page'
    : 'Remove step';
  const removeBtn = makeActionBtn('remove', removeLabel);
  removeBtn.classList.add('danger');
  removeBtn.addEventListener('click', () => deleteStep(step.stepNumber));
  bar.appendChild(removeBtn);

  return bar;
}

const BTN_ICONS = {
  addPage: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="11"/><line x1="5" y1="8" x2="11" y2="8"/></svg>`,
  addSection: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>`,
  redact: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="12" height="8" rx="1.5"/><path d="M5 5V4a3 3 0 0 1 6 0v1"/><line x1="8" y1="8" x2="8" y2="10"/></svg>`,
  annotate: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="8" cy="8" rx="6" ry="4.5"/></svg>`,
  remove: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="2,4 14,4"/><path d="M5 4V3h6v1"/><path d="M4 4l.75 9h6.5L12 4"/></svg>`
};

function makeActionBtn(iconKey, label) {
  const btn = document.createElement('button');
  btn.className = 'action-btn';
  const svg = BTN_ICONS[iconKey] || '';
  btn.innerHTML = `${svg}<span>${label}</span>`;
  return btn;
}

// ─── Redact mode ──────────────────────────────────────────────────────────────

function startRedactMode(wrap, img, step, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'redact-overlay';

  const hint = document.createElement('div');
  hint.className = 'redact-hint';
  hint.textContent = 'Click and drag to redact an area';
  overlay.appendChild(hint);

  let startX, startY, selBox, selecting = false;

  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    selecting = true;
    selBox = document.createElement('div');
    selBox.className = 'redact-selection';
    overlay.appendChild(selBox);
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!selecting || !selBox) return;
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const left = Math.min(x, startX), top = Math.min(y, startY);
    const w = Math.abs(x - startX), h = Math.abs(y - startY);
    Object.assign(selBox.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!selecting || !selBox) return;
    selecting = false;
    const rect = overlay.getBoundingClientRect();
    const selX = parseFloat(selBox.style.left);
    const selY = parseFloat(selBox.style.top);
    const selW = parseFloat(selBox.style.width);
    const selH = parseFloat(selBox.style.height);
    overlay.remove();
    if (selW > 8 && selH > 8) {
      applyRedaction(img, step, selX / rect.width, selY / rect.height, selW / rect.width, selH / rect.height);
    }
    onDone();
  });

  wrap.appendChild(overlay);
}

function removeRedactOverlay(wrap) {
  const ov = wrap.querySelector('.redact-overlay');
  if (ov) ov.remove();
}

function applyRedaction(img, step, xPct, yPct, wPct, hPct) {
  const canvas = document.createElement('canvas');
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const rx = Math.round(xPct * img.naturalWidth);
  const ry = Math.round(yPct * img.naturalHeight);
  const rw = Math.round(wPct * img.naturalWidth);
  const rh = Math.round(hPct * img.naturalHeight);

  // Pixelation: shrink region then upscale with smoothing off
  const pixSize  = Math.max(6, Math.round(Math.min(rw, rh) / 12));
  const tiny     = document.createElement('canvas');
  tiny.width     = Math.max(1, Math.round(rw / pixSize));
  tiny.height    = Math.max(1, Math.round(rh / pixSize));
  const tinyCtx  = tiny.getContext('2d');
  tinyCtx.drawImage(canvas, rx, ry, rw, rh, 0, 0, tiny.width, tiny.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, rx, ry, rw, rh);

  const newSrc = canvas.toDataURL('image/jpeg', 0.95);
  img.src = newSrc;
  step.screenshot = newSrc;
}

// ─── Annotate mode ────────────────────────────────────────────────────────────

function startAnnotateMode(wrap, img, step, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'redact-overlay annotate-overlay';   // reuse cursor + tint style

  const hint = document.createElement('div');
  hint.className = 'redact-hint';
  hint.textContent = 'Click and drag to draw a highlight circle';
  overlay.appendChild(hint);

  let startX, startY, selBox, selecting = false;

  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    selecting = true;
    selBox = document.createElement('div');
    selBox.className = 'annotate-selection';
    overlay.appendChild(selBox);
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!selecting || !selBox) return;
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const left = Math.min(x, startX), top = Math.min(y, startY);
    const w = Math.abs(x - startX), h = Math.abs(y - startY);
    Object.assign(selBox.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  });

  overlay.addEventListener('mouseup', () => {
    if (!selecting || !selBox) return;
    selecting = false;
    const rect = overlay.getBoundingClientRect();
    const selX = parseFloat(selBox.style.left  || '0');
    const selY = parseFloat(selBox.style.top   || '0');
    const selW = parseFloat(selBox.style.width || '0');
    const selH = parseFloat(selBox.style.height|| '0');
    overlay.remove();
    if (selW > 8 && selH > 8) {
      if (!step.annotations) step.annotations = [];
      step.annotations.push({
        id: Date.now() + '_' + Math.floor(Math.random() * 9999),
        xPct: selX / rect.width,
        yPct: selY / rect.height,
        wPct: selW / rect.width,
        hPct: selH / rect.height
      });
      buildAnnotationLayer(step, img, wrap);
      saveAnnotations(step);
    }
    onDone();
  });

  wrap.appendChild(overlay);
}

function removeAnnotateOverlay(wrap) {
  const ov = wrap.querySelector('.annotate-overlay');
  if (ov) ov.remove();
}

// ─── Annotation SVG layer — live, editable circles ────────────────────────────

const ANN_VW = 1000, ANN_VH = 1000;   // viewBox coordinate space

function buildAnnotationLayer(step, imgEl, wrap) {
  wrap.querySelector('.annotation-layer')?.remove();
  if (!step.annotations?.length) return;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('annotation-layer');
  svg.setAttribute('viewBox', `0 0 ${ANN_VW} ${ANN_VH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  Object.assign(svg.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    overflow: 'visible', pointerEvents: 'none', zIndex: '5'
  });

  step.annotations.forEach(ann => addAnnotationToSvg(svg, ann, step));
  wrap.appendChild(svg);
}

function addAnnotationToSvg(svg, ann, step) {
  const NS = 'http://www.w3.org/2000/svg';

  // Map percent → viewBox units
  const cx = () => (ann.xPct + ann.wPct / 2) * ANN_VW;
  const cy = () => (ann.yPct + ann.hPct / 2) * ANN_VH;
  const rx = () => (ann.wPct / 2) * ANN_VW;
  const ry = () => (ann.hPct / 2) * ANN_VH;

  const g = document.createElementNS(NS, 'g');

  // ── Visual: shadow ellipse + main ellipse + fat transparent hit area ────
  function mkEllipse(fill, stroke, sw, pe) {
    const e = document.createElementNS(NS, 'ellipse');
    e.setAttribute('fill', fill);
    e.setAttribute('stroke', stroke);
    e.setAttribute('stroke-width', sw);
    e.setAttribute('vector-effect', 'non-scaling-stroke');
    e.style.pointerEvents = pe;
    return e;
  }
  const shadow = mkEllipse('none', 'rgba(0,0,0,0.3)', '7', 'none');
  const ring   = mkEllipse('none', '#ff3b30',          '3', 'none');
  const hit    = mkEllipse('transparent', 'transparent', '22', 'all');
  hit.style.cursor = 'move';

  function syncEllipses() {
    [shadow, ring, hit].forEach(e => {
      e.setAttribute('cx', cx()); e.setAttribute('cy', cy());
      e.setAttribute('rx', rx()); e.setAttribute('ry', ry());
    });
  }
  syncEllipses();
  g.appendChild(shadow); g.appendChild(ring); g.appendChild(hit);

  // ── 4 corner resize handles ─────────────────────────────────────────────
  const CORNERS = [
    { id: 'nw', ax: 0, ay: 0, cur: 'nwse-resize' },
    { id: 'ne', ax: 1, ay: 0, cur: 'nesw-resize' },
    { id: 'sw', ax: 0, ay: 1, cur: 'nesw-resize' },
    { id: 'se', ax: 1, ay: 1, cur: 'nwse-resize' },
  ];
  const handleEls = {};
  CORNERS.forEach(c => {
    const h = document.createElementNS(NS, 'circle');
    h.setAttribute('r', '9'); h.setAttribute('fill', '#fff');
    h.setAttribute('stroke', '#ff3b30'); h.setAttribute('stroke-width', '2.5');
    h.setAttribute('vector-effect', 'non-scaling-stroke');
    h.style.cursor = c.cur; h.style.pointerEvents = 'all'; h.style.display = 'none';
    handleEls[c.id] = h;
    g.appendChild(h);
  });

  // ── Delete button at NE corner ──────────────────────────────────────────
  const delG = document.createElementNS(NS, 'g');
  delG.style.cursor = 'pointer'; delG.style.pointerEvents = 'all'; delG.style.display = 'none';
  const delBg = document.createElementNS(NS, 'circle');
  delBg.setAttribute('r', '11'); delBg.setAttribute('fill', '#ff3b30');
  delBg.setAttribute('stroke', '#fff'); delBg.setAttribute('stroke-width', '2');
  delBg.setAttribute('vector-effect', 'non-scaling-stroke');
  const delTx = document.createElementNS(NS, 'text');
  delTx.textContent = '×';
  delTx.setAttribute('text-anchor', 'middle'); delTx.setAttribute('dominant-baseline', 'middle');
  delTx.setAttribute('fill', '#fff'); delTx.setAttribute('font-size', '16');
  delTx.setAttribute('font-weight', '700'); delTx.style.pointerEvents = 'none';
  delG.appendChild(delBg); delG.appendChild(delTx);
  g.appendChild(delG);

  function syncHandlesAndDel() {
    CORNERS.forEach(c => {
      handleEls[c.id].setAttribute('cx', (ann.xPct + c.ax * ann.wPct) * ANN_VW);
      handleEls[c.id].setAttribute('cy', (ann.yPct + c.ay * ann.hPct) * ANN_VH);
    });
    const dx = (ann.xPct + ann.wPct) * ANN_VW;
    const dy = ann.yPct * ANN_VH;
    delBg.setAttribute('cx', dx); delBg.setAttribute('cy', dy);
    delTx.setAttribute('x', dx);  delTx.setAttribute('y', dy);
  }
  syncHandlesAndDel();

  // ── Show/hide handles on group hover ────────────────────────────────────
  let isDragging = false;
  function showHandles() {
    CORNERS.forEach(c => handleEls[c.id].style.display = '');
    delG.style.display = '';
    svg.style.pointerEvents = 'all';
  }
  function hideHandles() {
    if (isDragging) return;
    CORNERS.forEach(c => handleEls[c.id].style.display = 'none');
    delG.style.display = 'none';
    svg.style.pointerEvents = 'none';
  }
  g.addEventListener('mouseenter', showHandles);
  g.addEventListener('mouseleave', hideHandles);

  // ── Move (drag the hit area) ─────────────────────────────────────────────
  hit.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    isDragging = true;
    const svgRect = svg.getBoundingClientRect();
    let prevX = e.clientX, prevY = e.clientY;
    function onMove(e) {
      const dx = (e.clientX - prevX) / svgRect.width;
      const dy = (e.clientY - prevY) / svgRect.height;
      prevX = e.clientX; prevY = e.clientY;
      ann.xPct = Math.max(0, Math.min(1 - ann.wPct, ann.xPct + dx));
      ann.yPct = Math.max(0, Math.min(1 - ann.hPct, ann.yPct + dy));
      syncEllipses(); syncHandlesAndDel();
    }
    function onUp() {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveAnnotations(step);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Resize (drag corner handles) ─────────────────────────────────────────
  CORNERS.forEach(c => {
    handleEls[c.id].addEventListener('mousedown', (e) => {
      e.stopPropagation(); e.preventDefault();
      isDragging = true;
      const svgRect = svg.getBoundingClientRect();
      let prevX = e.clientX, prevY = e.clientY;
      function onMove(e) {
        const dx = (e.clientX - prevX) / svgRect.width;
        const dy = (e.clientY - prevY) / svgRect.height;
        prevX = e.clientX; prevY = e.clientY;
        if (c.ax === 0) {
          const right = ann.xPct + ann.wPct;
          ann.xPct = Math.min(ann.xPct + dx, right - 0.02);
          ann.wPct = right - ann.xPct;
        } else {
          ann.wPct = Math.max(0.02, ann.wPct + dx);
        }
        if (c.ay === 0) {
          const bot = ann.yPct + ann.hPct;
          ann.yPct = Math.min(ann.yPct + dy, bot - 0.02);
          ann.hPct = bot - ann.yPct;
        } else {
          ann.hPct = Math.max(0.02, ann.hPct + dy);
        }
        syncEllipses(); syncHandlesAndDel();
      }
      function onUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveAnnotations(step);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // ── Delete ───────────────────────────────────────────────────────────────
  delG.addEventListener('click', (e) => {
    e.stopPropagation();
    step.annotations = step.annotations.filter(a => a.id !== ann.id);
    g.remove();
    if (!svg.querySelectorAll('g').length) svg.remove();
    saveAnnotations(step);
  });

  svg.appendChild(g);
}

function saveAnnotations(step) {
  const live = liveSteps.find(s => s.stepNumber === step.stepNumber);
  if (live) live.annotations = step.annotations;
  storageSet({ steps: liveSteps });
}

// Bake annotations onto a screenshot data URL (used for ZIP export so circles appear in downloaded images)
async function bakeAnnotationsFromUrl(dataUrl, annotations) {
  if (!annotations?.length) return dataUrl;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const sw = Math.max(3, Math.round(img.naturalWidth / 300));
      annotations.forEach(ann => {
        const ecx = (ann.xPct + ann.wPct / 2) * img.naturalWidth;
        const ecy = (ann.yPct + ann.hPct / 2) * img.naturalHeight;
        const erx = (ann.wPct / 2) * img.naturalWidth;
        const ery = (ann.hPct / 2) * img.naturalHeight;
        ctx.save();
        ctx.beginPath(); ctx.ellipse(ecx, ecy, erx, ery, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = sw + 4; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(ecx, ecy, erx, ery, 0, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = sw; ctx.stroke();
        ctx.restore();
      });
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.src = dataUrl;
  });
}

// ─── Re-render steps only ────────────────────────────────────────────────────

function rerenderSteps() {
  // Save guide title before touching DOM
  const titleEl = docEl.querySelector('.cover h2');
  if (titleEl) guideTitleText = titleEl.textContent;

  const section = document.getElementById('stepsSection');
  if (!section) return;
  const heading = document.createElement('div');
  heading.className = 'steps-heading';
  heading.textContent = 'Step-by-step walkthrough';
  section.innerHTML = '';
  section.appendChild(heading);
  withLocalNumbers(liveSteps).forEach(step => section.appendChild(makeStepEl(step)));

  const sc = document.getElementById('coverStepCount');
  if (sc) sc.textContent = `${liveSteps.length} steps captured`;

  updateSummary();
}

function deleteStep(stepNumber) {
  liveSteps = liveSteps
    .filter(s => s.stepNumber !== stepNumber)
    .map((s, i) => ({ ...s, stepNumber: i + 1 }));
  rerenderSteps();
}

// ─── Summary section ──────────────────────────────────────────────────────────

function buildSummarySection() {
  const section = document.createElement('div');
  section.className = 'summary-section';
  section.id = 'summarySection';

  const headingRow = document.createElement('div');
  headingRow.className = 'steps-heading';
  headingRow.textContent = 'Quick reference — all steps';
  section.appendChild(headingRow);

  const list = document.createElement('ol');
  list.className = 'summary-list';
  list.id = 'summaryList';
  section.appendChild(list);

  // Populate
  _fillSummaryList(list);

  return section;
}

function _fillSummaryList(list) {
  list.innerHTML = '';
  liveSteps.filter(s => !s.isNote).forEach((step) => {

    if (step.isSection) {
      // Section heading — no counter increment
      const li = document.createElement('li');
      li.className = 'summary-section-header' + (step.isTabSwitch ? ' tab-switch' : '');

      const span = document.createElement('span');
      span.className = 'summary-section-title';
      span.contentEditable = 'true';
      span.spellcheck = false;
      span.textContent = step.description || '';
      span.dataset.placeholder = 'Section title…';

      span.addEventListener('blur', () => {
        const s = liveSteps.find(x => x.stepNumber === step.stepNumber);
        if (s) {
          s.description = span.textContent;
          const sectionTitleEl = docEl.querySelector(`.step[data-num="${step.stepNumber}"] .section-title`);
          if (sectionTitleEl) sectionTitleEl.textContent = span.textContent;
        }
      });

      li.appendChild(span);
      list.appendChild(li);
      return;
    }

    // Regular / custom step
    const li = document.createElement('li');
    li.className = 'summary-item';
    li.dataset.num = step.stepNumber;

    const span = document.createElement('span');
    span.className = 'summary-text';
    span.contentEditable = 'true';
    span.spellcheck = false;
    span.textContent = step.description || '';

    span.addEventListener('blur', () => {
      const s = liveSteps.find(x => x.stepNumber === step.stepNumber);
      if (s) {
        s.description = span.textContent;
        const stepEl = docEl.querySelector(`.step[data-num="${step.stepNumber}"] .step-description`);
        if (stepEl) stepEl.textContent = span.textContent;
      }
    });

    li.appendChild(span);
    list.appendChild(li);
  });
}

function updateSummary() {
  const list = document.getElementById('summaryList');
  if (list) _fillSummaryList(list);
}

// ─── Export ───────────────────────────────────────────────────────────────────

// Toggle export menu
btnExport.addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle('open');
});
document.addEventListener('click', () => exportMenu.classList.remove('open'));

document.getElementById('exportMd').addEventListener('click', () => {
  exportMenu.classList.remove('open');
  const title = getCurrentTitle();
  const lines = [
    `# ${title}`,
    '',
    `*Training guide generated by TrainDoc · ${new Date().toLocaleDateString()}*`,
    '',
    '---',
    ''
  ];
  liveSteps.forEach(step => {
    if (step.isNote) {
      lines.push(`> **Note:** ${step.description || ''}`, '');
    } else {
      lines.push(
        `## Step ${step.stepNumber}: ${step.description}`,
        '',
        `**URL:** \`${step.url}\``,
        ''
      );
      if (step.screenshot) {
        lines.push(`![Step ${step.stepNumber}](${step.screenshot})`, '');
      }
      lines.push('---', '');
    }
  });
  downloadFile(`${slugify(title)}.md`, lines.join('\n'), 'text/markdown');
});

document.getElementById('exportHtml').addEventListener('click', () => {
  exportMenu.classList.remove('open');
  const title = getCurrentTitle();
  const stepHtml = liveSteps.map(step => {
    if (step.isNote) {
      return `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;margin:16px 0;border-radius:4px;">
  <strong>📝 Note</strong><br/>${escHtml(step.description || '')}
</div>`;
    }
    const img = step.screenshot
      ? `<img src="${step.screenshot}" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;margin-top:12px;display:block;" alt="Step ${step.stepNumber}" />`
      : '<p style="color:#9ca3af;font-style:italic;">No screenshot</p>';
    return `<div style="margin-bottom:36px;page-break-inside:avoid;">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
    <span style="background:#4f46e5;color:#fff;border-radius:50%;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${step.stepNumber}</span>
    <strong style="font-size:15px;">${escHtml(step.description)}</strong>
  </div>
  <p style="font-size:11px;color:#9ca3af;margin:0 0 4px 44px;">${escHtml(step.url)}</p>
  <div style="margin-left:44px;">${img}</div>
</div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escHtml(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:860px;margin:40px auto;color:#111827;padding:0 20px;">
  <h1 style="font-size:28px;font-weight:800;margin-bottom:8px;">${escHtml(title)}</h1>
  <p style="color:#6b7280;margin-bottom:32px;font-size:13px;">Training guide · ${new Date().toLocaleDateString()}</p>
  <hr style="border:none;border-top:2px solid #e5e7eb;margin-bottom:32px;"/>
  ${stepHtml}
</body>
</html>`;
  downloadFile(`${slugify(title)}.html`, html, 'text/html');
});

document.getElementById('exportScreenshots').addEventListener('click', async () => {
  exportMenu.classList.remove('open');

  // Collect steps that have a screenshot, preserving display order
  const imgSteps = liveSteps.filter(s => s.screenshot && !s.isSection && !s.isNote);
  if (imgSteps.length === 0) { alert('No screenshots to download.'); return; }

  // Bake any SVG annotations into the JPEG before zipping
  const files = await Promise.all(imgSteps.map(async (step, i) => {
    const num = String(i + 1).padStart(2, '0');
    const desc = (step.description || 'step')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .substring(0, 40);
    const dataUrl = await bakeAnnotationsFromUrl(step.screenshot, step.annotations);
    return { name: `${num}-${desc}.jpg`, dataUrl };
  }));

  const blob = MiniZip.create(files);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${slugify(getCurrentTitle())}-screenshots.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ─── Toolbar buttons ─────────────────────────────────────────────────────────

btnPrint.addEventListener('click', () => {
  // Show the headers/footers reminder for 6s then hide
  printTip.classList.add('visible');
  setTimeout(() => printTip.classList.remove('visible'), 6000);
  setTimeout(() => window.print(), 300);
});

// External screenshot upload handler
screenshotInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  screenshotInput.value = '';
  if (!file || !pendingScreenshotStep) return;
  const stepNum = pendingScreenshotStep.stepNumber;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const data = ev.target.result;
    // Find the live step by stepNumber (withLocalNumbers returns copies, so update liveSteps directly)
    const target = liveSteps.find(s => s.stepNumber === stepNum);
    if (target) target.screenshot = data;
    rerenderSteps();
    pendingScreenshotStep = null;
  };
  reader.readAsDataURL(file);
});

btnNew.addEventListener('click', () => {
  if (STANDALONE) { downloadUpdatedReport(); return; }
  if (confirm('Clear this recording and start a new one?')) {
    // Keep customLogo so it persists to the next recording
    chrome.storage.local.set({ steps: [], isRecording: false, logoUrl: null }, () => window.close());
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentTitle() {
  const el = docEl.querySelector('.cover h2');
  return (el ? el.textContent : guideTitleText) || 'Training Guide';
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function slugify(s) {
  return (s || 'guide').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Share (extension mode) ───────────────────────────────────────────────────

document.getElementById('btnShare')?.addEventListener('click', async () => {
  if (STANDALONE) return;
  const btn = document.getElementById('btnShare');
  const origText = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Exporting…';
  try {
    const data = Object.assign({}, _mem || {});
    data.steps = liveSteps;
    data.suggestedTitle = getCurrentTitle();
    data.guideDescription = guideDescText;
    data.isRecording = false;
    data.isPaused = false;

    const [htmlSrc, jsSrc, zipSrc] = await Promise.all([
      fetch(location.href).then(r => r.text()),
      fetch(chrome.runtime.getURL('report.js')).then(r => r.text()),
      fetch(chrome.runtime.getURL('minizip.js')).then(r => r.text()),
    ]);

    const safeJson = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
    const safeJs  = jsSrc.replace(/<\/script>/gi, '<\\/script>');
    const safeZip = zipSrc.replace(/<\/script>/gi, '<\\/script>');
    let html = htmlSrc
      .replace('<script src="minizip.js"></script>', `<script id="__minizip__">${safeZip}<\/script>`)
      .replace('<script src="report.js"></script>',
        `<script id="__traindoc_data__">window.__TRAINDOC_DATA__ = ${safeJson};<\/script>\n<script id="__traindoc_report__">${safeJs}<\/script>`);

    const title = slugify(getCurrentTitle());
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${title}.html`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch(err) {
    alert('Export failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = origText;
  }
});

// ─── Download Updated Report (standalone mode) ────────────────────────────────

function downloadUpdatedReport() {
  const data = Object.assign({}, _mem || {});
  data.steps = liveSteps;
  data.suggestedTitle = getCurrentTitle();
  data.guideDescription = guideDescText;
  data.isRecording = false;
  data.isPaused = false;

  const dataScript = document.getElementById('__traindoc_data__');
  if (dataScript) {
    const safeJson = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
    dataScript.textContent = `window.__TRAINDOC_DATA__ = ${safeJson};`;
  }

  const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  const title = slugify(getCurrentTitle());
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${title}-updated.html`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Standalone UI config ─────────────────────────────────────────────────────

if (STANDALONE) {
  const btnNew = document.getElementById('btnNew');
  if (btnNew) btnNew.textContent = '↓ Download Updated Report';
  document.getElementById('btnShare')?.style.setProperty('display', 'none');
  document.getElementById('recBadge')?.style.setProperty('display', 'none');
}

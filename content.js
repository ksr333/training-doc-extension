// TrainDoc content script v11
if (window.__trainDocLoaded) {
  chrome.storage.local.get('isRecording', (d) => { window.__trainDocIsRecording = !!d.isRecording; });
} else {
window.__trainDocLoaded = true;
window.__trainDocIsRecording = false;

let lastCaptureTime = 0;
const DEBOUNCE_MS = 400; // reduced from 800ms — allows rapid sequential clicks (e.g. inside Docuseal signing flow)
let lastPageTitle = document.title;
let lastDropdownLabel = '';
let lastDropdownTime = 0;
let lastClickTime = 0; // tracks most recent click for nav suppression

// ─── Core send ───────────────────────────────────────────────────────────────

function sendStep(description, elementType, opts = {}) {
  if (document.hidden) return;
  const now = Date.now();
  if (now - lastCaptureTime < DEBOUNCE_MS) return;
  lastCaptureTime = now;
  chrome.runtime.sendMessage({
    type: 'CAPTURE_STEP', description, elementType,
    url: location.href, pageTitle: document.title,
    ...opts
  }).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLabel(el) {
  // 1. HTML <label for="id"> association
  if (el.labels && el.labels.length) return el.labels[0].textContent.trim();

  // 2. aria-label directly on element
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // 3. aria-labelledby → resolve referenced element text
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent.trim() || '')
      .filter(Boolean).join(' ');
    if (text) return text;
  }

  // 4. Walk up DOM tree — for each ancestor, look at children that appear
  //    BEFORE the branch containing our element. The first short text node
  //    found is the visible label (e.g. "Recipient", "Admin", "Email").
  function findLabelBefore(container, childBranch) {
    for (const child of container.children) {
      if (child === childBranch || child.contains(el)) break;
      // Skip containers that have their own form controls (not labels)
      if (child.querySelector('input, select, textarea, button')) continue;
      const text = (child.innerText || child.textContent || '').trim().replace(/\s+/g, ' ');
      if (text && text.length > 0 && text.length < 80) return text;
    }
    return null;
  }

  let node = el;
  for (let depth = 0; depth < 6; depth++) {
    const parent = node.parentElement;
    if (!parent || parent === document.body) break;
    const found = findLabelBefore(parent, node);
    if (found) return found;
    node = parent;
  }

  // 5. Fieldset legend
  const fieldset = el.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) return legend.textContent.trim();
  }

  // 6. Placeholder as last resort
  if (el.placeholder) return el.placeholder.trim();

  return el.name || el.id || '';
}

function getBestText(el) {
  const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  if (t && t.length < 80) return t;
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  if (el.title) return el.title.trim();
  if (el.value) return String(el.value).trim().substring(0, 60);
  return '';
}

const NAV_GENERIC = new Set(['dashboard', 'app', 'admin', 'home', 'index', 'portal', 'main', 'platform', 'overview']);

// Titles that indicate the page hasn't finished loading — don't use these
const LOADING_TITLES = new Set(['unavailable','loading','new tab','untitled','error','404','not found','(loading)','']);

function getNavDescription() {
  const title = document.title;
  const lc = (title || '').toLowerCase().trim();
  const titleIsValid = title && !LOADING_TITLES.has(lc);

  // Use title if it changed and is a meaningful, non-generic value
  if (titleIsValid && title !== lastPageTitle) {
    lastPageTitle = title;
    if (!NAV_GENERIC.has(lc) && !NAV_GENERIC.has(lc.split(/\s+/)[0])) {
      return `Go to ${title}`;
    }
  }
  if (titleIsValid) lastPageTitle = title;

  // Parse path for meaningful segments, skipping generic ones and bare IDs
  const parts = location.pathname.split('/').filter(Boolean);
  const meaningful = parts.filter(p => !NAV_GENERIC.has(p.toLowerCase()) && !/^\d+$/.test(p));
  const slug = meaningful.length > 0 ? meaningful[meaningful.length - 1]
             : parts.length > 0     ? parts[parts.length - 1]
             : '';

  if (slug && !NAV_GENERIC.has(slug.toLowerCase())) {
    const readable = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[-_]/g, ' ');
    return `Go to ${readable}`;
  }

  // Fall back to brand name from hostname (e.g. "maps.google.com" → "Go to Google Maps")
  const host = location.hostname.replace(/^www\./, '');
  const KNOWN_BRANDS = {
    'maps.google.com': 'Google Maps', 'docs.google.com': 'Google Docs',
    'drive.google.com': 'Google Drive', 'mail.google.com': 'Gmail',
    'calendar.google.com': 'Google Calendar', 'meet.google.com': 'Google Meet'
  };
  if (KNOWN_BRANDS[host]) return `Go to ${KNOWN_BRANDS[host]}`;

  const brand = host.split('.')[0];
  return `Go to ${titleIsValid ? title : (brand.charAt(0).toUpperCase() + brand.slice(1)) || location.hostname}`;
}

// ─── Context-aware search descriptions ───────────────────────────────────────

// Walk up the DOM from a focused element looking for nearby question text or a
// section heading. Used to produce descriptions like:
//   "Search for the Recipient who needs to sign this document"
// instead of just "Search using the 'Recipient' field".
function getFieldContext(el) {
  let question = null;
  let heading  = null;
  let node     = el;

  for (let depth = 0; depth < 7; depth++) {
    const parent = node.parentElement;
    if (!parent || parent === document.body) break;

    for (const child of parent.children) {
      if (child === node || child.contains(el)) continue;
      if (child.querySelector('input, select, textarea')) continue; // skip form containers

      const tag  = child.tagName.toUpperCase();
      const text = (child.innerText || child.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length < 4 || text.length > 200) continue;

      if (!heading && ['H2','H3','H4','H5','LEGEND'].includes(tag) && text.length < 80) {
        heading = text;
      }
      // Question: ends with "?" or ":" and is instructional
      if (!question && (text.endsWith('?') || text.endsWith(':')) && text.length > 8) {
        question = text;
      }
    }

    if (question && heading) break;
    node = parent;
  }
  return { question, heading };
}

function buildSearchDescription(el) {
  const fieldLabel = getLabel(el);
  const { question, heading } = getFieldContext(el);

  if (question) {
    const q  = question.replace(/[?:]$/, '').trim();
    const ql = q.toLowerCase();

    // "Who needs to sign this document?" + "Recipient"
    //   → 'Search for the "Recipient" who needs to sign this document'
    if (ql.startsWith('who ') && fieldLabel) {
      return `Search for the "${fieldLabel}" who ${q.slice(4).trim()}`;
    }

    // "What type of document do you want?"
    //   → "Search for the type of document you want"
    if (ql.startsWith('what ')) {
      const rest = q.slice(5).trim()
        .replace(/\bdo you want$/i, 'you want')
        .replace(/\bdo you need$/i, 'you need')
        .trim();
      return `Search for the ${rest}`;
    }

    // "Which option do you prefer?" → "Search for option you prefer"
    if (ql.startsWith('which ')) {
      return `Search for ${q.slice(6).trim()}`;
    }

    // Generic: include question as context alongside label
    if (fieldLabel && !ql.includes(fieldLabel.toLowerCase())) {
      return `Search "${fieldLabel}" — ${question}`;
    }
    return `Search — ${question}`;
  }

  // Fallback: heading + label, or label alone
  if (heading && fieldLabel) return `Search using the "${fieldLabel}" field in ${heading}`;
  return `Search using the "${fieldLabel || 'Search'}" field`;
}

// ─── Pre-capture on mousedown ────────────────────────────────────────────────
// mousedown fires BEFORE click and before any JS click handlers run.
// Humans hold the mouse 100–200ms between mousedown and mouseup, so by the
// time the click fires and opens a modal, the screenshot (taken ~20ms after
// mousedown) already shows the button in its pre-click state.

const CLICK_SELECTOR =
  'a, button, [role="button"], [role="menuitem"], [role="tab"], ' +
  '[role="option"], [role="listitem"], [role="treeitem"], ' +
  'input[type="submit"], input[type="button"], input[type="checkbox"], ' +
  'input[type="radio"], summary, label, li[data-value], li[data-id], ' +
  '.mapboxgl-marker, .maplibregl-marker, .leaflet-marker-icon, .leaflet-interactive';

// Returns true if the element is inside a map — clicks here show a popup AFTER
// the click, so we should NOT use the pre-capture (which shows the state before).
function isMapContext(el) {
  return !!(el.closest(
    '.mapboxgl-map, .mapboxgl-canvas-container, .mapboxgl-marker, ' +
    '.maplibregl-map, .maplibregl-marker, ' +
    '.leaflet-container, .leaflet-marker-icon, .leaflet-interactive'
  ));
}

// Finds the best click target. First tries CLICK_SELECTOR (standard elements),
// then falls back to any ancestor with cursor:pointer + visible text.
// This ensures custom-component UIs (e.g. Docuseal, React apps using <div>s)
// are captured even when they don't use semantic interactive elements.
function findClickTarget(target) {
  const el = target.closest(CLICK_SELECTOR);
  if (el) return el;
  // Fallback: walk up looking for cursor:pointer with readable text
  let node = target;
  for (let i = 0; i < 5; i++) {
    if (!node || node === document.body || node === document.documentElement) break;
    try {
      if (window.getComputedStyle(node).cursor === 'pointer') {
        const text = getBestText(node);
        if (text) return node;
      }
    } catch (_) {}
    node = node.parentElement;
  }
  return null;
}

document.addEventListener('mousedown', (e) => {
  if (!window.__trainDocIsRecording || document.hidden) return;
  if (!findClickTarget(e.target)) return;
  if (isMapContext(e.target)) return; // popup appears after click — skip pre-capture
  chrome.runtime.sendMessage({ type: 'PRE_CAPTURE' }).catch(() => {});
}, true);

// ─── Click detection ─────────────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  if (!window.__trainDocIsRecording) return;
  lastClickTime = Date.now();
  const el = findClickTarget(e.target);
  if (!el) return;
  const text = getBestText(el);
  if (!text) return;

  const role = el.getAttribute('role') || '';
  const tag  = el.tagName.toUpperCase();
  let description;
  if (tag === 'A')                 description = `Click "${text}"`;
  else if (role === 'tab')         description = `Click the "${text}" tab`;
  else if (role === 'option')      description = `Select "${text}"`;
  else if (role === 'menuitem')    description = `Click "${text}"`;
  else if (role === 'treeitem')    description = `Expand "${text}"`;
  else if (role === 'listitem')    description = `Select "${text}"`;
  else if (tag === 'SUMMARY')      description = `Expand the "${text}" section`;
  else if (el.type === 'checkbox') description = el.checked ? `Enable "${getLabel(el) || text}"` : `Disable "${getLabel(el) || text}"`;
  else if (el.type === 'radio')    description = `Select "${getLabel(el) || text}"`;
  else                             description = `Click "${text}"`;

  // Map elements: capture AFTER click so the popup is visible in the screenshot.
  // Everything else: use the pre-capture (mousedown) to show the pre-click UI state.
  const onMap = isMapContext(el);
  sendStep(description, tag, { usePrecapture: !onMap });
}, true);

// ─── Form fields ─────────────────────────────────────────────────────────────

document.addEventListener('change', (e) => {
  if (!window.__trainDocIsRecording) return;
  const el = e.target;
  if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
  if (el.type === 'checkbox' || el.type === 'radio') return;
  const label = getLabel(el) || el.tagName.toLowerCase();
  let description;
  if (el.tagName === 'SELECT') {
    const opt = el.options[el.selectedIndex];
    description = `Select "${opt ? opt.text : el.value}" from the "${label}" dropdown`;
  } else if (el.type === 'file') {
    description = `Upload a file using the "${label}" field`;
  } else {
    description = `Fill in the "${label}" field`;
  }
  sendStep(description, el.tagName);
}, true);

// ─── Search / combobox ────────────────────────────────────────────────────────

document.addEventListener('focus', (e) => {
  if (!window.__trainDocIsRecording || document.hidden) return;
  const el = e.target;
  const role = el.getAttribute('role') || '';
  const ph = (el.placeholder || el.getAttribute('aria-label') || '').toLowerCase();
  const isSearch = el.type === 'search' || role === 'combobox' || role === 'searchbox' ||
    ph.includes('search') || ph.includes('type and select') || ph.includes('filter');
  if (!isSearch) return;
  sendStep(buildSearchDescription(el), 'search');
}, true);

// ─── Dropdown open ───────────────────────────────────────────────────────────

const dropdownObserver = new MutationObserver((mutations) => {
  if (!window.__trainDocIsRecording || document.hidden) return;
  for (const mut of mutations) {
    if (mut.type !== 'attributes' || mut.attributeName !== 'aria-expanded') continue;
    const el = mut.target;
    if (el.getAttribute('aria-expanded') !== 'true') continue;
    const label = getBestText(el) || el.getAttribute('aria-label') || '';
    if (!label || label.length > 80) continue;
    const now = Date.now();
    if (label === lastDropdownLabel && now - lastDropdownTime < 3000) continue;
    lastDropdownLabel = label;
    lastDropdownTime = now;
    setTimeout(() => sendStep(`Open the "${label}" dropdown`, 'dropdown'), 150);
  }
});

function attachObserver() {
  if (!document.body) return;
  dropdownObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-expanded'] });
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', attachObserver) : attachObserver();

// ─── Toast / success notification capture ────────────────────────────────────
// Toasts disappear in 2–3s, so we bypass the capture queue entirely and fire
// an immediate screenshot the moment one appears in the DOM.

let lastToastText = '';
let lastToastTime = 0;

const toastObserver = new MutationObserver((mutations) => {
  if (!window.__trainDocIsRecording || document.hidden) return;

  for (const mut of mutations) {
    for (const added of mut.addedNodes) {
      if (added.nodeType !== Node.ELEMENT_NODE) continue;

      // Primary signal: explicit alert roles / live regions
      const hasAlertRole  = added.getAttribute('role') === 'alert' ||
                            added.getAttribute('aria-live') === 'assertive';
      const childAlert    = added.querySelector('[role="alert"],[aria-live="assertive"]');

      // Secondary signal: toast / snackbar CSS class names
      const cls = (added.className || '').toString().toLowerCase();
      const hasToastClass = ['toast','snackbar','notification','flash-message','flash','banner','alertdialog']
                              .some(c => cls.includes(c));

      if (!hasAlertRole && !childAlert && !hasToastClass) continue;

      // Extract text from the best candidate element
      const src  = childAlert || added;
      const text = (src.innerText || src.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length < 3 || text.length > 400) continue;

      // Debounce identical toasts
      const now = Date.now();
      if (text === lastToastText && now - lastToastTime < 5000) continue;
      lastToastText = text;
      lastToastTime = now;

      // Classify tone — only flag errors/warnings; don't add "Success:" to routine toasts
      const lc = text.toLowerCase();
      const isError = lc.includes('error') || lc.includes('fail') || lc.includes('invalid');
      const isWarn  = lc.includes('warn');
      const description = isError ? `Error: "${text.substring(0, 120)}"`
                        : isWarn  ? `Warning: "${text.substring(0, 120)}"`
                        : `"${text.substring(0, 120)}"`;

      // Send TOAST_CAPTURE — handled outside the queue in background.js
      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: 'TOAST_CAPTURE',
          description,
          url: location.href,
          pageTitle: document.title
        }).catch(() => {});
      }, 150); // small pause so the toast finishes rendering before screenshot
    }
  }
});

function attachToastObserver() {
  if (!document.body) return;
  toastObserver.observe(document.body, { childList: true, subtree: true });
}
document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', attachToastObserver)
  : attachToastObserver();

// ─── Navigation ───────────────────────────────────────────────────────────────

let lastUrl = location.href;
let lastNavStepHref = '';

function checkNavigation() {
  if (!window.__trainDocIsRecording || document.hidden) return;
  if (location.href === lastUrl) return;

  const prevHref = lastUrl;
  lastUrl = location.href;

  // Suppress if path didn't change — it's a SPA UI update (modal opened, filter
  // applied, hash changed) rather than a real page navigation.
  // Exception: if no click happened recently, it might be a programmatic nav.
  try {
    const prev = new URL(prevHref);
    const curr = new URL(location.href);
    if (prev.pathname === curr.pathname) {
      if (Date.now() - lastClickTime < 4000) return; // SPA state update after click → skip
      // Check for meaningful query state change (e.g. filter changed)
      const prevP = new URLSearchParams(prev.search);
      const currP = new URLSearchParams(curr.search);
      const STATE_KEYS = ['status', 'filter', 'view', 'tab', 'type', 'section', 'page', 'q'];
      const changed = STATE_KEYS.some(k => prevP.get(k) !== currP.get(k));
      if (!changed) return; // Nothing meaningful changed
    }
  } catch {}

  // Don't repeat a nav step for the same URL twice
  if (location.href === lastNavStepHref) return;
  lastNavStepHref = location.href;

  setTimeout(() => sendStep(getNavDescription(), 'navigation'), 300);
}
if (!history.__trainDocPatched) {
  history.__trainDocPatched = true;
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = (...a) => { _push(...a);    setTimeout(checkNavigation, 200); };
  history.replaceState = (...a) => { _replace(...a); setTimeout(checkNavigation, 200); };
}
window.addEventListener('popstate',   () => setTimeout(checkNavigation, 200));
window.addEventListener('hashchange', () => setTimeout(checkNavigation, 200));
setInterval(checkNavigation, 1500);

// ─── State sync ───────────────────────────────────────────────────────────────

chrome.storage.local.get('isRecording', (d) => {
  window.__trainDocIsRecording = !!d.isRecording;
  if (window.__trainDocIsRecording) lastPageTitle = document.title;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.isRecording !== undefined) {
    window.__trainDocIsRecording = !!changes.isRecording.newValue;
    if (window.__trainDocIsRecording) lastPageTitle = document.title;
  }
});

} // end guard

// TrainDoc background service worker v17

let captureQueue = Promise.resolve();
const MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB safety limit (unlimitedStorage permission required)

// Pre-capture: screenshot taken at mousedown (before click handlers run).
let preCapture = null;          // { screenshot, timestamp }
let preCapturePromise = null;   // Promise<void> for the in-flight capture

// Single report tab — focus it instead of opening new tabs.
let reportTabId = null;

// reportTabId is also persisted to storage so it survives service worker sleep/restart.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === reportTabId) {
    reportTabId = null;
    chrome.storage.local.remove('reportTabId');
  } else {
    // In case the worker restarted and in-memory is stale, check storage too
    chrome.storage.local.get('reportTabId', (d) => {
      if (d.reportTabId === tabId) chrome.storage.local.remove('reportTabId');
    });
  }
});

function openOrFocusReport() {
  // Always read from storage — in-memory may be gone after worker sleep
  chrome.storage.local.get('reportTabId', ({ reportTabId: storedId }) => {
    const tabId = reportTabId || storedId || null;
    if (tabId) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          reportTabId = null;
          chrome.storage.local.remove('reportTabId');
          createReportTab();
        } else {
          chrome.tabs.update(tabId, { active: true });
          chrome.windows.update(tab.windowId, { focused: true });
        }
      });
    } else {
      createReportTab();
    }
  });
}

function createReportTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html') }, (tab) => {
    reportTabId = tab.id;
    chrome.storage.local.set({ reportTabId: tab.id });
  });
}

// Re-inject when user switches tabs; auto-insert a section when domain changes
chrome.tabs.onActivated.addListener(async (info) => {
  const [storeData, tab] = await Promise.all([
    new Promise(res => chrome.storage.local.get(['isRecording', 'lastTabDomain', 'steps'], res)),
    chrome.tabs.get(info.tabId).catch(() => null)
  ]);
  if (!storeData.isRecording) return;
  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  let newDomain = '';
  try { newDomain = new URL(tab.url).hostname; } catch (_) {}
  if (!newDomain) return;

  const prevDomain = storeData.lastTabDomain || '';
  const steps = storeData.steps || [];

  if (newDomain !== prevDomain && prevDomain && steps.length > 0) {
    // Domain changed while recording → auto-insert a section
    const rawTitle = tab.title || newDomain;
    // Strip common site-name suffixes: "Page Title - Site Name" or "Page | Site"
    const sectionName = rawTitle
      .replace(/\s*[-–—]\s*[^-–—|]{0,40}$/, '')
      .replace(/\s*\|\s*[^|]{0,40}$/, '')
      .trim() || newDomain;

    const newSteps = [...steps, {
      stepNumber: steps.length + 1,
      isSection: true,
      isTabSwitch: true,
      description: sectionName,
      url: tab.url,
      pageTitle: tab.title || '',
      screenshot: null,
      timestamp: Date.now()
    }];
    chrome.storage.local.set({ steps: newSteps, lastTabDomain: newDomain }, broadcastUpdate);
    // Capture the initial view of the newly-activated tab (1200ms delay — page may still loading)
    captureTabView(tab, sectionName, 1200);
  } else {
    if (newDomain) chrome.storage.local.set({ lastTabDomain: newDomain });
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: info.tabId, allFrames: true }, files: ['content.js'] });
  } catch (_) {}
});

// Re-inject when any tab finishes loading; also detect new-tab domain switches
// (covers the case where "Get Directions" opens Google Maps in a new tab —
//  onActivated fires while the tab is still blank, so we catch it here instead)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const data = await new Promise(res => chrome.storage.local.get(['isRecording', 'lastTabDomain', 'steps'], res));
  if (!data.isRecording) return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  // Re-inject content script
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (_) {}

  // Check if this newly-loaded tab is the active tab and represents a domain switch
  let newDomain = '';
  try { newDomain = new URL(tab.url).hostname; } catch (_) {}
  if (!newDomain) return;

  const prevDomain = data.lastTabDomain || '';
  const steps = data.steps || [];
  if (!prevDomain || newDomain === prevDomain || steps.length === 0) {
    if (newDomain !== prevDomain && newDomain) chrome.storage.local.set({ lastTabDomain: newDomain });
    return;
  }

  // Only insert a section if this tab is currently active
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]) ?? [null];
  if (!activeTab || activeTab.id !== tabId) return;

  // Avoid inserting a duplicate section (onActivated may have already done it)
  const lastStep = steps[steps.length - 1];
  const alreadyHasSection = lastStep?.isTabSwitch &&
    (() => { try { return new URL(lastStep.url || '').hostname === newDomain; } catch(_) { return false; } })();
  if (alreadyHasSection) return;

  const rawTitle = tab.title || getPageNameFromUrl(tab.url) || newDomain;
  const sectionName = rawTitle
    .replace(/\s*[-–—]\s*[^-–—|]{0,40}$/, '')
    .replace(/\s*\|\s*[^|]{0,40}$/, '')
    .trim() || getPageNameFromUrl(tab.url) || newDomain;

  const newSteps = [...steps, {
    stepNumber: steps.length + 1,
    isSection: true,
    isTabSwitch: true,
    description: sectionName,
    url: tab.url,
    pageTitle: tab.title || '',
    screenshot: null,
    timestamp: Date.now()
  }];
  chrome.storage.local.set({ steps: newSteps, lastTabDomain: newDomain }, broadcastUpdate);
  // Page is fully loaded (status='complete'), capture initial view quickly
  captureTabView(tab, sectionName, 400);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Start recording ──────────────────────────────────────────────────────
  if (msg.type === 'START_RECORDING') {
    // New recording → clear any existing report tab reference and tab-domain tracker
    reportTabId = null;
    chrome.storage.local.remove('reportTabId');
    chrome.storage.local.set({ isRecording: true, isPaused: false, steps: [], logoUrl: null, lastTabDomain: '', suggestedTitle: '', guideDescription: '' }, async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let screenshot = null;
      let logoUrl = null;

      if (activeTab && !activeTab.url.startsWith('chrome://')) {
        // Try apple-touch-icon first, then fallback to favIconUrl
        try {
          const result = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => {
              const selectors = [
                "link[rel='apple-touch-icon']",
                "link[rel='apple-touch-icon-precomposed']",
                "link[rel='icon'][sizes='192x192']",
                "link[rel='icon'][sizes='128x128']",
                "link[rel='shortcut icon']",
                "link[rel='icon']"
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el?.href) return el.href;
              }
              return null;
            }
          });
          logoUrl = result?.[0]?.result || activeTab.favIconUrl || null;
        } catch (_) { logoUrl = activeTab.favIconUrl || null; }

        try {
          await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: true }, files: ['content.js'] });
          await sleep(400);
          screenshot = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'jpeg', quality: 95 });
        } catch (e) { console.warn('TrainDoc initial screenshot failed:', e.message); }
      }

      let initialDomain = '';
      try { initialDomain = new URL(activeTab?.url || '').hostname; } catch (_) {}

      const pageTitle = activeTab?.title || '';
      // Auto-insert a section before the first step so the Quick Reference has a header
      const sectionName = pageTitle.replace(/\s*[-|–—].*$/, '').trim() || 'Getting Started';
      const now = Date.now();

      const sectionStep = {
        stepNumber: 1,
        isSection: true,
        description: sectionName,
        url: activeTab?.url || '',
        pageTitle,
        screenshot: null,
        timestamp: now - 1
      };
      const pageloadStep = {
        stepNumber: 2,
        description: `Open ${pageTitle || 'Page'}`,
        elementType: 'pageload',
        url: activeTab?.url || '',
        pageTitle,
        screenshot,
        timestamp: now
      };
      await new Promise(res => chrome.storage.local.set({ steps: [sectionStep, pageloadStep], logoUrl, lastTabDomain: initialDomain }, res));
      broadcastUpdate();
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Pause recording (keeps steps, no report) ─────────────────────────────
  if (msg.type === 'PAUSE_RECORDING') {
    chrome.storage.local.set({ isRecording: false, isPaused: true }, () => {
      broadcastUpdate();
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Resume recording (re-inject content script, append to existing steps) ─
  if (msg.type === 'RESUME_RECORDING') {
    chrome.storage.local.get(['isPaused', 'steps'], async (data) => {
      if (!data.isPaused) { sendResponse({ ok: false }); return; }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && !activeTab.url.startsWith('chrome://') && !activeTab.url.startsWith('chrome-extension://')) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: true }, files: ['content.js'] });
        } catch (_) {}
      }
      chrome.storage.local.set({ isRecording: true, isPaused: false }, () => {
        broadcastUpdate();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // ── Open or focus the single report tab ─────────────────────────────────
  if (msg.type === 'OPEN_REPORT') {
    openOrFocusReport();
    sendResponse({ ok: true });
    return true;
  }

  // ── Stop recording (generate title + description, focus report) ─────────
  if (msg.type === 'STOP_RECORDING') {
    chrome.storage.local.get('steps', (data) => {
      const steps = data.steps || [];
      const suggestedTitle = generateTitle(steps);
      const guideDescription = generateDescription(steps, suggestedTitle);
      chrome.storage.local.set({ isRecording: false, isPaused: false, suggestedTitle, guideDescription }, () => {
        broadcastUpdate();
        openOrFocusReport();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // ── Toast capture (bypasses queue — toasts disappear in 2–3s) ───────────
  if (msg.type === 'TOAST_CAPTURE') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: true }); return; }
    chrome.storage.local.get('isRecording', async (d) => {
      if (!d.isRecording) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 });

        // Read freshest state just before writing
        const stored = await new Promise(res => chrome.storage.local.get(['steps', 'isRecording'], res));
        if (!stored.isRecording) return;
        const steps = stored.steps || [];

        // Skip if identical to last screenshot
        if (screenshot && steps.length > 0 && steps[steps.length - 1].screenshot === screenshot) return;

        let description = msg.description;
        const dupeCount = steps.filter(s => s.description === description).length;
        if (dupeCount > 0) description += ` (${dupeCount + 1})`;

        chrome.storage.local.set({
          steps: [...steps, {
            stepNumber:  steps.length + 1,
            description,
            elementType: 'toast',
            url:         msg.url || '',
            pageTitle:   msg.pageTitle || '',
            screenshot,
            timestamp:   Date.now()
          }]
        }, broadcastUpdate);
      } catch (e) { console.warn('TrainDoc toast capture failed:', e.message); }
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Pre-capture (mousedown) ──────────────────────────────────────────────
  if (msg.type === 'PRE_CAPTURE') {
    chrome.storage.local.get('isRecording', (data) => {
      if (!data.isRecording) { sendResponse({ ok: false }); return; }
      chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
        if (!activeTab) { sendResponse({ ok: false }); return; }
        preCapturePromise = chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'jpeg', quality: 95 })
          .then(screenshot => {
            preCapture = { screenshot, timestamp: Date.now() };
            preCapturePromise = null;
          })
          .catch(() => { preCapturePromise = null; });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // ── Manual capture ───────────────────────────────────────────────────────
  if (msg.type === 'MANUAL_CAPTURE') {
    chrome.storage.local.get(['isRecording'], async (data) => {
      if (!data.isRecording) { sendResponse({ ok: false, reason: 'not recording' }); return; }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) { sendResponse({ ok: false }); return; }
      captureQueue = captureQueue.then(() => captureStep(activeTab.id, {
        description: msg.description || 'Manual capture',
        elementType: 'manual',
        url: activeTab.url,
        pageTitle: activeTab.title
      }, 0));
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Auto capture step ────────────────────────────────────────────────────
  if (msg.type === 'CAPTURE_STEP') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return; }

    // Compute delay SYNCHRONOUSLY before any async work so queue entries are
    // added in message-arrival order, preventing out-of-order screenshots.
    const delay = msg.usePrecapture ? 0
      : (msg.elementType === 'navigation' || msg.elementType === 'submit') ? 2500
      : 600;

    captureQueue = captureQueue.then(async () => {
      const activeTabs = await new Promise(res => chrome.tabs.query({ active: true }, res));
      if (!activeTabs.some(t => t.id === tabId)) return;
      const stored = await new Promise(res => chrome.storage.local.get('isRecording', res));
      if (!stored.isRecording) return;
      await captureStep(tabId, msg, delay);
    });

    sendResponse({ ok: true });
    return true;
  }

});

// ─── Screenshot capture ───────────────────────────────────────────────────────

// Generic URL path segments that don't add useful context to descriptions
const GENERIC_SLUGS = new Set(['dashboard', 'app', 'admin', 'home', 'index', 'portal', 'main', 'platform', 'overview']);

async function captureStep(tabId, msg, delay = 600) {
  let screenshot = null;

  if (msg.usePrecapture) {
    // Wait for in-flight mousedown screenshot to resolve, then use it
    if (preCapturePromise) {
      try { await preCapturePromise; } catch {}
      preCapturePromise = null;
    }
    if (preCapture && Date.now() - preCapture.timestamp < 2000) {
      screenshot = preCapture.screenshot;
      preCapture = null;
    }
  }

  if (!screenshot) {
    if (delay > 0) await sleep(delay);
    try {
      const tab = await chrome.tabs.get(tabId);
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 });
    } catch (e) { console.warn('TrainDoc screenshot skipped:', e.message); }
  }

  const stored = await new Promise(res => chrome.storage.local.get(['steps', 'isRecording'], res));
  if (!stored.isRecording) return;

  // Storage safety: skip screenshot if near limit
  if (JSON.stringify(stored).length > MAX_STORAGE_BYTES) {
    console.warn('TrainDoc: storage near limit, skipping screenshot for this step');
    screenshot = null;
  }

  const steps = stored.steps || [];

  // Skip if screenshot is pixel-identical to the previous step (page unchanged)
  if (screenshot && steps.length > 0) {
    const prev = steps[steps.length - 1];
    if (prev.screenshot && prev.screenshot === screenshot) {
      console.log('TrainDoc: skipping duplicate step (screenshot identical to previous)');
      return;
    }
  }

  // Make description unique if it already appears in the step list
  let description = msg.description;
  const dupeCount = steps.filter(s => s.description === description).length;
  if (dupeCount > 0) {
    try {
      const urlObj = new URL(msg.url || '');
      const pathParts = urlObj.pathname.split('/').filter(p =>
        p && !GENERIC_SLUGS.has(p.toLowerCase()) && !/^\d+$/.test(p)
      );
      if (pathParts.length > 0) {
        const suffix = pathParts[pathParts.length - 1].replace(/[-_]/g, ' ');
        description += ` — ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}`;
      } else {
        description += ` (${dupeCount + 1})`;
      }
    } catch {
      description += ` (${dupeCount + 1})`;
    }
  }

  chrome.storage.local.set({
    steps: [...steps, {
      stepNumber:  steps.length + 1,
      description,
      elementType: msg.elementType || '',
      url:         msg.url || '',
      pageTitle:   msg.pageTitle || '',
      screenshot,
      timestamp:   Date.now()
    }]
  }, broadcastUpdate);
}

function broadcastUpdate() { chrome.runtime.sendMessage({ type: 'STATE_UPDATE' }).catch(() => {}); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Capture the initial view of a newly-activated tab and append it as a pageload step.
// delay: how long to wait before taking the screenshot (let the page settle).
async function captureTabView(tab, sectionName, delay) {
  await sleep(delay);
  try {
    // Verify the tab is still active before capturing
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]) ?? [null];
    if (!active || active.id !== tab.id) return;

    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 });
    const freshData  = await new Promise(res => chrome.storage.local.get(['steps', 'isRecording'], res));
    if (!freshData.isRecording) return;

    const steps = freshData.steps || [];
    // Skip if screenshot is identical to the last step (prevents duplication when both
    // onActivated and onUpdated fire for the same tab switch)
    if (screenshot && steps.length > 0 && steps[steps.length - 1].screenshot === screenshot) return;

    const title = sectionName || tab.title || '';
    chrome.storage.local.set({
      steps: [...steps, {
        stepNumber:  steps.length + 1,
        description: `Open ${title}`,
        elementType: 'pageload',
        url:         tab.url || '',
        pageTitle:   tab.title || '',
        screenshot,
        timestamp:   Date.now()
      }]
    }, broadcastUpdate);
  } catch (e) { console.warn('TrainDoc tab-view capture failed:', e.message); }
}

// ─── Suggested document title ─────────────────────────────────────────────────

// Returns a human-readable name from a URL (for tab titles, section names, etc.)
function getPageNameFromUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    const known = {
      'maps.google.com': 'Google Maps',
      'docs.google.com': 'Google Docs',
      'drive.google.com': 'Google Drive',
      'sheets.google.com': 'Google Sheets',
      'slides.google.com': 'Google Slides',
      'mail.google.com': 'Gmail',
      'calendar.google.com': 'Google Calendar',
      'meet.google.com': 'Google Meet',
      'forms.google.com': 'Google Forms',
    };
    if (known[h]) return known[h];
    if (h === 'google.com' && u.pathname.startsWith('/maps')) return 'Google Maps';
    // Capitalize the brand name from the hostname
    const brand = h.split('.')[0];
    return brand.charAt(0).toUpperCase() + brand.slice(1);
  } catch(_) { return ''; }
}

function generateTitle(steps) {
  // content.js always uses straight ASCII quotes in descriptions
  const GENERIC_ACTIONS = new Set(['ok','cancel','close','save','submit','yes','no','next','back','continue','done','apply']);

  // Phase 1: Detect form fill groups — look at ALL fill-in steps across the recording
  const fillFields = steps
    .filter(s => !s.isSection && !s.isNote)
    .map(s => {
      const m = (s.description || '').match(/^Fill in the "(.+?)" field$/);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  if (fillFields.length >= 2) {
    const lower = fillFields.map(f => f.toLowerCase());
    const hasEmail    = lower.some(f => /email|e-mail|username|user.?name|user.?id/i.test(f));
    const hasPassword = lower.some(f => /password|passwd|pass.?word/i.test(f));
    if (hasEmail && hasPassword) return 'How to Log In';
    if (fillFields.length === 2) {
      return `How to Fill In the ${toTitleCase(fillFields[0])} and ${toTitleCase(fillFields[1])} Fields`;
    }
    // 3+ fields: list first three
    const listed = fillFields.slice(0, 3).map(f => toTitleCase(f)).join(', ');
    return `How to Fill Out the Form (${listed})`;
  }

  // Phase 2: Look for first meaningful click, select, or navigation action
  for (const step of steps) {
    const desc = step.description || '';

    // 'Click "Foo Bar"' — use as title if text is a short, actionable label
    if (desc.startsWith('Click ')) {
      const m = desc.match(/^Click\s+"(.+?)"/);
      if (m) {
        const action = m[1].trim();
        if (action.length <= 40 && !GENERIC_ACTIONS.has(action.toLowerCase())) {
          return `How to ${toTitleCase(action)}`;
        }
      }
    }

    // 'Select "Foo"' from dropdown — only short UI-level options
    if (desc.startsWith('Select ')) {
      const m = desc.match(/^Select\s+"(.+?)"/);
      if (m) {
        const action = m[1].trim();
        if (action.length > 3 && action.length <= 28 && !GENERIC_ACTIONS.has(action.toLowerCase())) {
          return `How to Select ${toTitleCase(action)}`;
        }
      }
    }

    // 'Go to Foo' navigation — use page name as guide subject
    if (desc.startsWith('Go to ') && step.elementType === 'navigation') {
      const raw = desc.slice(6).replace(/\s*[-|–—].*$/, '').trim();
      if (raw.length > 3 && raw.length <= 40) {
        return `How to Use ${toTitleCase(raw)}`;
      }
    }
  }

  // Phase 3: Single form fill (lower priority than clicks)
  if (fillFields.length === 1) {
    const f = fillFields[0];
    const lf = f.toLowerCase();
    if (/email|username/.test(lf)) return 'How to Log In';
    if (f.length > 2 && f.length <= 30) return `How to Fill In the ${toTitleCase(f)} Field`;
  }

  // Phase 4: Use the first nav/pageload title, stripped of site suffix
  const navStep = steps.find(s => s.pageTitle && (s.elementType === 'pageload' || s.elementType === 'navigation'));
  if (navStep?.pageTitle) {
    const cleaned = navStep.pageTitle
      .replace(/\s*[-|–—].*$/, '')
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim();
    if (cleaned.length > 3 && cleaned.length <= 45) {
      return `How to Use ${toTitleCase(cleaned)}`;
    }
  }

  // Last resort: URL brand name
  const urlStep = steps.find(s => s.url);
  if (urlStep?.url) {
    const name = getPageNameFromUrl(urlStep.url);
    if (name.length > 2) return `How to Use ${name}`;
  }

  return 'How to: [click to name this guide]';
}

// ─── Auto-generated cover page description ────────────────────────────────────

function generateDescription(steps, title) {
  const sections    = steps.filter(s => s.isSection && s.description);
  const actionSteps = steps.filter(s => !s.isSection && !s.isNote);
  const sectionNames = [...new Set(sections.map(s => s.description).filter(Boolean))];

  // Determine primary app/site name from the first non-section step URL
  const urlStep = steps.find(s => s.url && !s.isSection && !s.isNote);
  let appName = '';
  if (urlStep?.url) {
    try {
      const h = new URL(urlStep.url).hostname.replace(/^www\./, '');
      const known = {
        'maps.google.com': 'Google Maps', 'docs.google.com': 'Google Docs',
        'drive.google.com': 'Google Drive', 'mail.google.com': 'Gmail',
        'calendar.google.com': 'Google Calendar', 'meet.google.com': 'Google Meet',
      };
      appName = known[h] || (h.split('.')[0].charAt(0).toUpperCase() + h.split('.')[0].slice(1));
    } catch(_) {}
  }

  const hasTitle = title && title !== 'How to: [click to name this guide]';

  // Opening sentence: what the guide covers
  let desc = hasTitle
    ? `This guide walks through ${title.replace(/^How to /i, '').toLowerCase()}.`
    : appName
      ? `This guide walks through a workflow in ${appName}.`
      : 'This guide covers the following workflow.';

  // Step and section summary
  desc += ` It includes ${actionSteps.length} step${actionSteps.length !== 1 ? 's' : ''}`;
  if (sectionNames.length > 1) {
    const listed = sectionNames.length <= 3
      ? sectionNames.join(', ')
      : sectionNames.slice(0, 3).join(', ') + `, and ${sectionNames.length - 3} more`;
    desc += ` across ${sectionNames.length} sections: ${listed}.`;
  } else if (sectionNames.length === 1) {
    desc += ` in the "${sectionNames[0]}" section.`;
  } else {
    desc += '.';
  }

  return desc;
}

function toTitleCase(str) {
  const minors = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as','is']);
  return str.replace(/\w+/g, (w, i) =>
    (i === 0 || !minors.has(w.toLowerCase())) ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()
  );
}

// TrainDoc popup — 3 states: idle | recording | paused

document.getElementById('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;

const btnStart   = document.getElementById('btnStart');
const btnResume  = document.getElementById('btnResume');
const btnPause   = document.getElementById('btnPause');
const btnStop    = document.getElementById('btnStop');
const btnCapture = document.getElementById('btnCapture');
const btnReport  = document.getElementById('btnReport');
const statusDot  = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const stepCount  = document.getElementById('stepCount');
const lastStep   = document.getElementById('lastStep');
const lastStepTx = document.getElementById('lastStepText');
const pauseHint  = document.getElementById('pauseHint');

function show(el) { el.style.display = 'block'; }
function hide(el) { el.style.display = 'none'; }

function refreshUI(data) {
  const recording = data.isRecording || false;
  const paused    = data.isPaused    || false;
  const steps     = data.steps       || [];

  // Status dot
  statusDot.classList.toggle('recording', recording);
  statusDot.classList.toggle('paused',    paused && !recording);

  statusText.textContent = recording ? 'Recording…'
    : paused ? `Paused — ${steps.length} step${steps.length !== 1 ? 's' : ''} captured`
    : (steps.length > 0 ? 'View previous report or start new' : 'Ready to record');

  // Only show live step count during an active/paused session
  stepCount.textContent = (recording || paused) ? steps.length : 0;

  // Buttons — show only what's relevant to current state
  recording ? hide(btnStart)   : show(btnStart);   btnStart.style.display  = (!recording && !paused) ? 'block' : 'none';
  btnResume.style.display  = paused  ? 'block' : 'none';
  btnPause.style.display   = recording ? 'block' : 'none';
  btnStop.style.display    = (recording || paused) ? 'block' : 'none';
  btnCapture.style.display = recording ? 'block' : 'none';
  btnReport.style.display  = (paused || (!recording && !paused && steps.length > 0)) ? 'block' : 'none';
  pauseHint.style.display  = paused ? 'block' : 'none';

  // Last step
  if (steps.length > 0) {
    lastStep.classList.add('visible');
    lastStepTx.textContent = steps[steps.length - 1].description || '—';
  } else {
    lastStep.classList.remove('visible');
  }
}

chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], refreshUI);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], refreshUI);
  }
});

setInterval(() => chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], refreshUI), 1200);

// ── Button handlers ────────────────────────────────────────────────────────

btnStart.addEventListener('click', () => {
  btnStart.disabled = true;
  chrome.runtime.sendMessage({ type: 'START_RECORDING' }, () => {
    chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], refreshUI);
  });
});

btnResume.addEventListener('click', () => {
  btnResume.disabled = true;
  chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' }, () => {
    chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], (d) => {
      btnResume.disabled = false;
      refreshUI(d);
    });
  });
});

btnPause.addEventListener('click', () => {
  btnPause.disabled = true;
  chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' }, () => {
    chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], (d) => {
      btnPause.disabled = false;
      refreshUI(d);
    });
  });
});

btnStop.addEventListener('click', () => {
  btnStop.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, () => {
    chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], refreshUI);
  });
});

btnCapture.addEventListener('click', () => {
  btnCapture.textContent = '⏳ Capturing…';
  btnCapture.disabled = true;
  chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE', description: 'Manual capture' }, () => {
    setTimeout(() => {
      btnCapture.textContent = '📸 Capture step now';
      btnCapture.disabled = false;
      chrome.storage.local.get(['isRecording', 'isPaused', 'steps'], refreshUI);
    }, 1000);
  });
});

btnReport.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_REPORT' });
});

const DEFAULT_DOMAINS = [
  'youtube.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'tiktok.com',
  'reddit.com'
];

function parseDomains(rawValue) {
  return rawValue
    .split(/\r?\n|,/) // allow newline or comma separation
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain, index, list) => domain && list.indexOf(domain) === index);
}

function formatDomains(domains) {
  return (domains || []).join('\n');
}

function showStatus(message) {
  const statusEl = document.getElementById('status');
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  if (message) {
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2500);
  }
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const resolved = settings || {
    dailyGoal: 2,
    overrideMinutes: 15,
    gatedDomains: DEFAULT_DOMAINS
  };

  document.getElementById('daily-goal').value = resolved.dailyGoal || 2;
  document.getElementById('override-minutes').value = resolved.overrideMinutes || 15;
  document.getElementById('gated-domains').value = formatDomains(resolved.gatedDomains && resolved.gatedDomains.length ? resolved.gatedDomains : DEFAULT_DOMAINS);
}

async function saveSettings(event) {
  event.preventDefault();

  const dailyGoalInput = document.getElementById('daily-goal');
  const overrideInput = document.getElementById('override-minutes');
  const domainsInput = document.getElementById('gated-domains');

  const dailyGoal = Math.max(parseInt(dailyGoalInput.value, 10) || 1, 1);
  const overrideMinutes = Math.max(parseInt(overrideInput.value, 10) || 1, 1);
  const gatedDomains = parseDomains(domainsInput.value);

  const payload = {
    dailyGoal,
    overrideMinutes,
    gatedDomains: gatedDomains.length ? gatedDomains : DEFAULT_DOMAINS
  };

  await chrome.storage.local.set({ settings: payload });
  showStatus('Settings saved.');
}

async function resetToday() {
  const resetButton = document.getElementById('reset-progress');
  resetButton.disabled = true;
  showStatus('Resetting…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'leetgate:reset-progress' });
    if (response && response.success) {
      showStatus('Today\'s progress reset.');
    } else {
      showStatus('Unable to reset. Try again.');
    }
  } catch (error) {
    console.warn('LeetGate: reset failed', error);
    showStatus('Unable to reset.');
  } finally {
    resetButton.disabled = false;
  }
}

function init() {
  const form = document.getElementById('settings-form');
  form.addEventListener('submit', saveSettings);
  document.getElementById('reset-progress').addEventListener('click', resetToday);
  loadSettings();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

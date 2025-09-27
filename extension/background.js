const DAILY_GOAL_DEFAULT = 2;
const OVERRIDE_MINUTES_DEFAULT = 15;
const DEFAULT_GATED_DOMAINS = [
  "youtube.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "tiktok.com",
  "reddit.com",
];

let cachedProblems = null;
const temporaryBypassTabs = new Map();

async function loadProblems() {
  if (cachedProblems) {
    return cachedProblems;
  }
  try {
    const response = await fetch(chrome.runtime.getURL("data/neet150.json"));
    cachedProblems = await response.json();
  } catch (error) {
    console.error("LeetGate: failed to load problem data", error);
    cachedProblems = [];
  }
  return cachedProblems;
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings) {
    return {
      dailyGoal: settings.dailyGoal ?? DAILY_GOAL_DEFAULT,
      overrideMinutes: settings.overrideMinutes ?? OVERRIDE_MINUTES_DEFAULT,
      gatedDomains:
        Array.isArray(settings.gatedDomains) && settings.gatedDomains.length
          ? settings.gatedDomains
          : [...DEFAULT_GATED_DOMAINS],
    };
  }
  const defaults = {
    dailyGoal: DAILY_GOAL_DEFAULT,
    overrideMinutes: OVERRIDE_MINUTES_DEFAULT,
    gatedDomains: [...DEFAULT_GATED_DOMAINS],
  };
  await chrome.storage.local.set({ settings: defaults });
  return defaults;
}

async function ensureTodayProgress() {
  const today = getTodayKey();
  const { progress } = await chrome.storage.local.get("progress");
  if (!progress || progress.date !== today) {
    const resetProgress = { date: today, solvedCount: 0, solvedSlugs: [] };
    await chrome.storage.local.set({ progress: resetProgress });
    return resetProgress;
  }
  progress.solvedCount = Array.isArray(progress.solvedSlugs)
    ? progress.solvedSlugs.length
    : 0;
  if (!Array.isArray(progress.solvedSlugs)) {
    progress.solvedSlugs = [];
    await chrome.storage.local.set({ progress });
  }
  return progress;
}

async function getOverrideState() {
  const { override } = await chrome.storage.local.get("override");
  if (override && typeof override.forcedUntil === "number") {
    return override;
  }
  const defaults = { forcedUntil: 0 };
  await chrome.storage.local.set({ override: defaults });
  return defaults;
}

async function getPendingTabs() {
  const { pendingTabs } = await chrome.storage.local.get("pendingTabs");
  if (pendingTabs && typeof pendingTabs === "object") {
    return pendingTabs;
  }
  await chrome.storage.local.set({ pendingTabs: {} });
  return {};
}

async function setPendingTabs(value) {
  await chrome.storage.local.set({ pendingTabs: value });
}

function isGatedHost(hostname, gatedDomains) {
  return gatedDomains.some((domain) => {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

async function pickRandomProblem(progress) {
  const problems = await loadProblems();
  if (!problems.length) {
    return null;
  }
  const solved = new Set(progress.solvedSlugs || []);
  const unsolved = problems.filter((problem) => !solved.has(problem.slug));
  const pool = unsolved.length ? unsolved : problems;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}

async function handlePotentialGate(tabId, url) {
  const settings = await getSettings();
  const hostname = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (error) {
      return "";
    }
  })();

  if (!hostname || !isGatedHost(hostname, settings.gatedDomains)) {
    return;
  }

  const bypassUntil = temporaryBypassTabs.get(tabId);
  if (bypassUntil && bypassUntil > Date.now()) {
    temporaryBypassTabs.delete(tabId);
    return;
  }
  temporaryBypassTabs.delete(tabId);

  const [progress, overrideState] = await Promise.all([
    ensureTodayProgress(),
    getOverrideState(),
  ]);

  if (progress.solvedCount >= (settings.dailyGoal || DAILY_GOAL_DEFAULT)) {
    return;
  }

  if (overrideState.forcedUntil && overrideState.forcedUntil > Date.now()) {
    return;
  }

  const problem = await pickRandomProblem(progress);
  if (!problem) {
    return;
  }

  const pendingTabs = await getPendingTabs();
  pendingTabs[String(tabId)] = {
    originalUrl: stripHash(url),
    problemSlug: problem.slug,
    assignedAt: Date.now(),
  };
  await setPendingTabs(pendingTabs);

  try {
    await chrome.tabs.update(tabId, { url: problem.url });
  } catch (error) {
    console.warn("LeetGate: failed to redirect tab", error);
  }
}

async function notifyLeetCodeTabs(payload) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://leetcode.com/*" });
    for (const tab of tabs) {
      if (typeof tab.id === "number") {
        try {
          await chrome.tabs.sendMessage(tab.id, payload);
        } catch (error) {}
      }
    }
  } catch (error) {
    console.warn("LeetGate: broadcast failed", error);
  }
}

async function unlockPendingTabs() {
  const pendingTabs = await getPendingTabs();
  const entries = Object.entries(pendingTabs);
  if (!entries.length) {
    return;
  }
  await setPendingTabs({});
  for (const [tabIdStr, info] of entries) {
    const tabId = Number(tabIdStr);
    if (Number.isNaN(tabId)) {
      continue;
    }
    try {
      await chrome.tabs.update(tabId, { url: info.originalUrl });
    } catch (error) {}
  }
}

async function handleAccepted(tabId, slug) {
  const [settings, progress] = await Promise.all([
    getSettings(),
    ensureTodayProgress(),
  ]);

  if (!progress.solvedSlugs.includes(slug)) {
    progress.solvedSlugs.push(slug);
    progress.solvedCount = progress.solvedSlugs.length;
    await chrome.storage.local.set({ progress });
  }

  await notifyLeetCodeTabs({ type: "leetgate:progress-update" });

  if (progress.solvedCount >= (settings.dailyGoal || DAILY_GOAL_DEFAULT)) {
    await unlockPendingTabs();
  }
}

async function getTabState(tabId) {
  const [settings, progress, overrideState, pendingTabs] = await Promise.all([
    getSettings(),
    ensureTodayProgress(),
    getOverrideState(),
    getPendingTabs(),
  ]);

  const pending = pendingTabs[String(tabId)] || null;
  const overrideUntil =
    typeof overrideState.forcedUntil === "number"
      ? overrideState.forcedUntil
      : 0;
  const overrideActive = Boolean(overrideUntil && overrideUntil > Date.now());

  return {
    settings,
    progress,
    pending,
    overrideActive,
    overrideUntil,
  };
}

async function handleForceVisit(tabId, mode) {
  const pendingTabs = await getPendingTabs();
  const key = String(tabId);
  const entry = pendingTabs[key];
  if (!entry) {
    return { success: false };
  }
  delete pendingTabs[key];
  await setPendingTabs(pendingTabs);

  if (mode === "pause") {
    const settings = await getSettings();
    const durationMinutes =
      Number(settings.overrideMinutes) || OVERRIDE_MINUTES_DEFAULT;
    const forcedUntil = Date.now() + durationMinutes * 60 * 1000;
    await chrome.storage.local.set({ override: { forcedUntil } });
  } else {
    temporaryBypassTabs.set(tabId, Date.now() + 15 * 1000);
  }

  try {
    await chrome.tabs.update(tabId, { url: entry.originalUrl });
  } catch (error) {}

  await notifyLeetCodeTabs({ type: "leetgate:progress-update" });

  const state = await getTabState(tabId);
  return { success: true, state };
}

chrome.runtime.onInstalled.addListener(async () => {
  await Promise.all([
    loadProblems(),
    getSettings(),
    ensureTodayProgress(),
    getOverrideState(),
    getPendingTabs(),
  ]);
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) {
    return;
  }
  if (details.url.startsWith("chrome-extension://")) {
    return;
  }
  await handlePotentialGate(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pendingTabs = await getPendingTabs();
  if (pendingTabs[String(tabId)]) {
    delete pendingTabs[String(tabId)];
    await setPendingTabs(pendingTabs);
  }
  temporaryBypassTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { tab } = sender;
  if (!message || typeof message !== "object") {
    return false;
  }

  const tabId = tab && typeof tab.id === "number" ? tab.id : null;

  if (message.type === "leetgate:hello") {
    if (tabId === null) {
      sendResponse({ success: false });
      return true;
    }
    getTabState(tabId).then((state) => {
      sendResponse({ success: true, ...state });
    });
    return true;
  }

  if (message.type === "leetgate:accepted") {
    if (tabId === null || !message.slug) {
      sendResponse({ success: false });
      return true;
    }
    handleAccepted(tabId, message.slug)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error("LeetGate: accepted handler failed", error);
        sendResponse({ success: false });
      });
    return true;
  }

  if (message.type === "leetgate:force-visit") {
    if (tabId === null) {
      sendResponse({ success: false });
      return true;
    }
    handleForceVisit(tabId, message.mode)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        console.error("LeetGate: force visit failed", error);
        sendResponse({ success: false });
      });
    return true;
  }

  if (message.type === "leetgate:get-state") {
    if (tabId === null) {
      sendResponse({ success: false });
      return true;
    }
    getTabState(tabId).then((state) => {
      sendResponse({ success: true, ...state });
    });
    return true;
  }

  if (message.type === "leetgate:reset-progress") {
    (async () => {
      const today = getTodayKey();
      const resetProgress = { date: today, solvedCount: 0, solvedSlugs: [] };
      await chrome.storage.local.set({ progress: resetProgress });
      await notifyLeetCodeTabs({ type: "leetgate:progress-update" });
      sendResponse({ success: true, progress: resetProgress });
    })().catch((error) => {
      console.error("LeetGate: reset progress failed", error);
      sendResponse({ success: false });
    });
    return true;
  }

  return false;
});

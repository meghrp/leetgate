(() => {
  const state = {
    settings: null,
    progress: null,
    pending: null,
    overrideActive: false,
    overrideUntil: 0,
  };

  let overlayEl = null;
  let overlayStyleEl = null;
  let lastAcceptedSentAt = 0;
  const ACCEPTED_DEBOUNCE_MS = 2000;
  const handledSubmissionIds = new Set();

  function getCurrentSlug() {
    const match = window.location.pathname.match(/\/problems\/([^/]+)/);
    return match ? match[1] : null;
  }

  function ensureStyle() {
    if (overlayStyleEl || !document.head) {
      return;
    }
    overlayStyleEl = document.createElement("style");
    overlayStyleEl.textContent = `
      #leetgate-overlay {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 100000;
        background: rgba(15, 23, 42, 0.92);
        color: #f8fafc;
        border-radius: 10px;
        padding: 12px 16px;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        max-width: 280px;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.35);
        border: 1px solid rgba(148, 163, 184, 0.4);
      }
      #leetgate-overlay h1 {
        font-size: 15px;
        margin: 0 0 6px;
        font-weight: 600;
      }
      #leetgate-overlay p {
        margin: 4px 0;
        font-size: 13px;
        line-height: 1.4;
      }
      #leetgate-overlay .leetgate-buttons {
        display: flex;
        gap: 6px;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      #leetgate-overlay button {
        cursor: pointer;
        border: none;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        background: #38bdf8;
        color: #0f172a;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      #leetgate-overlay button[data-variant="secondary"] {
        background: transparent;
        border: 1px solid rgba(148, 163, 184, 0.6);
        color: #f8fafc;
      }
      #leetgate-overlay button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      #leetgate-overlay button:not(:disabled):hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 14px rgba(56, 189, 248, 0.35);
      }
    `;
    document.head.appendChild(overlayStyleEl);
  }

  function shouldShowOverlay() {
    if (!state.settings || !state.progress) {
      return false;
    }
    const goal = Number(state.settings.dailyGoal) || 0;
    const solved = Number(state.progress.solvedCount) || 0;
    return solved < goal || Boolean(state.pending) || state.overrideActive;
  }

  function formatTimeUntil(timestamp) {
    if (!timestamp || timestamp <= Date.now()) {
      return "";
    }
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderOverlay() {
    if (!shouldShowOverlay()) {
      if (overlayEl && overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
      overlayEl = null;
      return;
    }

    ensureStyle();

    if (!overlayEl) {
      overlayEl = document.createElement("section");
      overlayEl.id = "leetgate-overlay";
      document.body.appendChild(overlayEl);
    }

    const goal = Number(state.settings.dailyGoal) || 0;
    const solved = Number(state.progress.solvedCount) || 0;
    const remaining = Math.max(goal - solved, 0);
    const overrideUntilLabel = formatTimeUntil(state.overrideUntil);
    const pendingHost = state.pending?.originalUrl
      ? (() => {
          try {
            return new URL(state.pending.originalUrl).hostname;
          } catch (error) {
            return state.pending.originalUrl;
          }
        })()
      : null;

    overlayEl.innerHTML = `
      <h1>LeetGate Progress</h1>
      <p>Solved today: <strong>${solved}</strong> / ${goal}</p>
      ${remaining > 0 ? `<p>${remaining} to go before socials unlock.</p>` : "<p>Quota met — socials unlocked.</p>"}
      ${pendingHost ? `<p>Waiting to unlock: <strong>${pendingHost}</strong></p>` : ""}
      ${state.overrideActive ? `<p>Override active${overrideUntilLabel ? ` until ${overrideUntilLabel}` : ""}.</p>` : ""}
      <div class="leetgate-buttons">
        <button type="button" data-action="force-once" ${pendingHost ? "" : "disabled"}>Force unlock once</button>
        <button type="button" data-action="pause" data-variant="secondary" ${state.overrideActive ? "disabled" : ""}>Pause gate (${state.settings.overrideMinutes || 15}m)</button>
      </div>
    `;

    overlayEl.querySelectorAll("button").forEach((button) => {
      const action = button.getAttribute("data-action");
      if (action === "force-once") {
        button.addEventListener("click", () => handleForceVisit("single"));
      }
      if (action === "pause") {
        button.addEventListener("click", () => handleForceVisit("pause"));
      }
    });
  }

  async function handleForceVisit(mode) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "leetgate:force-visit",
        mode,
      });
      if (response && response.success && response.state) {
        updateState(response.state);
      }
    } catch (error) {
      console.warn("LeetGate: force visit failed", error);
    }
  }

  function updateState(newState) {
    if (!newState) {
      return;
    }
    state.settings = newState.settings || state.settings;
    state.progress = newState.progress || state.progress;
    state.pending = newState.pending || null;
    state.overrideActive = Boolean(newState.overrideActive);
    state.overrideUntil = newState.overrideUntil || 0;
    renderOverlay();
  }

  async function refreshState() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "leetgate:get-state",
      });
      if (response && response.success) {
        updateState(response);
      }
    } catch (error) {
      console.warn("LeetGate: refresh state failed", error);
    }
  }

  function sendAcceptedEvent() {
    const slug = getCurrentSlug();
    if (!slug) {
      return;
    }
    const now = Date.now();
    if (now - lastAcceptedSentAt < ACCEPTED_DEBOUNCE_MS) {
      return;
    }
    lastAcceptedSentAt = now;
    chrome.runtime
      .sendMessage({ type: "leetgate:accepted", slug })
      .then((response) => {
        if (response && response.success) {
          refreshState();
        }
      })
      .catch(() => {});
  }

  function handleCheckPayload(data) {
    if (!data) {
      return;
    }
    const statusRaw = String(data.status_msg || data.state || "").toLowerCase();
    const isAccepted =
      statusRaw.includes("accepted") || data.status_code === 10;
    if (!isAccepted) {
      return;
    }
    const submissionId = data.submission_id || data.id;
    if (submissionId && handledSubmissionIds.has(submissionId)) {
      return;
    }
    if (submissionId) {
      handledSubmissionIds.add(submissionId);
    }
    sendAcceptedEvent();
  }

  function patchFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const requestInfo = args[0];
        const url =
          typeof requestInfo === "string"
            ? requestInfo
            : (requestInfo && requestInfo.url) || "";
        if (url.includes("/submissions/detail/") && url.includes("/check/")) {
          response
            .clone()
            .json()
            .then(handleCheckPayload)
            .catch(() => {});
        }
      } catch (error) {}
      return response;
    };
  }

  function patchXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__leetgateUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      this.addEventListener("load", () => {
        try {
          const url = this.__leetgateUrl || "";
          if (url.includes("/submissions/detail/") && url.includes("/check/")) {
            handleCheckPayload(JSON.parse(this.responseText));
          }
        } catch (error) {}
      });
      return originalSend.call(this, body);
    };
  }

  function nodeHasAcceptedText(node) {
    if (!node) {
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent && node.textContent.trim() === "Accepted";
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.textContent && node.textContent.trim() === "Accepted") {
        return true;
      }
      return Array.from(node.childNodes).some((child) =>
        nodeHasAcceptedText(child),
      );
    }
    return false;
  }

  function bootstrapObservers() {
    patchFetch();
    patchXHR();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (nodeHasAcceptedText(node)) {
              sendAcceptedEvent();
              return;
            }
          }
        }
        if (
          mutation.type === "characterData" &&
          nodeHasAcceptedText(mutation.target)
        ) {
          sendAcceptedEvent();
          return;
        }
      }
    });
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "leetgate:progress-update") {
      refreshState();
    }
  });

  async function init() {
    await refreshState();
    bootstrapObservers();
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();

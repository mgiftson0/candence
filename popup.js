/**
 * popup.js
 * 
 * Cadence Auto-Refresher Popup Controller
 * Manages configuration UI, persists settings per tab, and sends activation/deactivation
 * messages to the service worker background context.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Resolve the TARGET tab ID.
  // background.js passes it via ?tabId= when creating the popup window.
  // Fallback: query for the active tab in a *normal* browser window.
  // ──────────────────────────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  let tabId = params.has('tabId') ? parseInt(params.get('tabId'), 10) : null;

  if (!tabId) {
    // Fallback: find active tab in a normal (non-popup, non-extension) window
    const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
    const realTab = tabs.find(t => !t.url.startsWith('chrome'));
    if (realTab) tabId = realTab.id;
  }

  if (!tabId) return;

  // Store this popup's own window ID so we can refocus it after picking
  const popupWindowId = (await chrome.windows.getCurrent()).id;

  // DOM Elements
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const modeButtons = document.querySelectorAll('.mode-btn');
  const selectorConfig = document.getElementById('selector-config');
  const dropdownSelectorInput = document.getElementById('dropdown-selector');
  const containerSelectorInput = document.getElementById('container-selector');
  const groupDropdown = document.getElementById('group-dropdown-selector');
  const groupContainer = document.getElementById('group-container-selector');
  const intervalButtons = document.querySelectorAll('.interval-btn');
  const customBtn = document.getElementById('custom-btn');
  const customIntervalWrapper = document.getElementById('custom-interval-wrapper');
  const customSecondsInput = document.getElementById('custom-seconds');
  const triggerOnceBtn = document.getElementById('trigger-once-btn');
  const masterToggle = document.getElementById('master-toggle');
  const pickDropdownBtn = document.getElementById('pick-dropdown-btn');
  const pickContainerBtn = document.getElementById('pick-container-btn');

  // Default Local State
  let state = {
    enabled: false,
    mode: 'full', // 'full', 'content', 'component'
    interval: 10,  // in seconds
    dropdownSelector: 'mat-select, select#consulate_id',
    dateContainerSelector: '.calendar-table, #calendar-wrapper, .dates-wrapper, mat-form-field',
    lastRefresh: null
  };

  // ============================================================================
  // UI Sync Functions
  // ============================================================================

  function updateUI() {
    // 1. Sync Status Indicator
    if (state.enabled) {
      statusIndicator.classList.add('active');
      statusText.textContent = 'ACTIVE';
      masterToggle.textContent = 'DEACTIVATE';
      masterToggle.classList.add('active');
    } else {
      statusIndicator.classList.remove('active');
      statusText.textContent = 'INACTIVE';
      masterToggle.textContent = 'ACTIVATE';
      masterToggle.classList.remove('active');
    }

    // 2. Sync Mode Buttons
    modeButtons.forEach(btn => {
      if (btn.getAttribute('data-mode') === state.mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Show/Hide target configuration based on selected mode
    if (state.mode === 'content') {
      selectorConfig.classList.remove('hidden');
      groupDropdown.classList.add('hidden'); // Content swap doesn't need dropdown select
      groupContainer.classList.remove('hidden');
    } else if (state.mode === 'component') {
      selectorConfig.classList.remove('hidden');
      groupDropdown.classList.remove('hidden');
      groupContainer.classList.remove('hidden');
    } else {
      selectorConfig.classList.add('hidden');
    }

    // 3. Sync Inputs
    dropdownSelectorInput.value = state.dropdownSelector || '';
    containerSelectorInput.value = state.dateContainerSelector || '';

    // 4. Sync Interval Buttons
    let isPreset = false;
    intervalButtons.forEach(btn => {
      const secs = parseInt(btn.getAttribute('data-seconds'), 10);
      if (secs === state.interval) {
        btn.classList.add('active');
        isPreset = true;
      } else {
        btn.classList.remove('active');
      }
    });

    if (!isPreset && state.interval) {
      customBtn.classList.add('active');
      customIntervalWrapper.classList.remove('hidden');
      customSecondsInput.value = state.interval;
    } else {
      customBtn.classList.remove('active');
      customIntervalWrapper.classList.add('hidden');
    }
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  // Mode Selection
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.getAttribute('data-mode');
      updateUI();
      saveAndSyncIfNeeded();
    });
  });

  // Selector changes
  [dropdownSelectorInput, containerSelectorInput].forEach(input => {
    input.addEventListener('input', () => {
      state.dropdownSelector = dropdownSelectorInput.value;
      state.dateContainerSelector = containerSelectorInput.value;
      saveAndSyncIfNeeded();
    });
  });

  // Preset Intervals
  intervalButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const secs = btn.getAttribute('data-seconds');
      if (secs) {
        state.interval = parseInt(secs, 10);
        updateUI();
        saveAndSyncIfNeeded();
      }
    });
  });

  // Custom Interval Trigger
  customBtn.addEventListener('click', () => {
    customBtn.classList.add('active');
    customIntervalWrapper.classList.remove('hidden');
    // Deselect all presets
    intervalButtons.forEach(btn => btn.classList.remove('active'));
    state.interval = parseInt(customSecondsInput.value, 10) || 10;
    saveAndSyncIfNeeded();
  });

  customSecondsInput.addEventListener('input', () => {
    state.interval = parseInt(customSecondsInput.value, 10) || 5;
    if (state.interval < 5) state.interval = 5; // Enforce minimum interval of 5 seconds
    saveAndSyncIfNeeded();
  });

  // ============================================================================
  // Element Picker (DevTools-style direct injection)
  // Uses chrome.scripting.executeScript to inject the picker directly into the
  // page — no content script messaging required. Works like DevTools' inspector.
  // ============================================================================

  let activePicker = null; // 'dropdown' | 'container' | null

  /**
   * Injects a self-contained element picker into the target tab.
   * The picker highlights hovered elements, captures a CSS selector on click,
   * writes the result to chrome.storage.local, and tears itself down.
   */
  function injectPicker() {
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // ── Bail if picker is already running ──
        if (window.__cadencePickerActive) return;
        window.__cadencePickerActive = true;

        const OVERLAY_ID = '__cadence_picker_overlay';

        // ── Build a unique CSS selector for an element ──
        function buildSelector(el) {
          if (!el || el === document.body) return 'body';
          const parts = [];
          let cur = el;
          while (cur && cur !== document.body && cur.nodeType === 1) {
            let part = cur.tagName.toLowerCase();
            if (cur.id) { parts.unshift('#' + cur.id); break; }
            const classes = [...cur.classList]
              .filter(c => !c.startsWith('ng-') && !c.startsWith('cdk-') && c.length < 30)
              .slice(0, 2);
            if (classes.length) {
              part += '.' + classes.join('.');
            } else {
              const siblings = [...(cur.parentElement?.children || [])];
              part += ':nth-child(' + (siblings.indexOf(cur) + 1) + ')';
            }
            parts.unshift(part);
            cur = cur.parentElement;
            if (parts.length >= 4) break;
          }
          return parts.join(' > ');
        }

        // ── Create/update the highlight overlay ──
        function showOverlay(el) {
          removeOverlay();
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const ov = document.createElement('div');
          ov.id = OVERLAY_ID;
          Object.assign(ov.style, {
            position: 'fixed', top: rect.top + 'px', left: rect.left + 'px',
            width: rect.width + 'px', height: rect.height + 'px',
            border: '2px solid #000', background: 'rgba(0,0,0,0.08)',
            zIndex: '2147483646', pointerEvents: 'none', boxSizing: 'border-box',
            transition: 'all 0.08s ease'
          });
          // Selector label
          const lbl = document.createElement('div');
          Object.assign(lbl.style, {
            position: 'absolute', bottom: '100%', left: '0',
            background: '#000', color: '#fff', fontFamily: 'monospace',
            fontSize: '10px', padding: '2px 6px', whiteSpace: 'nowrap',
            maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis',
            pointerEvents: 'none', borderRadius: '2px 2px 0 0'
          });
          lbl.textContent = buildSelector(el);
          ov.appendChild(lbl);
          document.body.appendChild(ov);
        }

        function removeOverlay() {
          const ex = document.getElementById(OVERLAY_ID);
          if (ex) ex.remove();
        }

        // ── Event handlers ──
        function onMove(e) {
          showOverlay(e.target);
        }
        function onClick(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const selector = buildSelector(e.target);
          cleanup();
          // Write result to storage — popup listens via onChanged
          chrome.storage.local.set({ cadence_picker_result: { selector, ts: Date.now() } });
        }
        function onKey(e) {
          if (e.key === 'Escape') cleanup();
        }

        function cleanup() {
          window.__cadencePickerActive = false;
          document.body.style.cursor = '';
          document.removeEventListener('mouseover', onMove, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
          removeOverlay();
        }

        // ── Activate ──
        document.body.style.cursor = 'crosshair';
        document.addEventListener('mouseover', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
      }
    });
  }

  /** Inject a cleanup call to stop the picker in the tab */
  function injectPickerStop() {
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (!window.__cadencePickerActive) return;
        window.__cadencePickerActive = false;
        document.body.style.cursor = '';
        const ov = document.getElementById('__cadence_picker_overlay');
        if (ov) ov.remove();
        // Can't easily remove anonymous listeners, but the flag prevents them from firing
      }
    }).catch(() => {});
  }

  function startPicker(target) {
    injectPickerStop(); // cancel any existing session
    activePicker = target;
    pickDropdownBtn.classList.toggle('active', target === 'dropdown');
    pickContainerBtn.classList.toggle('active', target === 'container');

    // Focus the browsing tab so user can interact with the page
    chrome.tabs.update(tabId, { active: true });

    // Small delay to let the tab gain focus before injecting
    setTimeout(() => injectPicker(), 150);
  }

  pickDropdownBtn.addEventListener('click', () => {
    if (activePicker === 'dropdown') {
      activePicker = null;
      pickDropdownBtn.classList.remove('active');
      injectPickerStop();
    } else {
      startPicker('dropdown');
    }
  });

  pickContainerBtn.addEventListener('click', () => {
    if (activePicker === 'container') {
      activePicker = null;
      pickContainerBtn.classList.remove('active');
      injectPickerStop();
    } else {
      startPicker('container');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Storage-based picker result listener
  // ─────────────────────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.cadence_picker_result || !activePicker) return;

    const { selector } = changes.cadence_picker_result.newValue;

    if (activePicker === 'dropdown') {
      dropdownSelectorInput.value = selector;
      state.dropdownSelector = selector;
      pickDropdownBtn.classList.remove('active');
    } else if (activePicker === 'container') {
      containerSelectorInput.value = selector;
      state.dateContainerSelector = selector;
      pickContainerBtn.classList.remove('active');
    }

    activePicker = null;
    saveAndSyncIfNeeded();

    // Clean up so old results don't replay
    chrome.storage.local.remove('cadence_picker_result');

    // Bring the popup window back to the front
    chrome.windows.update(popupWindowId, { focused: true });
  });

  // STATE_UPDATED arrives from background when the page pauses/stops refresh
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_UPDATED' && message.tabId === tabId) {
      state = { ...state, ...message.state };
      updateUI();
    }
  });

  // Immediate single refresh execution (routes through background's triggerRefresh)
  triggerOnceBtn.addEventListener('click', () => {
    if (state.mode === 'full') {
      chrome.tabs.reload(tabId);
    } else {
      // Trigger one refresh cycle through background.js (which uses executeScript)
      chrome.runtime.sendMessage({
        action: 'START_REFRESH',
        tabId,
        state: { ...state, enabled: false } // one-shot, don't leave it enabled
      }, () => {
        // Force an immediate trigger
        chrome.runtime.sendMessage({ action: 'TRIGGER_ONCE', tabId });
      });
    }
  });

  // Master Activate/Deactivate Toggle
  masterToggle.addEventListener('click', () => {
    if (state.enabled) {
      // Deactivate
      state.enabled = false;
      chrome.runtime.sendMessage({ action: 'STOP_REFRESH', tabId }, () => {
        updateUI();
      });
    } else {
      // Activate
      state.enabled = true;
      chrome.runtime.sendMessage({ action: 'START_REFRESH', tabId, state }, () => {
        updateUI();
      });
    }
  });

  /**
   * Helper to write state updates back to background and update timer.
   */
  function saveAndSyncIfNeeded() {
    if (state.enabled) {
      // Re-trigger START_REFRESH to synchronize service worker alarms and timers
      chrome.runtime.sendMessage({ action: 'START_REFRESH', tabId, state });
    } else {
      // Just save locally in storage so it persists for the popup session
      const key = `tab_state_${tabId}`;
      chrome.storage.local.set({ [key]: state });
    }
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  // Fetch state on startup
  chrome.runtime.sendMessage({ action: 'GET_STATE', tabId }, (response) => {
    if (response && response.state) {
      state = { ...state, ...response.state };
    }
    updateUI();
  });
});

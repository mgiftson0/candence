/**
 * popup.js
 * 
 * Cadence Auto-Refresher Popup Controller
 * Manages configuration UI, persists settings per tab, and sends activation/deactivation
 * messages to the service worker background context.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Get currently active tab ID from the last focused browsing window
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const tabId = tab.id;

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
  // Element Picker (PICK Mode)
  // Instructs the content script to enter pick mode: hovers highlight elements,
  // clicks capture a unique CSS selector and send it back to this popup.
  // ============================================================================

  let activePicker = null; // 'dropdown' | 'container' | null

  function startPicker(target) {
    // Cancel any existing picker session first
    chrome.tabs.sendMessage(tabId, { action: 'STOP_PICKER' }, () => {
      chrome.runtime.lastError; // suppress
    });

    activePicker = target;
    pickDropdownBtn.classList.toggle('active', target === 'dropdown');
    pickContainerBtn.classList.toggle('active', target === 'container');

    // Minimise popup by focusing the tab so user can click on the page
    chrome.tabs.update(tabId, { active: true });
    chrome.tabs.sendMessage(tabId, { action: 'START_PICKER' }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Cadence] Content script not ready for picker.');
        activePicker = null;
      }
    });
  }

  pickDropdownBtn.addEventListener('click', () => {
    if (activePicker === 'dropdown') {
      // Second click cancels
      activePicker = null;
      pickDropdownBtn.classList.remove('active');
      chrome.tabs.sendMessage(tabId, { action: 'STOP_PICKER' }, () => { chrome.runtime.lastError; });
    } else {
      startPicker('dropdown');
    }
  });

  pickContainerBtn.addEventListener('click', () => {
    if (activePicker === 'container') {
      activePicker = null;
      pickContainerBtn.classList.remove('active');
      chrome.tabs.sendMessage(tabId, { action: 'STOP_PICKER' }, () => { chrome.runtime.lastError; });
    } else {
      startPicker('container');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Storage-based picker result listener (more reliable than sendMessage
  // for standalone popup windows that may not have focus when result arrives)
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

    // Clean up the storage key so old results don't replay on next open
    chrome.storage.local.remove('cadence_picker_result');
  });

  // STATE_UPDATED arrives from background when the page pauses/stops refresh
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_UPDATED' && message.tabId === tabId) {
      state = { ...state, ...message.state };
      updateUI();
    }
  });

  // Immediate single refresh execution
  triggerOnceBtn.addEventListener('click', () => {
    chrome.tabs.sendMessage(tabId, {
      action: 'TRIGGER_CONTENT_REFRESH',
      mode: state.mode,
      dropdownSelector: state.dropdownSelector,
      dateContainerSelector: state.dateContainerSelector
    }, (response) => {
      if (chrome.runtime.lastError || state.mode === 'full') {
        // Fallback to full page reload if content script is unavailable
        chrome.tabs.reload(tabId);
      }
    });
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

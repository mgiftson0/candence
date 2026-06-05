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

  // Default Local State
  let state = {
    enabled: false,
    mode: 'full', // 'full', 'content', 'component'
    interval: 10,  // in seconds
    dropdownSelector: 'select#consulate_id',
    dateContainerSelector: '.calendar-table, #calendar-wrapper, .dates-wrapper',
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

  // Listen for state changes (e.g. if content script paused auto-refresh)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_UPDATED' && message.tabId === tabId) {
      state = { ...state, ...message.state };
      updateUI();
    }
  });
});

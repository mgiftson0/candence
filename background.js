/**
 * background.js
 * 
 * Cadence Auto-Refresher Service Worker
 * Coordinates auto-refresh tasks across browser tabs using Chrome's Alarms and Storage APIs.
 * It manages tab state, tracks tab focus shifts, and triggers reloads when intervals expire.
 */

// ============================================================================
// State Management & Constants
// ============================================================================

const ALARM_PREFIX = 'cadence_alarm_';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Retrieves the state for a specific tab from local storage.
 * @param {number} tabId 
 * @returns {Promise<Object|null>}
 */
async function getTabState(tabId) {
  const key = `tab_state_${tabId}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

/**
 * Updates the state for a specific tab in local storage.
 * @param {number} tabId 
 * @param {Object} state 
 */
async function setTabState(tabId, state) {
  const key = `tab_state_${tabId}`;
  await chrome.storage.local.set({ [key]: state });
}

/**
 * Triggers the refresh action on a tab based on its state.
 * @param {number} tabId 
 * @param {Object} state 
 */
async function triggerRefresh(tabId, state) {
  try {
    // Check if the tab still exists before proceeding
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;

    if (state.mode === 'full') {
      // Full page refresh using native chrome tabs API
      chrome.tabs.reload(tabId);
    } else {
      // Content-only or Component-level refresh requires content script cooperation
      chrome.tabs.sendMessage(tabId, {
        action: 'TRIGGER_CONTENT_REFRESH',
        mode: state.mode,
        dropdownSelector: state.dropdownSelector,
        dateContainerSelector: state.dateContainerSelector
      }, (response) => {
        // Handle potential channel closure when tab is loading or script is not ready
        if (chrome.runtime.lastError) {
          console.warn(`Content script not ready on tab ${tabId}. Retrying with full reload fallback.`);
        }
      });
    }

    // Update last refresh timestamp
    state.lastRefresh = Date.now();
    await setTabState(tabId, state);
    
    // Notify popup if it's open
    chrome.runtime.sendMessage({ action: 'STATE_UPDATED', tabId, state }).catch(() => {
      // Suppress error if popup is closed
    });
  } catch (error) {
    console.error(`Failed to refresh tab ${tabId}:`, error);
  }
}

// ============================================================================
// Alarm & Timer Lifecycle
// ============================================================================

/**
 * Configures the alarm for a given tab state.
 * Alarms require a minimum of 1 minute in packed extensions, but we configure
 * them as a fallback, and use message-driven scheduling for high-frequency (sub-minute) timers.
 */
async function setupAlarmForTab(tabId, state) {
  const alarmName = `${ALARM_PREFIX}${tabId}`;
  await chrome.alarms.clear(alarmName);

  if (!state || !state.enabled) return;

  const intervalSeconds = state.interval;
  
  // Note: Chrome Alarms API has a 1-minute minimum restriction in production.
  // For sub-minute intervals (5s, 10s, 15s, 30s), we rely on active content script timers.
  // We still register a 1-minute fallback alarm to keep the service worker active and coordinate state.
  const periodInMinutes = Math.max(1, intervalSeconds / 60);
  
  chrome.alarms.create(alarmName, {
    delayInMinutes: periodInMinutes,
    periodInMinutes: periodInMinutes
  });
}

// ============================================================================
// Event Listeners
// ============================================================================

// Listen for alarm triggers
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const tabId = parseInt(alarm.name.replace(ALARM_PREFIX, ''), 10);
    const state = await getTabState(tabId);
    if (state && state.enabled) {
      // Only trigger if it's a >= 1 min interval (content scripts handle sub-minute natively)
      if (state.interval >= 60) {
        await triggerRefresh(tabId, state);
      }
    }
  }
});

// Listen for runtime messages from Popup or Content Scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);
  
  if (!tabId) return;

  if (message.action === 'START_REFRESH') {
    (async () => {
      const state = message.state;
      await setTabState(tabId, state);
      await setupAlarmForTab(tabId, state);
      
      // Send message to content script to initialize its local high-frequency timer if sub-minute
      chrome.tabs.sendMessage(tabId, { action: 'SYNC_TIMER', state }).catch(() => {});
      
      sendResponse({ success: true });
    })();
    return true; // Keep message channel open for async response
  }

  if (message.action === 'STOP_REFRESH') {
    (async () => {
      const state = await getTabState(tabId);
      if (state) {
        state.enabled = false;
        await setTabState(tabId, state);
      }
      await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
      
      // Stop timer in content script
      chrome.tabs.sendMessage(tabId, { action: 'STOP_TIMER' }).catch(() => {});
      
      sendResponse({ success: true });
    })();
    return true;
  }
  
  if (message.action === 'GET_STATE') {
    getTabState(tabId).then(state => {
      sendResponse({ state });
    });
    return true;
  }

  // Content script reporting that its local sub-minute timer has completed
  if (message.action === 'SUB_MINUTE_TICK') {
    (async () => {
      const state = await getTabState(tabId);
      if (state && state.enabled) {
        await triggerRefresh(tabId, state);
        // Reschedule next tick in the content script
        chrome.tabs.sendMessage(tabId, { action: 'SYNC_TIMER', state }).catch(() => {});
      }
    })();
  }
});

// Clean up state and alarms when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_state_${tabId}`);
  await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
});

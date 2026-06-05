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
 * Uses chrome.scripting.executeScript for component/content modes to avoid
 * relying on content script message listeners (which break after extension reloads).
 * @param {number} tabId 
 * @param {Object} state 
 */
async function triggerRefresh(tabId, state) {
  try {
    // Check if the tab still exists before proceeding
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;

    if (state.mode === 'full') {
      chrome.tabs.reload(tabId);
    } else if (state.mode === 'component') {
      // Inject the dropdown simulation directly into the page
      const selector = state.dropdownSelector || '';
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return;

          // Angular Material mat-select
          const isMatSelect = el.tagName.toLowerCase() === 'mat-select' || el.closest('mat-form-field');
          if (isMatSelect) {
            let matSelect = el.tagName.toLowerCase() === 'mat-select' ? el : el.querySelector('mat-select') || el;
            matSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            matSelect.click();
            setTimeout(() => {
              const options = document.querySelectorAll('mat-option, .mat-option');
              let selectedIndex = -1;
              options.forEach((opt, i) => {
                if (opt.classList.contains('mat-selected') || opt.getAttribute('aria-selected') === 'true') selectedIndex = i;
              });
              const tmpIdx = selectedIndex === 0 ? 1 : 0;
              if (options[tmpIdx]) {
                options[tmpIdx].click();
                setTimeout(() => {
                  matSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  matSelect.click();
                  setTimeout(() => {
                    const freshOpts = document.querySelectorAll('mat-option, .mat-option');
                    if (freshOpts[selectedIndex]) freshOpts[selectedIndex].click();
                  }, 200);
                }, 200);
              }
            }, 200);
            return;
          }

          // Native <select>
          if (el.tagName === 'SELECT' && el.options && el.options.length > 1) {
            const origIdx = el.selectedIndex;
            const tmpIdx = origIdx === 0 ? 1 : 0;
            el.selectedIndex = tmpIdx;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            setTimeout(() => {
              el.selectedIndex = origIdx;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, 250);
            return;
          }

          // Generic: just click it
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.click();
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [selector]
      }).catch(err => console.warn('[Cadence] Component refresh injection failed:', err));
    } else if (state.mode === 'content') {
      // Content-swap mode: re-fetch the page and replace a container
      const containerSel = state.dateContainerSelector || '';
      chrome.scripting.executeScript({
        target: { tabId },
        func: async (sel) => {
          try {
            const resp = await fetch(window.location.href, { cache: 'no-store' });
            if (!resp.ok) return;
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            if (sel) {
              const target = document.querySelector(sel);
              const source = doc.querySelector(sel);
              if (target && source) target.innerHTML = source.innerHTML;
            } else {
              document.body.innerHTML = doc.body.innerHTML;
            }
          } catch (e) { console.error('[Cadence] Content swap failed:', e); }
        },
        args: [containerSel]
      }).catch(err => console.warn('[Cadence] Content refresh injection failed:', err));
    }

    // Update last refresh timestamp
    state.lastRefresh = Date.now();
    await setTabState(tabId, state);
    
    // Notify popup if it's open
    chrome.runtime.sendMessage({ action: 'STATE_UPDATED', tabId, state }).catch(() => {});
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

  // Handle auto-refresh pause triggered by user activity on the webpage
  if (message.action === 'PAUSE_REFRESH') {
    (async () => {
      const state = await getTabState(tabId);
      if (state && state.enabled) {
        state.enabled = false;
        state.paused = true; // Mark as paused due to user activity
        await setTabState(tabId, state);
        await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
        chrome.tabs.sendMessage(tabId, { action: 'STOP_TIMER' }).catch(() => {});
        
        // Notify popup to sync its visual status
        chrome.runtime.sendMessage({ action: 'STATE_UPDATED', tabId, state }).catch(() => {});
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  // One-shot immediate trigger from popup's "Refresh Once" button
  if (message.action === 'TRIGGER_ONCE') {
    (async () => {
      const state = await getTabState(tabId);
      if (state) {
        await triggerRefresh(tabId, state);
      }
      sendResponse({ success: true });
    })();
    return true;
  }
});

// Launch extension popup in a draggable & resizable popup window
// The `tab` parameter from onClicked is the tab the user was viewing —
// pass it via query string so the popup always targets the correct tab.
chrome.action.onClicked.addListener((tab) => {
  chrome.windows.create({
    url: `popup.html?tabId=${tab.id}`,
    type: 'popup',
    width: 340,
    height: 480
  });
});

// Clean up state and alarms when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_state_${tabId}`);
  await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
});

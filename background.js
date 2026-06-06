/**
 * background.js
 * 
 * Cadence Auto-Refresher Service Worker
 * Manages tab states, coordinates dynamic script injections, and handles
 * sub-minute polling loops and Chrome alarms.
 */

// ============================================================================
// State Management & Constants
// ============================================================================

const ALARM_PREFIX = 'cadence_alarm_';

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

// ============================================================================
// Dynamic Script & Timer Injections
// ============================================================================

/**
 * Stops the sub-minute timer loop inside the tab.
 * @param {number} tabId 
 */
async function stopDynamicTimer(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (window.__cadenceTimer) {
          clearTimeout(window.__cadenceTimer);
          window.__cadenceTimer = null;
        }
        const badge = document.getElementById('cadence-status-badge');
        if (badge) badge.remove();
      }
    }).catch(() => {});
  } catch (err) {
    // Ignore errors for closed tabs/origins
  }
}

/**
 * Starts the sub-minute timer loop inside the tab's context.
 * Dynamic injection makes it immune to context invalidation.
 * @param {number} tabId 
 * @param {Object} state 
 */
async function startDynamicTimer(tabId, state) {
  try {
    // First, clear any existing timer elements
    await stopDynamicTimer(tabId);

    if (!state || !state.enabled || state.interval >= 60) return;

    // Inject timer and interaction listeners into the target page (all frames)
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (tabState) => {
        // Clear duplicates
        if (window.__cadenceTimer) {
          clearTimeout(window.__cadenceTimer);
          window.__cadenceTimer = null;
        }

        // 1. User click detection to deactivate auto-refresh on interaction
        if (!window.__cadenceClickBound) {
          window.__cadenceClickBound = true;
          document.addEventListener('click', (event) => {
            const target = event.target;
            const isInteractive = target.closest('button, input, select, a, .day-tile, [role="button"]');
            const isInsideContainer = tabState.dateContainerSelector && target.closest(tabState.dateContainerSelector);

            if (isInteractive || isInsideContainer) {
              console.log('[Cadence] User action detected. Deactivating auto-refresh.');
              chrome.runtime.sendMessage({ action: 'STOP_REFRESH' });
              
              // Present transient visual confirmation
              const note = document.createElement('div');
              Object.assign(note.style, {
                position: 'fixed', bottom: '24px', right: '24px',
                backgroundColor: '#000000', color: '#ffffff',
                border: '1.5px solid #ffffff', padding: '10px 16px',
                fontFamily: 'monospace', fontSize: '10px', fontWeight: 'bold',
                letterSpacing: '0.05em', zIndex: '2147483647', pointerEvents: 'none'
              });
              note.textContent = 'CADENCE: AUTO-REFRESH STOPPED';
              document.body.appendChild(note);
              setTimeout(() => note.remove(), 2500);
            }
          }, true); // Use capture phase to intercept early
        }

        // 2. High-precision scheduling loop (only run in top-level frame to prevent duplicates)
        if (window === window.top) {
          const tick = () => {
            // Check if user is hovering the date container selector in top frame
            let isHovered = false;
            if (tabState.dateContainerSelector) {
              const containers = document.querySelectorAll(tabState.dateContainerSelector);
              for (const c of containers) {
                if (c.matches(':hover')) {
                  isHovered = true;
                  break;
                }
              }
            }

            // Check if any frame or iframe is hovered
            if (!isHovered) {
              const frames = document.querySelectorAll('iframe, frame');
              for (const f of frames) {
                if (f.matches(':hover')) {
                  isHovered = true;
                  break;
                }
              }
            }

            if (isHovered) {
              console.log('[Cadence] Refresh postponed: User is hovering the refresh area.');
              
              // Ensure status badge is drawn
              let badge = document.getElementById('cadence-status-badge');
              if (!badge) {
                badge = document.createElement('div');
                badge.id = 'cadence-status-badge';
                Object.assign(badge.style, {
                  position: 'fixed', top: '8px', right: '8px',
                  backgroundColor: '#000000', color: '#ffffff',
                  border: '1px solid #ffffff', padding: '3px 6px',
                  fontFamily: 'monospace', fontSize: '8px', fontWeight: 'bold',
                  zIndex: '2147483647', pointerEvents: 'none', letterSpacing: '0.05em'
                });
                badge.textContent = 'CADENCE: REFRESH PAUSED (HOVERING)';
                document.body.appendChild(badge);
              }
              
              // Postpone check by 1 second
              window.__cadenceTimer = setTimeout(tick, 1000);
              return;
            } else {
              const badge = document.getElementById('cadence-status-badge');
              if (badge) badge.remove();
            }

            // Send tick message to background worker
            chrome.runtime.sendMessage({ action: 'SUB_MINUTE_TICK' }, (res) => {
              if (chrome.runtime.lastError) {
                console.log('[Cadence] Background disconnected. Stopping timer.');
                return;
              }
              window.__cadenceTimer = setTimeout(tick, tabState.interval * 1000);
            });
          };

          window.__cadenceTimer = setTimeout(tick, tabState.interval * 1000);
          console.log(`[Cadence] Dynamic timer initialized. Interval: ${tabState.interval}s`);
        }
      },
      args: [state]
    }).catch(err => console.warn('[Cadence] Script injection failed:', err));
  } catch (error) {
    console.error('[Cadence] startDynamicTimer failed:', error);
  }
}

// ============================================================================
// Core Refresh Dispatcher
// ============================================================================

/**
 * Triggers the refresh action on a tab based on its state.
 * @param {number} tabId 
 * @param {Object} state 
 */
async function triggerRefresh(tabId, state) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;

    if (state.mode === 'full') {
      chrome.tabs.reload(tabId);
    } else if (state.mode === 'component') {
      // Inject dropdown simulation into all frames to support iframes
      const selector = state.dropdownSelector || '';
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN', // Execute directly in the page environment to run native handlers
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return;

          console.log(`[Cadence] Found target element in frame:`, el);

          // Angular Material mat-select dropdowns
          const isMatSelect = el.tagName.toLowerCase() === 'mat-select' || el.closest('mat-form-field');
          if (isMatSelect) {
            let matSelect = el.tagName.toLowerCase() === 'mat-select' ? el : el.querySelector('mat-select') || el;
            matSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            matSelect.click();
            setTimeout(() => {
              const options = document.querySelectorAll('mat-option, .mat-option');
              let selectedIndex = -1;
              options.forEach((opt, i) => {
                if (opt.classList.contains('mat-selected') || opt.getAttribute('aria-selected') === 'true') {
                  selectedIndex = i;
                }
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

          // Native dropdown select elements
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

          // Generic clickable component fallback
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.click();
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [selector]
      }).catch(err => console.warn('[Cadence] Component trigger execution failed:', err));

    } else if (state.mode === 'content') {
      // Content-only DOM swap (allFrames: true is used to update the matching section wherever it resides)
      const containerSel = state.dateContainerSelector || '';
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: async (sel) => {
          try {
            // Warn if trying to use fetch on local files (CORS block)
            if (window.location.protocol === 'file:') {
              console.warn('[Cadence] Content-swap fetches are blocked on file:// protocols. Reloading page instead.');
              window.location.reload();
              return;
            }

            const resp = await fetch(window.location.href, { cache: 'no-store' });
            if (!resp.ok) return;
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            if (sel) {
              const target = document.querySelector(sel);
              const source = doc.querySelector(sel);
              if (target && source) {
                target.innerHTML = source.innerHTML;
                console.log(`[Cadence] Container swapped: ${sel}`);
              }
            } else {
              document.body.innerHTML = doc.body.innerHTML;
              console.log('[Cadence] Body swapped.');
            }
          } catch (e) {
            console.error('[Cadence] Content swap fetch failure:', e);
          }
        },
        args: [containerSel]
      }).catch(err => console.warn('[Cadence] Content swap execution failed:', err));
    }

    // Record last refresh time
    state.lastRefresh = Date.now();
    await setTabState(tabId, state);
    
    // Broadcast status to Popup
    chrome.runtime.sendMessage({ action: 'STATE_UPDATED', tabId, state }).catch(() => {});
  } catch (error) {
    console.error(`[Cadence] Failed to refresh tab ${tabId}:`, error);
  }
}

// ============================================================================
// Alarm Lifecycle Fallbacks (For Background Persistence)
// ============================================================================

async function setupAlarmForTab(tabId, state) {
  const alarmName = `${ALARM_PREFIX}${tabId}`;
  await chrome.alarms.clear(alarmName);

  if (!state || !state.enabled) return;

  const intervalSeconds = state.interval;
  
  // Alarms require >= 1 minute in Chrome production context.
  // For sub-minute intervals (under 60s), the background script relies on the
  // dynamically injected page-level timers. We still create a fallback alarm at 1 min
  // to keep the service worker active and act as a watchdog timer.
  const periodInMinutes = Math.max(1, intervalSeconds / 60);
  
  chrome.alarms.create(alarmName, {
    delayInMinutes: periodInMinutes,
    periodInMinutes: periodInMinutes
  });
}

// ============================================================================
// Event Receivers & Watchdogs
// ============================================================================

// Listen for fallback / long-running alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const tabId = parseInt(alarm.name.replace(ALARM_PREFIX, ''), 10);
    const state = await getTabState(tabId);
    if (state && state.enabled) {
      // Only execute refresh if it is a standard >= 60s timer (page-level handles sub-minute)
      if (state.interval >= 60) {
        await triggerRefresh(tabId, state);
      }
    }
  }
});

// Route messages from popup and dynamic context scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);
  if (!tabId) return;

  if (message.action === 'START_REFRESH') {
    (async () => {
      const state = message.state;
      await setTabState(tabId, state);
      await setupAlarmForTab(tabId, state);
      await startDynamicTimer(tabId, state);
      sendResponse({ success: true });
    })();
    return true; // async handler
  }

  if (message.action === 'STOP_REFRESH') {
    (async () => {
      const state = await getTabState(tabId);
      if (state) {
        state.enabled = false;
        await setTabState(tabId, state);
      }
      await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
      await stopDynamicTimer(tabId);
      
      // Sync UI status back to popup
      chrome.runtime.sendMessage({ action: 'STATE_UPDATED', tabId, state }).catch(() => {});
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

  if (message.action === 'SUB_MINUTE_TICK') {
    (async () => {
      const state = await getTabState(tabId);
      if (state && state.enabled) {
        await triggerRefresh(tabId, state);
      }
      sendResponse({ success: true });
    })();
    return true;
  }

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

// Auto-restore dynamic timers when tabs reload (crucial for full mode or manual reloads)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    const state = await getTabState(tabId);
    if (state && state.enabled) {
      console.log(`[Cadence] Tab ${tabId} reloaded. Re-injecting active dynamic timer.`);
      await startDynamicTimer(tabId, state);
    }
  }
});

// Clean up alarms and configuration when a tab is discarded or closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_state_${tabId}`);
  await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
});

// Launch extension interface in a dedicated floating panel
chrome.action.onClicked.addListener((tab) => {
  chrome.windows.create({
    url: `popup.html?tabId=${tab.id}`,
    type: 'popup',
    width: 340,
    height: 480
  });
});

// Self-heal active tabs on service worker startup
async function selfHealActiveTabs() {
  try {
    const allStorage = await chrome.storage.local.get(null);
    for (const key of Object.keys(allStorage)) {
      if (key.startsWith('tab_state_')) {
        const tabId = parseInt(key.replace('tab_state_', ''), 10);
        const state = allStorage[key];
        if (state && state.enabled) {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab) {
              console.log(`[Cadence] Startup: Restoring timer/alarms for tab ${tabId}.`);
              await startDynamicTimer(tabId, state);
              await setupAlarmForTab(tabId, state);
            }
          } catch (e) {
            // Tab is dead, sweep configuration
            await chrome.storage.local.remove(key);
            await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Cadence] Self-healing restoration failed:', err);
  }
}

// Run self-healing routine immediately
selfHealActiveTabs();

/**
 * content.js
 * 
 * Cadence Auto-Refresher Injected Script
 * Runs inside the context of the webpage. Handles high-resolution sub-minute timers,
 * targeted DOM element fetching and replacement, and dropdown emulation (Component Refresh)
 * for visa booking portals like AVITS (usvisaappt.com).
 */

// ============================================================================
// State & Configuration
// ============================================================================

let localTimer = null;
let currentTabState = null;

// ============================================================================
// Dropdown Simulation & Component Refresh Logic (AVITS Mode)
// ============================================================================

/**
 * Simulates a user selecting an option in a dropdown to trigger AJAX reloading.
 * It temporarily toggles the selection to trigger the page's event handlers.
 * @param {string} selector - CSS Selector for the dropdown element.
 */
async function simulateDropdownInteraction(selector) {
  const dropdown = document.querySelector(selector);
  if (!dropdown) {
    console.warn(`[Cadence] Dropdown not found with selector: ${selector}`);
    return;
  }

  const options = dropdown.options;
  if (!options || options.length <= 1) {
    // If there's only one or no option, just trigger change events on it
    triggerElementEvents(dropdown);
    return;
  }

  const originalIndex = dropdown.selectedIndex;
  
  // Find a different index to toggle to
  const temporaryIndex = originalIndex === 0 ? 1 : 0;

  try {
    // Step 1: Change to temporary option to fire "change"
    dropdown.selectedIndex = temporaryIndex;
    triggerElementEvents(dropdown);

    // Give the page's native scripts 250ms to process the first change
    await new Promise(resolve => setTimeout(resolve, 250));

    // Step 2: Re-select the original option to trigger the desired dates refresh
    dropdown.selectedIndex = originalIndex;
    triggerElementEvents(dropdown);
  } catch (err) {
    console.error(`[Cadence] Error during dropdown simulation:`, err);
  }
}

/**
 * Dispatches input, change, and click events to make sure framework-level
 * state managers (React, Vue, jQuery) pick up the modification.
 * @param {HTMLElement} element 
 */
function triggerElementEvents(element) {
  const eventOptions = { bubbles: true, cancelable: true };
  
  // Dispatch typical form events
  element.dispatchEvent(new Event('focus', eventOptions));
  element.dispatchEvent(new Event('input', eventOptions));
  element.dispatchEvent(new Event('change', eventOptions));
  
  // React-specific input/select value tracking bypass
  const tracker = element._valueTracker;
  if (tracker) {
    tracker.setValue(element.value);
  }
  
  element.dispatchEvent(new Event('blur', eventOptions));
}

// ============================================================================
// Content Swap / DOM Replacement Logic
// ============================================================================

/**
 * Performs a background fetch of the current URL, parses the new DOM,
 * and swaps target components or the body element.
 * @param {string} containerSelector - Element to replace (optional).
 */
async function performContentSwap(containerSelector) {
  try {
    console.log('[Cadence] Starting content-only page fetch...');
    const response = await fetch(window.location.href, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const htmlText = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    if (containerSelector) {
      const target = document.querySelector(containerSelector);
      const source = doc.querySelector(containerSelector);
      if (target && source) {
        target.innerHTML = source.innerHTML;
        console.log(`[Cadence] Successfully swapped container: ${containerSelector}`);
      } else {
        console.warn(`[Cadence] Targeted container selector not found on page: ${containerSelector}`);
      }
    } else {
      // Default fallback: swap the main body element
      document.body.innerHTML = doc.body.innerHTML;
      console.log('[Cadence] Swapped full body DOM content successfully.');
    }
  } catch (error) {
    console.error('[Cadence] Content swap failed:', error);
  }
}

// ============================================================================
// Message Routing & Local Timer Management
// ============================================================================

/**
 * Configures the high-precision local timer for sub-minute intervals.
 */
function scheduleNextTick(intervalSeconds) {
  clearTimeout(localTimer);
  
  // Local high-precision timers are only run for intervals under 1 minute.
  // Values >= 60 seconds are managed natively by service worker alarms to conserve memory.
  if (intervalSeconds >= 60) return;

  localTimer = setTimeout(() => {
    // Only send the tick to trigger a refresh if the user isn't hovering the target area
    if (isUserHoveringRefreshArea) {
      console.log('[Cadence] Tick skipped: User is hovering in the refresh area.');
      // Postpone: schedule another check in 1 second
      scheduleNextTick(1);
    } else {
      chrome.runtime.sendMessage({ action: 'SUB_MINUTE_TICK' });
    }
  }, intervalSeconds * 1000);
}

// Listen for messages from background.js or popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TRIGGER_CONTENT_REFRESH') {
    if (isUserHoveringRefreshArea) {
      console.log('[Cadence] Content refresh blocked: user hovering container.');
      sendResponse({ success: false, reason: 'hovering' });
      return;
    }
    
    if (message.mode === 'content') {
      performContentSwap(message.dateContainerSelector);
    } else if (message.mode === 'component') {
      simulateDropdownInteraction(message.dropdownSelector);
    }
    sendResponse({ success: true });
    
    // Re-attach hover monitoring listeners if elements were replaced
    setTimeout(attachHoverListeners, 500);
  }

  if (message.action === 'CHECK_CAN_REFRESH') {
    sendResponse({ 
      canRefresh: !isUserHoveringRefreshArea, 
      reason: isUserHoveringRefreshArea ? 'hovering' : 'ready' 
    });
  }

  if (message.action === 'SYNC_TIMER') {
    currentTabState = message.state;
    attachHoverListeners();
    if (currentTabState && currentTabState.enabled && currentTabState.interval < 60) {
      scheduleNextTick(currentTabState.interval);
    } else {
      clearTimeout(localTimer);
    }
    sendResponse({ success: true });
  }

  if (message.action === 'STOP_TIMER') {
    clearTimeout(localTimer);
    sendResponse({ success: true });
  }
});

// ============================================================================
// User Action Monitoring & Dynamic Pausing
// ============================================================================

let isUserHoveringRefreshArea = false;

/**
 * Attaches hover listeners to the date container to pause refresh while user works.
 */
function attachHoverListeners() {
  if (!currentTabState || !currentTabState.dateContainerSelector || !currentTabState.enabled) {
    removeFloatingStatusBadge();
    return;
  }
  
  const container = document.querySelector(currentTabState.dateContainerSelector);
  if (!container) return;

  if (container.dataset.cadenceHoverBound) return;
  container.dataset.cadenceHoverBound = 'true';

  container.addEventListener('mouseenter', () => {
    isUserHoveringRefreshArea = true;
    showFloatingStatusBadge(container, true);
  });

  container.addEventListener('mouseleave', () => {
    isUserHoveringRefreshArea = false;
    showFloatingStatusBadge(container, false);
  });
}

/**
 * Render a tiny floating status badge inside the monitored container.
 */
function showFloatingStatusBadge(container, show) {
  let badge = document.getElementById('cadence-status-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'cadence-status-badge';
    badge.style.position = 'absolute';
    badge.style.top = '8px';
    badge.style.right = '8px';
    badge.style.backgroundColor = '#000000';
    badge.style.color = '#ffffff';
    badge.style.border = '1px solid #ffffff';
    badge.style.padding = '3px 6px';
    badge.style.fontFamily = 'monospace';
    badge.style.fontSize = '8px';
    badge.style.fontWeight = 'bold';
    badge.style.zIndex = '9999';
    badge.style.letterSpacing = '0.05em';
    badge.style.pointerEvents = 'none';
  }

  if (show && container) {
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    badge.textContent = 'CADENCE: REFRESH PAUSED (HOVERING)';
    container.appendChild(badge);
  } else {
    removeFloatingStatusBadge();
  }
}

function removeFloatingStatusBadge() {
  const badge = document.getElementById('cadence-status-badge');
  if (badge) badge.remove();
}

/**
 * Render a fixed notification alert when auto-refresh is fully deactivated by page action.
 */
function showStoppedNotification() {
  const note = document.createElement('div');
  note.style.position = 'fixed';
  note.style.bottom = '24px';
  note.style.right = '24px';
  note.style.backgroundColor = '#000000';
  note.style.color = '#ffffff';
  note.style.border = '1.5px solid #ffffff';
  note.style.padding = '10px 16px';
  note.style.fontFamily = 'monospace';
  note.style.fontSize = '10px';
  note.style.fontWeight = 'bold';
  note.style.letterSpacing = '0.05em';
  note.style.zIndex = '100000';
  note.textContent = 'CADENCE: AUTO-REFRESH STOPPED';
  
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 2500);
}

// Listen for global clicks on the page to permanently deactivate auto-refresh
document.addEventListener('click', (event) => {
  if (!currentTabState || !currentTabState.enabled) return;

  const target = event.target;
  const isInteractive = target.closest('button, input, select, a, .day-tile, [role="button"]');
  const isInsideContainer = currentTabState.dateContainerSelector && target.closest(currentTabState.dateContainerSelector);

  if (isInteractive || isInsideContainer) {
    console.log('[Cadence] User click detected. Requesting auto-refresh termination.');
    isUserHoveringRefreshArea = false;
    removeFloatingStatusBadge();
    
    chrome.runtime.sendMessage({ action: 'STOP_REFRESH' }, (res) => {
      currentTabState.enabled = false;
      showStoppedNotification();
    });
  }
});

// Auto-initialize if state was already active on full reloads
(async () => {
  try {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.state) {
        currentTabState = response.state;
        attachHoverListeners();
        if (currentTabState.enabled && currentTabState.interval < 60) {
          scheduleNextTick(currentTabState.interval);
        }
      }
    });
  } catch (e) {
    // Context invalidated error might occur if extension was reloaded, suppress.
  }
})();

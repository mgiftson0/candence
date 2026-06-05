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
    chrome.runtime.sendMessage({ action: 'SUB_MINUTE_TICK' });
  }, intervalSeconds * 1000);
}

// Listen for messages from background.js or popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TRIGGER_CONTENT_REFRESH') {
    if (message.mode === 'content') {
      performContentSwap(message.dateContainerSelector);
    } else if (message.mode === 'component') {
      simulateDropdownInteraction(message.dropdownSelector);
    }
    sendResponse({ success: true });
  }

  if (message.action === 'SYNC_TIMER') {
    currentTabState = message.state;
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

// Auto-initialize if state was already active on full reloads
(async () => {
  try {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.state) {
        currentTabState = response.state;
        if (currentTabState.enabled && currentTabState.interval < 60) {
          scheduleNextTick(currentTabState.interval);
        }
      }
    });
  } catch (e) {
    // Context invalidated error might occur if extension was reloaded, suppress.
  }
})();

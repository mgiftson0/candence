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
 * Runs inside the main page world context to access page-level jQuery/React/etc.
 * @param {string} selector - CSS Selector for the dropdown element.
 */
async function simulateDropdownInteraction(selector) {
  const dropdown = document.querySelector(selector);
  if (!dropdown) {
    console.warn(`[Cadence] Dropdown not found with selector: ${selector}`);
    return;
  }

  // Handle Angular Material mat-select dropdowns
  const isMatSelect = dropdown.tagName.toLowerCase() === 'mat-select' || dropdown.closest('mat-form-field');
  if (isMatSelect) {
    console.log('[Cadence] Detected Angular Material dropdown. Initiating click simulation sequence...');
    triggerMatSelectSimulation(selector);
    return;
  }

  const originalIndex = dropdown.selectedIndex;
  if (originalIndex === undefined || originalIndex === -1) {
    // If not a native select or mat-select, click in the main world
    triggerEventsInMainWorld(selector);
    return;
  }

  const options = dropdown.options;
  if (!options || options.length <= 1) {
    triggerEventsInMainWorld(selector, originalIndex);
    return;
  }

  const temporaryIndex = originalIndex === 0 ? 1 : 0;

  try {
    // Step 1: Change to temporary option to fire change handlers
    triggerEventsInMainWorld(selector, temporaryIndex);

    // Give the page scripts 250ms to process the first change
    await new Promise(resolve => setTimeout(resolve, 250));

    // Step 2: Re-select the original option to fetch the desired dates
    triggerEventsInMainWorld(selector, originalIndex);
  } catch (err) {
    console.error(`[Cadence] Error during main-world dropdown simulation:`, err);
  }
}

/**
 * Triggers Angular Material's custom mat-select dropdown options sequence
 * directly inside the Main World context.
 */
function triggerMatSelectSimulation(selector) {
  const scriptContent = `
    (async function() {
      // Find mat-select (if selector targets form field, search inside it)
      let matSelect = document.querySelector('${selector.replace(/'/g, "\\'")}');
      if (matSelect && matSelect.tagName.toLowerCase() !== 'mat-select') {
        matSelect = matSelect.querySelector('mat-select') || matSelect;
      }
      if (!matSelect) return;

      // 1. Click the mat-select element to open its overlay
      matSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      matSelect.click();
      
      // Wait for Angular overlay to render
      await new Promise(r => setTimeout(r, 200));

      const options = document.querySelectorAll('mat-option, .mat-option');
      if (options.length === 0) return;

      // Find the currently active selection index
      let selectedIndex = -1;
      options.forEach((opt, idx) => {
        if (opt.classList.contains('mat-selected') || opt.getAttribute('aria-selected') === 'true') {
          selectedIndex = idx;
        }
      });

      // Toggle to a different option to trigger value change, then toggle back
      const tempIndex = selectedIndex === 0 ? 1 : 0;
      if (options[tempIndex]) {
        // Select temporary option
        options[tempIndex].click();
        
        // Wait for dynamic component to process
        await new Promise(r => setTimeout(r, 200));

        // Re-open select
        matSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        matSelect.click();
        
        await new Promise(r => setTimeout(r, 200));

        // Re-select original option
        const freshOptions = document.querySelectorAll('mat-option, .mat-option');
        if (freshOptions[selectedIndex]) {
          freshOptions[selectedIndex].click();
        }
      } else {
        // Fallback: if only 1 option exists, just click it
        options[0].click();
      }
    })();
  `;

  const script = document.createElement('script');
  script.textContent = scriptContent;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

/**
 * Injects a script to execute event dispatches in the main page world.
 * This successfully triggers page-level handlers (e.g. jQuery, React, Angular).
 */
function triggerEventsInMainWorld(selector, selectedIndex) {
  const indexArg = selectedIndex !== undefined ? selectedIndex : 'undefined';
  
  const scriptContent = `
    (function() {
      const element = document.querySelector('${selector.replace(/'/g, "\\'")}');
      if (!element) return;
      
      if (${indexArg} !== undefined && element.options && element.options.length > ${indexArg}) {
        element.selectedIndex = ${indexArg};
      }
      
      const eventOptions = { bubbles: true, cancelable: true };
      
      // Dispatch standard DOM events
      element.dispatchEvent(new Event('focus', eventOptions));
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));
      element.dispatchEvent(new Event('input', eventOptions));
      element.dispatchEvent(new Event('change', eventOptions));
      
      // Bypass React state tracking if present
      const tracker = element._valueTracker;
      if (tracker) {
        tracker.setValue(element.value);
      }
      
      // Trigger jQuery change handlers if present
      if (typeof window.jQuery !== 'undefined') {
        window.jQuery(element).trigger('change');
      }
      
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new Event('blur', eventOptions));
    })();
  `;

  const script = document.createElement('script');
  script.textContent = scriptContent;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
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
// Element Picker — Visual Click-to-Select Tool
// Activated by popup when user clicks a PICK button. Highlights hovered elements
// with a black border overlay and generates a unique CSS selector on click.
// ============================================================================

let pickerActive = false;
let pickerHighlightEl = null;
const PICKER_OVERLAY_ID = 'cadence-picker-overlay';

/**
 * Generates the most specific unique CSS selector possible for an element.
 * Prefers id, then class combinations, falling back to nth-child paths.
 */
function buildSelector(el) {
  if (!el || el === document.body) return 'body';

  const parts = [];
  let current = el;

  while (current && current !== document.body && current.nodeType === 1) {
    let part = current.tagName.toLowerCase();

    if (current.id) {
      // id is unique — stop traversing, this is sufficient
      parts.unshift(`#${current.id}`);
      break;
    }

    // Angular Material custom element tags (e.g. mat-select, mat-form-field)
    // are descriptive enough on their own; add class context if present
    const meaningfulClasses = [...current.classList]
      .filter(c => !c.startsWith('ng-') && !c.startsWith('cdk-') && c.length < 30)
      .slice(0, 2);

    if (meaningfulClasses.length > 0) {
      part += '.' + meaningfulClasses.join('.');
    } else {
      // nth-child fallback for non-identifiable elements
      const siblings = [...(current.parentElement?.children || [])];
      const idx = siblings.indexOf(current) + 1;
      part += `:nth-child(${idx})`;
    }

    parts.unshift(part);
    current = current.parentElement;

    // Stop at 4 levels to keep selector practical
    if (parts.length >= 4) break;
  }

  return parts.join(' > ');
}

function showPickerOverlay(el) {
  removePickerOverlay();
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.id = PICKER_OVERLAY_ID;
  Object.assign(overlay.style, {
    position: 'fixed',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: '2px solid #000000',
    background: 'rgba(0,0,0,0.08)',
    zIndex: '2147483646',
    pointerEvents: 'none',
    boxSizing: 'border-box',
    transition: 'all 0.1s ease'
  });

  // Label badge showing the generated selector
  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute',
    bottom: '100%',
    left: '0',
    background: '#000000',
    color: '#ffffff',
    fontFamily: 'monospace',
    fontSize: '9px',
    padding: '2px 6px',
    whiteSpace: 'nowrap',
    maxWidth: '320px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    pointerEvents: 'none'
  });
  label.textContent = buildSelector(el);
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  pickerHighlightEl = el;
}

function removePickerOverlay() {
  const existing = document.getElementById(PICKER_OVERLAY_ID);
  if (existing) existing.remove();
  pickerHighlightEl = null;
}

function onPickerMouseOver(e) {
  e.stopPropagation();
  showPickerOverlay(e.target);
}

function onPickerClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const selector = buildSelector(e.target);
  stopPicker();

  // Write result to storage — popup listens via chrome.storage.onChanged,
  // which is reliable across window focus states unlike sendMessage.
  chrome.storage.local.set({
    cadence_picker_result: { selector, ts: Date.now() }
  });
}

function onPickerKeyDown(e) {
  if (e.key === 'Escape') stopPicker();
}

function startPicker() {
  if (pickerActive) return;
  pickerActive = true;
  document.body.style.cursor = 'crosshair';
  document.addEventListener('mouseover', onPickerMouseOver, true);
  document.addEventListener('click', onPickerClick, true);
  document.addEventListener('keydown', onPickerKeyDown, true);
}

function stopPicker() {
  if (!pickerActive) return;
  pickerActive = false;
  document.body.style.cursor = '';
  document.removeEventListener('mouseover', onPickerMouseOver, true);
  document.removeEventListener('click', onPickerClick, true);
  document.removeEventListener('keydown', onPickerKeyDown, true);
  removePickerOverlay();
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

  if (message.action === 'START_PICKER') {
    startPicker();
    sendResponse({ success: true });
  }

  if (message.action === 'STOP_PICKER') {
    stopPicker();
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

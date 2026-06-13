/**
 * popup.js
 * 
 * Cadence Auto-Refresher Popup Controller
 * Manages configuration UI, persists settings per tab, and sends activation/deactivation
 * messages to the service worker background context.
 * 
 * Universal element targeting: pick any element on the page (dropdown, button, 
 * date selector, input, etc.) and Cadence will interact with it on each interval.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Resolve the TARGET tab ID.
  // ──────────────────────────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  let tabId = params.has('tabId') ? parseInt(params.get('tabId'), 10) : null;

  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
    const realTab = tabs.find(t => !t.url.startsWith('chrome'));
    if (realTab) tabId = realTab.id;
  }

  if (!tabId) return;

  const popupWindowId = (await chrome.windows.getCurrent()).id;

  // DOM Elements
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const modeButtons = document.querySelectorAll('.mode-btn');
  const selectorConfig = document.getElementById('selector-config');
  const targetSelectorInput = document.getElementById('target-selector');
  const watchZoneSelectorInput = document.getElementById('watch-zone-selector');
  const groupTargetSelector = document.getElementById('group-target-selector');
  const groupInteractionType = document.getElementById('group-interaction-type');
  const groupWatchZone = document.getElementById('group-watch-zone');
  const interactionButtons = document.querySelectorAll('.interaction-btn');
  const targetHint = document.getElementById('target-hint');
  const intervalButtons = document.querySelectorAll('.interval-btn');
  const customBtn = document.getElementById('custom-btn');
  const customIntervalWrapper = document.getElementById('custom-interval-wrapper');
  const customSecondsInput = document.getElementById('custom-seconds');
  const triggerOnceBtn = document.getElementById('trigger-once-btn');
  const masterToggle = document.getElementById('master-toggle');
  const pickTargetBtn = document.getElementById('pick-target-btn');
  const pickWatchBtn = document.getElementById('pick-watch-btn');

  // Default Local State
  let state = {
    enabled: false,
    mode: 'full',          // 'full', 'content', 'component'
    interval: 10,           // seconds
    targetSelector: '',     // the element to interact with
    watchZoneSelector: '',  // hover-pause area (optional)
    interactionType: 'auto', // 'auto', 'toggle', 'click'
    lastRefresh: null
  };

  // ============================================================================
  // UI Sync
  // ============================================================================

  function updateUI() {
    // Status
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

    // Mode buttons
    modeButtons.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === state.mode);
    });

    // Show/hide configuration panel
    if (state.mode === 'content') {
      selectorConfig.classList.remove('hidden');
      groupTargetSelector.classList.add('hidden');
      groupInteractionType.classList.add('hidden');
      groupWatchZone.classList.remove('hidden');
    } else if (state.mode === 'component') {
      selectorConfig.classList.remove('hidden');
      groupTargetSelector.classList.remove('hidden');
      groupInteractionType.classList.remove('hidden');
      groupWatchZone.classList.remove('hidden');
    } else {
      selectorConfig.classList.add('hidden');
    }

    // Inputs
    targetSelectorInput.value = state.targetSelector || '';
    watchZoneSelectorInput.value = state.watchZoneSelector || '';

    // Interaction type buttons
    interactionButtons.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-interaction') === state.interactionType);
    });

    // Interval buttons
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

  // Interaction Type Selection
  interactionButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.interactionType = btn.getAttribute('data-interaction');
      updateUI();
      saveAndSyncIfNeeded();
    });
  });

  // Selector input changes
  targetSelectorInput.addEventListener('input', () => {
    state.targetSelector = targetSelectorInput.value;
    saveAndSyncIfNeeded();
  });
  watchZoneSelectorInput.addEventListener('input', () => {
    state.watchZoneSelector = watchZoneSelectorInput.value;
    saveAndSyncIfNeeded();
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

  // Custom Interval
  customBtn.addEventListener('click', () => {
    customBtn.classList.add('active');
    customIntervalWrapper.classList.remove('hidden');
    intervalButtons.forEach(btn => btn.classList.remove('active'));
    state.interval = parseInt(customSecondsInput.value, 10) || 10;
    saveAndSyncIfNeeded();
  });

  customSecondsInput.addEventListener('input', () => {
    state.interval = parseInt(customSecondsInput.value, 10) || 5;
    if (state.interval < 5) state.interval = 5;
    saveAndSyncIfNeeded();
  });

  // ============================================================================
  // Element Picker (DevTools-style, all frames)
  // ============================================================================

  let activePicker = null; // 'target' | 'watch' | null

  function injectPicker() {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (window.__cadencePickerActive) return;
        window.__cadencePickerActive = true;

        const OVERLAY_ID = '__cadence_picker_overlay';

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

        /** Detect the element type for display in the overlay label */
        function describeElement(el) {
          const tag = el.tagName.toLowerCase();
          if (tag === 'mat-select' || el.closest('mat-form-field')?.querySelector('mat-select')) return 'MAT-SELECT';
          if (tag === 'select') return 'SELECT';
          if (tag === 'button' || el.getAttribute('role') === 'button') return 'BUTTON';
          if (tag === 'a') return 'LINK';
          if (tag === 'input') return 'INPUT:' + (el.type || 'text').toUpperCase();
          if (tag === 'mat-datepicker-toggle' || el.closest('mat-datepicker-toggle')) return 'DATEPICKER';
          if (tag.startsWith('mat-')) return tag.toUpperCase();
          return tag.toUpperCase();
        }

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
          const lbl = document.createElement('div');
          Object.assign(lbl.style, {
            position: 'absolute', bottom: '100%', left: '0',
            background: '#000', color: '#fff', fontFamily: 'monospace',
            fontSize: '10px', padding: '2px 6px', whiteSpace: 'nowrap',
            maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis',
            pointerEvents: 'none', borderRadius: '2px 2px 0 0'
          });
          const type = describeElement(el);
          lbl.textContent = `[${type}] ${buildSelector(el)}`;
          ov.appendChild(lbl);
          document.body.appendChild(ov);
        }

        function removeOverlay() {
          const ex = document.getElementById(OVERLAY_ID);
          if (ex) ex.remove();
        }

        function onMove(e) { showOverlay(e.target); }

        function onClick(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          const el = e.target;
          const selector = buildSelector(el);
          const elementType = describeElement(el);
          cleanup();
          chrome.storage.local.set({
            cadence_picker_result: { selector, elementType, ts: Date.now() }
          });
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

        document.body.style.cursor = 'crosshair';
        document.addEventListener('mouseover', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
      }
    });
  }

  function injectPickerStop() {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (!window.__cadencePickerActive) return;
        window.__cadencePickerActive = false;
        document.body.style.cursor = '';
        const ov = document.getElementById('__cadence_picker_overlay');
        if (ov) ov.remove();
      }
    }).catch(() => {});
  }

  function startPicker(which) {
    injectPickerStop();
    activePicker = which;
    pickTargetBtn.classList.toggle('active', which === 'target');
    pickWatchBtn.classList.toggle('active', which === 'watch');

    chrome.tabs.update(tabId, { active: true });
    setTimeout(() => injectPicker(), 150);
  }

  pickTargetBtn.addEventListener('click', () => {
    if (activePicker === 'target') {
      activePicker = null;
      pickTargetBtn.classList.remove('active');
      injectPickerStop();
    } else {
      startPicker('target');
    }
  });

  pickWatchBtn.addEventListener('click', () => {
    if (activePicker === 'watch') {
      activePicker = null;
      pickWatchBtn.classList.remove('active');
      injectPickerStop();
    } else {
      startPicker('watch');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Storage-based picker result listener
  // ─────────────────────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.cadence_picker_result || !activePicker) return;

    const { selector, elementType } = changes.cadence_picker_result.newValue;

    if (activePicker === 'target') {
      targetSelectorInput.value = selector;
      state.targetSelector = selector;
      pickTargetBtn.classList.remove('active');
      targetHint.textContent = `Detected: ${elementType}`;
    } else if (activePicker === 'watch') {
      watchZoneSelectorInput.value = selector;
      state.watchZoneSelector = selector;
      pickWatchBtn.classList.remove('active');
    }

    activePicker = null;
    saveAndSyncIfNeeded();

    chrome.storage.local.remove('cadence_picker_result');
    chrome.windows.update(popupWindowId, { focused: true });
  });

  // STATE_UPDATED from background when the page stops refresh
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_UPDATED' && message.tabId === tabId) {
      state = { ...state, ...message.state };
      updateUI();
    }
  });

  // Immediate single refresh
  triggerOnceBtn.addEventListener('click', () => {
    if (state.mode === 'full') {
      chrome.tabs.reload(tabId);
    } else {
      chrome.runtime.sendMessage({
        action: 'TRIGGER_ONCE',
        tabId,
        state: { ...state }
      });
    }
  });

  // Master Activate/Deactivate Toggle
  masterToggle.addEventListener('click', () => {
    if (state.enabled) {
      state.enabled = false;
      chrome.runtime.sendMessage({ action: 'STOP_REFRESH', tabId }, () => {
        updateUI();
      });
    } else {
      state.enabled = true;
      chrome.runtime.sendMessage({ action: 'START_REFRESH', tabId, state }, () => {
        updateUI();
      });
    }
  });

  function saveAndSyncIfNeeded() {
    if (state.enabled) {
      chrome.runtime.sendMessage({ action: 'START_REFRESH', tabId, state });
    } else {
      const key = `tab_state_${tabId}`;
      chrome.storage.local.set({ [key]: state });
    }
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  chrome.runtime.sendMessage({ action: 'GET_STATE', tabId }, (response) => {
    if (response && response.state) {
      state = { ...state, ...response.state };
    }
    updateUI();
  });
});

# Cadence Auto-Refresher

An elegant, editorial-grade Chrome extension that automates tab and component refreshes. Designed with a strict monochromatic color palette and precise geometric structures, `Cadence` is optimized for productivity, research, and keeping visa booking portals (such as the AVITS `usvisaappt.com` portal) refreshed without causing rate limits or session expirations.

---

## Key Features

1. **Full Page Refresh**: Standard automatic page reload.
2. **Content-Only Swap**: Fetches the page in the background and replaces the body content or custom element without a full tab reload.
3. **Component Refresh (AVITS Mode)**: Targets specific dropdown menus (like consulate selects) and dispatches mock events to force the page's native scripts to refresh calendar dates dynamically.
4. **Precision Intervals**: Choose from presets (5s, 10s, 15s, 30s, 1m, 2m, 5m) or define a custom interval down to 5 seconds.
5. **No Telemetry**: Runs entirely locally on your active tab. Zero tracking, analytics, or external calls.

---

## Installation

To install `Cadence` locally in developer mode:

1. Download or clone this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the folder containing `manifest.json`.

---

## How it Works: AVITS & visa booking portals

Many booking sites load dates dynamically after choosing a location from a dropdown menu. Full-page refreshes on these portals are slow, consume large amounts of bandwidth, and can trigger rate-limit blocks (causing temporary lockouts).

`Cadence` includes **Component Mode** to address this:
1. Enter the CSS selector of the dropdown (default: `select#consulate_id`).
2. Enter the container selector of the calendar dates (default: `#calendar-wrapper`).
3. Set the mode to **COMPONENT** and click **ACTIVATE**.
4. Every interval tick, `Cadence` shifts the dropdown selection to clear/re-trigger the handler, selects the original option, and dispatches the necessary `input` and `change` events. This prompts the booking page to request dates updates dynamically without reloading the entire document.

---

## Permissions Breakdown

To maintain maximum privacy, `Cadence` utilizes only the minimum permissions required:

*   `activeTab`: Grants the extension scripting access to the current, user-activated tab only when the popup is open or when auto-refresh is active.
*   `scripting`: Allows injecting helper scripts to perform DOM swaps or event dispatches.
*   `storage`: Used to persist your interval choices and CSS selector preferences per tab.
*   `alarms`: Manages service worker timers in the background so refresh cycles are handled reliably.

---

## Compliance & Policy Note

`Cadence` only automates actions that a user could perform manually (e.g. clicking refresh or selecting option items from a dropdown). It does not bypass security captchas, fill out forms automatically, or make unauthorized API calls. It is designed to run locally on your device within standard browser bounds, aligning with Chrome Extension guidelines and standard fair-use policies.

---

## Contributing

We welcome open-source contributions. To contribute:
1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/cool-update`).
3. Commit your changes.
4. Open a Pull Request.

---

## License

Distributed under the MIT License. See [LICENSE](file:///c:/Users/mgift/OneDrive/Desktop/working%20projects/refresh/LICENSE) for more information.

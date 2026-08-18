# Difframe

English | [日本語](README.ja.md)

A browser extension for pixel-perfect comparison that overlays a reference site or Figma prototype on the page you are building — as an **iframe (a live site, not an image)**. Works in Chrome and Firefox (Manifest V3).

Unlike tools that overlay a static image, Difframe overlays a page that actually runs, so the reference always reflects its latest state and behaves like the real thing, scrolling included.

## Features

- **Size and position controls** — set the overlay's width, height, position (X/Y), opacity, and scale numerically
- **Difference view** — the Difference blend mode (`mix-blend-mode: difference`) sinks matching areas into black, leaving only the misalignments visible
- **Input target switching** — explicitly choose whether scrolls and clicks go to the page or to the overlay
- **Scroll sync** — keeps the page and the overlay aligned by relative offset
- **Presets** — save a URL, opacity, scale, width, height, position, and blend mode as a preset
- **Scope** — choose whether a preset assignment is stored per Tab, per Page, or per Host. The default, Tab, is self-contained, so you can open the same page in two tabs and compare desktop and mobile in parallel. Page takes precedence over Host, so you can apply a preset host-wide while overriding it — or turning it off — on one specific page
- **Image mode** — for sites that cannot be embedded in an iframe, drop an image or paste one with ⌘V and use that as the overlay
- **Figma support** — paste a share link as is and it is converted to the embed URL

## Install

- **Chrome**: [Chrome Web Store](https://chromewebstore.google.com/detail/difframe/egapjkphmifknoefiadlhihfmekkflmh)
- **Firefox**: [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/difframe/)

### Loading the development build

Clone this repository and load it into your browser directly.

- **Chrome**: `chrome://extensions` → turn on "Developer mode" → "Load unpacked" → select this folder
- **Firefox**: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.json`

## Usage

### Basics

1. Open the page you are working on and click the Difframe icon in the toolbar
2. Enter the URL you want to compare against under **Source** and click **Apply**
3. Turn on the toggle in the header to show the overlay
4. Adjust the width, height, position, opacity, and scale (number inputs step by 1px with the arrow keys, 10px with Shift+arrow)
5. Switch the blend mode to **Difference** to inspect the gap (at opacity 1.0, matching areas turn black)

### Comparing desktop and mobile at once

1. Open the page you are comparing in a second tab
2. In the new tab, leaving the scope on **Tab**, add or duplicate a preset and adjust the URL, width, and so on for mobile

A selection made under the Tab scope does not affect other tabs, survives a reload, and disappears when the tab is closed (it applies within the same host only).

## Permissions

- **`<all_urls>` / scripting / activeTab** — to inject the overlay into any page
- **declarativeNetRequest** — to remove the response headers that refuse framing (`X-Frame-Options` / CSP) so the reference page can load inside the overlay iframe. The rule applies **only to subframes in tabs where the overlay is enabled**, so other tabs and normal browsing are never affected. It is removed automatically when the tab is closed
- **storage / unlimitedStorage** — to store presets and pasted images

## License

[MIT](LICENSE)

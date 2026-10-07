# gfn-tizen-desktop

A tiny [TizenBrew](https://github.com/reisxd/TizenBrew) site-modification module that opens the GeForce NOW web client (`play.geforcenow.com`) on a Samsung Tizen TV while presenting itself as desktop Chrome on Windows.

Unofficial and for personal use. Not affiliated with NVIDIA or Samsung. Changing how the browser identifies itself may conflict with the GeForce NOW terms of use. Use at your own risk.

## What it does

- Starts at `play.geforcenow.com/robots.txt` (a small text file on the GFN origin, no GFN scripts), applies the identity there, then loads the GFN web client itself into the same window. GFN detects the platform once at start-up, and TizenBrew injects scripts asynchronously, so this is the only reliable way to be first.
- Overrides `navigator.userAgent`, `userAgentData` (including `getHighEntropyValues`), `platform`, `vendor` and `plugins`, applies the same values inside GFN's blob workers, and hides Samsung's global objects (`tizen`, `webapis`, `TizenTVApiInfo`, …). The real Chromium version is kept.
- If a GFN page is loaded directly and the script arrives too late, restarts it via `robots.txt` (at most three times in two minutes). After a login redirect it first waits until GFN has consumed the OAuth code.
- Shows a diagnostics panel on the TV (**blue** remote button): start mode, GFN's own platform verdict, real and spoofed identity, hidden Tizen traces, WebRTC codecs, gamepads, mouse/key activity (typed characters are never shown) and recent errors.
- Tries to keep the TV screensaver off while the page is open.

It does not modify games, automate input or touch HTTP headers.

## Install

1. Install TizenBrew on the TV.
2. In TizenBrew, open **Module Manager**, choose **Add Module**, select the GitHub type and enter `Julianbjrk/gfn-tizen-desktop@v0.2.0` (latest release tag). Prefer a tag over `@main`, which jsDelivr may serve from cache.
3. Launch **GFN Desktop** from the TizenBrew dashboard.

## Configuration

Edit the `CONFIG` object at the top of `inject.js`:

| Key | Default | Purpose |
|---|---|---|
| `spoof` | `true` | Present as Chrome on Windows |
| `hideTizenGlobals` | `true` | Hide `tizen`, `webapis`, `TizenTVApiInfo` and similar globals from the page |
| `spoofWorkers` | `true` | Apply the same identity inside blob workers |
| `bootViaRobots` | `true` | Load GFN from `robots.txt` after the identity is in place |
| `gfnHtmlPath` | `'/mall/'` | Where GFN's `index.html` is served |
| `keepScreenOn` | `true` | Try to disable the TV screensaver |
| `overlay.autoShowMs` | `20000` | Show diagnostics this long after page load (`0` = off) |

## License

MIT

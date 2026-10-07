# gfn-tizen-desktop

A tiny [TizenBrew](https://github.com/reisxd/TizenBrew) site-modification module that opens the GeForce NOW web client (`play.geforcenow.com`) on a Samsung Tizen TV while presenting itself as desktop Chrome on Windows.

Unofficial and for personal use. Not affiliated with NVIDIA or Samsung. Changing how the browser identifies itself may conflict with the GeForce NOW terms of use. Use at your own risk.

## What it does

- Overrides `navigator.userAgent`, `navigator.userAgentData` (including `getHighEntropyValues`), `platform` and `vendor` as soon as TizenBrew injects the script into a new page. The real Chromium major version is kept.
- If the injection arrives after the GFN page has been parsed, reloads it once (per tab) so the cached script can run before the page's own scripts. Never reloads login pages or URLs carrying OAuth parameters.
- Shows a diagnostics panel on the TV (**blue** remote button). The panel lists the spoof status, WebRTC availability, video codecs, connected gamepads, mouse/key activity (typed characters are never shown) and recent errors.
- Draws its own mouse pointer, because the TV shows none inside TizenBrew. It hides after a few idle seconds and while the game has pointer lock.
- Tries to keep the TV screensaver off while the page is open.

It does not modify games, automate input or touch HTTP headers.

## Install

1. Install TizenBrew on the TV.
2. In TizenBrew, open **Module Manager**, choose **Add Module**, select the GitHub type and enter `Julianbjrk/gfn-tizen-desktop@v0.1.3` (latest release tag). Prefer a tag over `@main`, which jsDelivr may serve from cache.
3. Launch **GFN Desktop** from the TizenBrew dashboard.

## Configuration

Edit the `CONFIG` object at the top of `inject.js`:

| Key | Default | Purpose |
|---|---|---|
| `spoof` | `true` | Present as Chrome on Windows |
| `hideTizenGlobals` | `false` | Hide `window.tizen`/`webapis` from the page |
| `trySetHttpUserAgent` | `false` | Also change the HTTP User-Agent via `tizen.websetting` (reloads once) |
| `keepScreenOn` | `true` | Try to disable the TV screensaver |
| `reloadOnceIfLate` | `true` | Reload once if the script was injected after the page was parsed |
| `reloadHosts` | `['play.geforcenow.com']` | Hosts where that reload may happen |
| `cursor.enabled` | `true` | Draw a mouse pointer |
| `cursor.hideAfterMs` | `5000` | Hide the pointer after this long without movement (`0` = never) |
| `overlay.autoShowMs` | `20000` | Show diagnostics this long after page load (`0` = off) |

## License

MIT

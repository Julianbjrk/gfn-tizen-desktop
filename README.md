# gfn-tizen-desktop

A tiny [TizenBrew](https://github.com/reisxd/TizenBrew) site-modification module that opens the GeForce NOW web client (`play.geforcenow.com`) on a Samsung Tizen TV while presenting itself as desktop Chrome on Windows.

Unofficial and for personal use. Not affiliated with NVIDIA or Samsung. Changing how the browser identifies itself may conflict with the GeForce NOW terms of use. Use at your own risk.

## What it does

- Overrides `navigator.userAgent`, `navigator.userAgentData` (including `getHighEntropyValues`), `platform` and `vendor` as soon as TizenBrew injects the script into a new page. The real Chromium major version is kept.
- If the injection arrives after the page has been parsed, reloads the page once (per tab and origin) so the cached script can run before the page's own scripts.
- Shows a diagnostics panel on the TV (**blue** remote button). The panel lists the spoof status, WebRTC availability, video codecs, connected gamepads and recent errors.
- Tries to keep the TV screensaver off while the page is open.

It does not modify games, automate input or touch HTTP headers.

## Install

1. Install TizenBrew on the TV.
2. In TizenBrew, open **Module Manager**, choose **Add Module**, select the GitHub type and enter `Julianbjrk/gfn-tizen-desktop@main`. A release tag such as `@v0.1.0` also works.
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
| `overlay.autoShowMs` | `20000` | Show diagnostics this long after page load (`0` = off) |

## License

MIT

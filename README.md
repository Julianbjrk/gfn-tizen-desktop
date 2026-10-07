# gfn-tizen-desktop

A single-file [TizenBrew](https://github.com/reisxd/TizenBrew) site-modification module that runs the GeForce NOW web client (`play.geforcenow.com`) on a Samsung Tizen TV while presenting itself as desktop Chrome on Windows.

Unofficial and for personal use. Not affiliated with NVIDIA or Samsung. Changing how the browser identifies itself may conflict with the GeForce NOW terms of use. Use at your own risk.

## What it does

- **Starts first.** TizenBrew injects modules asynchronously and GFN detects the platform once at start-up, so the module opens `play.geforcenow.com/robots.txt` (a text file without GFN scripts), applies the identity there and then loads GFN's `index.html` into the same window. A GFN page loaded directly with a late injection is restarted the same way (at most three times in two minutes, never while an OAuth code is in the URL).
- **Desktop identity.** Overrides `navigator.userAgent`, `userAgentData` (including `getHighEntropyValues`), `platform`, `vendor`, `maxTouchPoints` and `plugins`, gives GFN's blob workers the same values, answers `(hover)`/`(pointer)` media queries like a desktop and hides Samsung's globals (`tizen`, `webapis`, `TizenTVApiInfo`, …). The real Chromium version is kept.
- **Pointer-lock keeper** (green button toggles it). GFN's SDK requests pointer lock again whenever the game shows or hides its cursor, because it only wants `unadjustedMovement` while the cursor is hidden. Games such as World of Warcraft hide the cursor the moment a drag starts. Samsung's engine turns that request into unlock + relock, and the unlock releases the held mouse button, so every drag ended after about 60 ms. While the stream video already holds the lock, the module answers "locked" itself and the native lock is never touched. Native drag-and-drop and text selection are suppressed while streaming.
- **4K override** (red button toggles it; stored in `localStorage`, applied on the next start). In browsers GFN only offers 3840×2160 for H265/AV1 and only with its `force4kbrowser` flag. The module hooks GFN's webpack runtime, wraps the Ragnarok SDK's module factory (nothing runs early) and, when GFN first imports the SDK, calls `ConfigureRagnarokSettings({ overrideData: 'codeclist=<H265|AV1>,H264&force4kbrowser=1' })` with the first codec the TV's WebRTC offers. The user then picks *Custom → 3840×2160* in GFN's settings. The panel's *SDK-lägen* line shows whether the SDK now lists 3840×2160; whether GFN's settings offer it also depends on the resolutions NVIDIA's server entitles for the browser client. GFN's SDK logs its settings, so the override is visible in NVIDIA's client logs.
- **Diagnostics panel** (blue button): start mode, GFN's own platform verdict (via the SDK), live stream statistics from `RTCPeerConnection.getStats()` (resolution, fps, codec, RTT, jitter buffer, decode time, drops), the SDK's supported modes, mouse state with the last raw button and lock events, pointer-lock results, gamepads, real and spoofed identity, hidden Tizen traces and a de-duplicated log. Typed characters, element text and form values are never shown.

Mouse support itself needs TizenBrew to be packaged with `<tizen:setting pointing-device-support="enable"/>`; Samsung disables the pointer for apps that do not declare it (2021+ models).

## Install

1. Install TizenBrew on the TV.
2. In TizenBrew, open **Module Manager**, choose **Add Module**, select the GitHub type and enter `Julianbjrk/gfn-tizen-desktop@v0.3.1` (latest release tag). Prefer a tag over `@main`, which jsDelivr may serve from cache.
3. Launch **GFN Desktop** from the TizenBrew dashboard.

Remote buttons while GFN Desktop runs: **blue** shows or hides the panel, **red** toggles the 4K override, **green** toggles the pointer-lock keeper (for comparison only; leave it on).

## Configuration

Edit the `CONFIG` object at the top of `inject.js`:

| Key | Default | Purpose |
|---|---|---|
| `spoof` | `true` | Present as Chrome on Windows |
| `hideTizenGlobals` | `true` | Hide `tizen`, `webapis`, `TizenTVApiInfo` and similar globals |
| `spoofWorkers` | `true` | Same identity inside blob workers |
| `spoofPointerMedia` | `true` | Desktop answers for `(hover)` and `(pointer)` media queries |
| `bootViaRobots` | `true` | Load GFN from `robots.txt` after the identity is in place |
| `mouse.keepLock` | `true` | Answer GFN's re-lock requests while the stream already holds pointer lock |
| `mouse.blockNativeDrag` | `true` | Suppress drag-and-drop and text selection while streaming |
| `force4k.preferred` | `['H265', 'AV1']` | Codec order for the 4K override |
| `overlay.autoShowMs` | `20000` | Show the panel this long after page load (`0` = off) |

## License

MIT

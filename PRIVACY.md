# Privacy Policy — EqualLoud

**Effective date:** 2026-06-18

EqualLoud is a browser extension that automatically balances the loudness of
audio/video tabs. This policy explains, in plain language, what data the
extension can access and what it does with it.

## TL;DR

**EqualLoud processes audio entirely on your device. It does not collect,
transmit, or sell any personal data.** There are no analytics, no telemetry,
no trackers, and no third-party servers involved in its operation.

## What EqualLoud does

The extension injects a content script into web pages so it can attach a Web
Audio graph to each `<video>` / `<audio>` element, measure its loudness (using
the ITU-R BS.1770 K-weighting algorithm), and apply a gain adjustment so every
tab converges to one target loudness. All of this happens locally in your
browser.

## Permissions and why each is required

| Permission | Why it's needed |
|---|---|
| `host_permissions: <all_urls>` | So balancing works automatically on every site, without per-site enablement. The content script must run on the page to reach its media elements. **No page content is read or transmitted** — only the audio stream is measured locally. |
| `tabs` | To list open tabs in the popup and show their titles. Tab titles and URLs stay in local memory and are shown only to you in the popup. |
| `storage` | To remember your settings (target loudness, limiter config, UI locale) across browser restarts. Stored only in `chrome.storage.local` on your device. |
| `alarms` | A periodic housekeeping timer that prunes closed tabs and recovers state after the service worker sleeps. |
| `favicon` (Chrome 118+) | Displays each tab's website icon in the popup. Served from Chrome's **local** favicon cache via the `_favicon/` API — no network request to the site or any third party. |

## Data handling specifics

- **Audio:** Processed in real time by the browser's Web Audio API. Audio
  samples are never stored, logged, or sent anywhere. The loudness numbers
  exist only transiently in memory to drive the gain decision.
- **Tab information (title, URL, favicon):** Held in the extension's memory
  only while the popup is open or the service worker is active. Not persisted,
  not transmitted.
- **Settings:** Stored locally via `chrome.storage.local`. Never leave your
  device.
- **Favicons:** Before v1.1.0 the popup fetched favicons from
  `google.com/s2/favicons`, which exposed the domains of your open tabs to
  Google. **This was removed in v1.1.0** — favicons now come from Chrome's
  local cache with zero network egress.

## What EqualLoud does NOT do

- ❌ No analytics or usage tracking.
- ❌ No crash reporting that sends data off-device.
- ❌ No advertising or ad SDKs.
- ❌ No collection of personal information.
- ❌ No communication with any server. The extension has no backend.
- ❌ No sale or sharing of data with third parties.

## Children's privacy

EqualLoud does not knowingly collect any data from anyone, including children
under 13. It is a general-purpose utility with no audience-targeting features.

## Changes to this policy

Material changes will be reflected in this file and noted in `CHANGELOG.md`.
The extension version (`__APP_VERSION__`, visible in the popup footer) tracks
the code this policy applies to.

## Source code

EqualLoud is open source. You can audit every claim above at
[github.com/mzaxd/EqualLoud](https://github.com/mzaxd/EqualLoud).

## Contact

Open an issue at the GitHub repository above for any privacy questions.

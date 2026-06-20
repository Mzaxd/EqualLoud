import { defineManifest } from '@crxjs/vite-plugin'

// Plain JSON import (no import-attribute syntax) so this works under any
// tsconfig.module setting. resolveJsonModule is on in the root config, and
// Vite/Rollup natively import JSON at build time. CRXJS evaluates this file in
// Node, so `pkg.version` is read at build time — never at runtime in the SW.
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'EqualLoud',
  // Stays under the CWS 132-char limit. The privacy clause is intentional:
  // EqualLoud's `host_permissions: <all_urls>` is a sensitive permission, and
  // reviewers skim the description for a data-handling statement. Front-loading
  // "100% on-device, nothing uploaded" short-circuits the most common reason a
  // loudness extension gets bounced or sent to a slower review queue.
  description:
    'Automatically balance loudness across every audio/video tab. 100% on-device: no data is collected, uploaded, or tracked.',
  // Read from package.json directly rather than relying on the
  // `npm_package_version` env var that npm/pnpm inject only when the script is
  // launched through the package manager. A bare `vite build` (e.g. from an
  // editor task) would otherwise ship a manifest with version "0.0.0", which
  // Chrome Web Store rejects and the popup footer would show incorrectly.
  // CRXJS evaluates this file in Node at build time, so the static import is
  // safe and keeps the manifest the single source of version truth.
  version: pkg.version,
  default_locale: 'en',
  // EqualLoud uses `favicon` (118+), `storage.session` (102+),
  // `runtime.onContextInvalidated` (116+) and `navigator.userActivation` (120+).
  // Declaring the floor lets Chrome Web Store reject incompatible browsers up
  // front with a clear message, rather than letting the user install and hit
  // silent failures (dead favicon, missing log mirror, etc.).
  minimum_chrome_version: '120',
  icons: {
    '16': 'logo@16w.png',
    '32': 'logo@32w.png',
    '48': 'logo@48w.png',
    '128': 'logo@128w.png',
  },
  action: {
    default_popup: 'index.html',
    default_icon: {
      '16': 'logo@16w.png',
      '32': 'logo@32w.png',
    },
  },
  // Standalone settings page — the CWS "Extension options" link opens this.
  // Reuses the popup's stores + i18n so the two surfaces stay in sync.
  options_ui: {
    page: 'options.html',
    open_in_tab: true,
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  // The content-script architecture (createMediaElementSource interception)
  // is what makes EqualLoud truly automatic — no tabCapture, no activeTab, no
  // offscreen document, no user click required. host_permissions lets the
  // content script inject into every http(s) page.
  //
  // `favicon` (Chrome 118+) serves tab favicons from Chrome's *local* cache
  // via the `/_favicon/` virtual URL — zero network. Without it the popup
  // would have to fetch each site's favicon over the network (the old
  // google.com/s2/favicons path), which both leaked every open domain to a
  // third party and contradicted the "no data leaves your device" promise.
  permissions: ['storage', 'tabs', 'alarms', 'favicon'],
  host_permissions: ['<all_urls>'],
  // Explicit CSP. MV3 already enforces this default, but declaring it shows
  // intent (CWS reviewers and security scanners look for it), documents the
  // "no remote code, no remote framing" guarantee in the manifest itself, and
  // hardens against any future Chrome-side relaxation of the default. woff2
  // fonts load fine under `style-src 'self'` since font-src governs them.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; frame-src 'none'",
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  // The LUFS AudioWorklet module is fetched at runtime by the content script via
  // audioContext.audioWorklet.addModule(url). That fetch happens in the *page*
  // context, so the worklet file must be web-accessible. CRXJS auto-adds the
  // content-script chunks but NOT this dynamically-resolved ?worker&url asset,
  // so we declare it explicitly. Without this, addModule() throws
  // "Unable to load a worklet's module" and LUFS measurement never runs.
  web_accessible_resources: [
    {
      resources: ['assets/lufs-processor-*.js'],
      matches: ['<all_urls>'],
    },
  ],
})

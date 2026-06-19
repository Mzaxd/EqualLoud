import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'EqualLoud',
  description: 'Automatically balance loudness across all video/audio tabs — install and forget.',
  version: process.env.npm_package_version ?? '0.0.0',
  default_locale: 'en',
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

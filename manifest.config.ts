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
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  // The content-script architecture (createMediaElementSource interception)
  // is what makes EqualLoud truly automatic — no tabCapture, no activeTab, no
  // offscreen document, no user click required. host_permissions lets the
  // content script inject into every http(s) page.
  permissions: ['storage', 'tabs', 'alarms'],
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

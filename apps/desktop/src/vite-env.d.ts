/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WEB_URL?: string;
  readonly VITE_PRODUCTION_URL?: string;
  /** extra browser extension IDs allowed to use Touch ID (comma-separated; e.g. the Chrome Web Store ID) */
  readonly VITE_PV_EXTENSION_IDS?: string;
}

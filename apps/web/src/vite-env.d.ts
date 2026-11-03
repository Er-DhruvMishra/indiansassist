/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_REGION_ORIGINS?: string;
  readonly VITE_APP_NAME?: string;
  /** e2e only (e2e/mobile.config.ts): '1' keeps the `window.__iaOps` test hook; never set for a production build. */
  readonly VITE_E2E_OPS_HOOK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

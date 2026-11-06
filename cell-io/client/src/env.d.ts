interface ImportMetaEnv {
  readonly VITE_SOLO?: string;
  /** Game server URL baked in at build time (e.g. https://cell-io.onrender.com). Empty = same origin. */
  readonly VITE_SERVER_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

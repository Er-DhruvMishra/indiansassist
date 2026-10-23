export declare const ROOT: string;
export declare const DEV_WEB_ORIGINS: string[];
export declare const DEV_CONNECT_SRC: string[];
export type BuildConfig = {
  dev: boolean;
  e2e: boolean;
  regionOrigins: string[];
  apiOverrides: Record<string, string>;
  version: string;
  defaultApiOrigin: string;
  extensionKey: string | null;
};
export declare function parseRegionOriginList(value: string | undefined, dev: boolean): { origins: string[]; problems: string[] };
export declare function buildEnv(env?: Record<string, string | undefined>): BuildConfig;
export declare function defines(cfg: BuildConfig): Record<string, string>;

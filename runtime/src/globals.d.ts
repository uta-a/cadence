// What the runtime may touch on Hermes' global object. lib "es2019" has no DOM or Node types on purpose.
declare var __cadence: { readonly revision: string; readonly features?: readonly string[] } | undefined;
declare var __d: ((...args: unknown[]) => unknown) | undefined;
declare var setTimeout: (callback: () => void, milliseconds: number) => unknown;
declare var clearTimeout: (handle: unknown) => void;
declare const __CADENCE_UI_SMOKE__: boolean;
// Optional React Native host logger. Severity 1 is info; its availability before the bundle is not assumed.
declare var nativeLoggingHook: ((message: string, level: number) => void) | undefined;
declare var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void } | undefined;

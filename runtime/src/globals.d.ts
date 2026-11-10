// What the runtime may touch on Hermes' global object. lib "es2019" has no DOM or Node types on purpose.
declare var __disk: { readonly revision: string } | undefined;
// Optional React Native host logger. Severity 1 is info; its availability before the bundle is not assumed.
declare var nativeLoggingHook: ((message: string, level: number) => void) | undefined;
declare var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void } | undefined;

/** Imported first by index.ts: console output from any library goes to stderr, never into the JSON-RPC stream. */
const toStderr = (...a: unknown[]) => console.error(...a);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

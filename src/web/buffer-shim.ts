// esbuild `inject`: every free `Buffer` in the browser bundle refers to the buffer package.
export { Buffer } from "buffer";

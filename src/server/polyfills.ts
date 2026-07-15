/**
 * Runtime polyfills for JS features newer than the Node.js version pinned in
 * the production Docker image (currently `node:22`).
 *
 * Must be imported first, before any other module, so the polyfill is in
 * place before dependencies that assume a newer runtime get evaluated.
 */

// `Promise.try` landed as an unflagged, stable built-in in Node.js 23
// (V8 13.x) and is NOT available in Node 22. `unpdf` (a transitive
// dependency of `@cognipeer/to-markdown`, used for PDF parsing) calls it
// unconditionally, which crashed the process in production with:
//   TypeError: Promise.try is not a function
//     at unpdf/dist/pdfjs.mjs
if (typeof (Promise as unknown as { try?: unknown }).try !== 'function') {
  (Promise as unknown as { try: <T>(fn: () => T | PromiseLike<T>) => Promise<T> }).try = function try_<T>(
    fn: () => T | PromiseLike<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    });
  };
}

// Chrome refuses a content script that contains a Unicode noncharacter (for example a literal U+FFFE that the
// minifier emitted from a library regex): "Could not load file 'content.js'. It isn't UTF-8 encoded." Every
// emitted script is therefore rewritten as pure ASCII with \u escapes, which mean the same thing inside string
// and regex literals and identifiers (the only places such characters occur in minified output).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function asciiOnly(code) {
  return code.replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Vite / Rolldown plugin: rewrites every written `.js` file of the bundle as ASCII. */
export function asciiPlugin() {
  return {
    name: 'ia-ascii-only',
    writeBundle(options, bundle) {
      for (const [fileName, out] of Object.entries(bundle)) {
        if (out.type !== 'chunk') continue;
        const path = join(options.dir, fileName);
        writeFileSync(path, asciiOnly(readFileSync(path, 'utf8')));
      }
    },
  };
}

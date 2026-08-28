import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CSS = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');

/** Every `src: url("/fonts/…")` declared in index.css. */
function declaredFontUrls(): string[] {
  return [...CSS.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map(m => m[1]);
}

describe('self-hosted fonts (R-G3)', () => {
  it('declares six font files', () => {
    expect(declaredFontUrls()).toHaveLength(6);
  });

  it('every declared font file exists and is not empty', () => {
    for (const url of declaredFontUrls()) {
      const path = resolve(ROOT, 'public', url.replace(/^\//, ''));
      // A missing or truncated font is why this test exists: font-display
      // swap means the app would silently render in Georgia forever with
      // nothing on screen to say the design never loaded.
      expect(() => statSync(path), `${url} is declared in index.css but not present`).not.toThrow();
      expect(statSync(path).size, `${url} is empty`).toBeGreaterThan(1000);
    }
  });

  it('the whole font payload stays inside the 350 KB budget', () => {
    const dir = resolve(ROOT, 'public/fonts');
    const total = readdirSync(dir)
      .filter(f => f.endsWith('.woff2'))
      .reduce((sum, f) => sum + statSync(resolve(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(350 * 1024);
  });

  it('no font is hotlinked from a third-party host, anywhere', () => {
    // The app's own disclosure says nothing leaves this browser except
    // calls to OpenRouter. A <link> to fonts.googleapis.com would make that
    // sentence false on every page view.
    const suspects = [
      readFileSync(resolve(ROOT, 'index.html'), 'utf8'),
      CSS,
    ];
    for (const source of suspects) {
      expect(source).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it('every family declares a real fallback stack', () => {
    expect(CSS).toMatch(/--font-prose:\s*"Newsreader",\s*ui-serif,\s*Georgia/);
    expect(CSS).toMatch(/--font-ui:\s*"Instrument Sans",\s*ui-sans-serif,\s*system-ui/);
    expect(CSS).toMatch(/--font-mono:\s*"IBM Plex Mono",\s*ui-monospace/);
  });
});

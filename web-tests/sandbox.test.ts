import { describe, expect, it } from 'vitest';
import { CSP_META, SANDBOX_CSP, sealHtml } from '../src/lib/sandbox';

describe('sandbox CSP', () => {
  it('denies every network destination by default', () => {
    expect(SANDBOX_CSP).toMatch(/^default-src 'none'/);
    // connect-src, and script/img/frame by URL, all fall back to default-src.
    // The claim in docs/miniapp-capabilities.md is only true because of this.
    expect(SANDBOX_CSP).not.toMatch(/connect-src/);
    expect(SANDBOX_CSP).not.toMatch(/https?:/);
    expect(SANDBOX_CSP).not.toMatch(/\*/);
  });

  it('allows exactly what a self-contained offline document needs', () => {
    expect(SANDBOX_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(SANDBOX_CSP).toContain("style-src 'unsafe-inline'");
    expect(SANDBOX_CSP).toContain('img-src data: blob:');
    // no re-pointing relative URLs, no posting a form out of the frame
    expect(SANDBOX_CSP).toContain("base-uri 'none'");
    expect(SANDBOX_CSP).toContain("form-action 'none'");
  });
});

describe('sealHtml', () => {
  it('injects the policy inside <head> for a full document', () => {
    const out = sealHtml('<!doctype html><html><head><title>t</title></head><body>hi</body></html>');
    expect(out).toContain(CSP_META);
    // the doctype must stay first, or the page silently drops to quirks mode
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out.indexOf(CSP_META)).toBeLessThan(out.indexOf('<title>'));
  });

  it('creates a head when the document has <html> but no <head>', () => {
    const out = sealHtml('<html><body>hi</body></html>');
    expect(out).toContain(`<head>${CSP_META}</head>`);
    expect(out.indexOf(CSP_META)).toBeLessThan(out.indexOf('<body>'));
  });

  it('keeps the policy after a bare doctype', () => {
    const out = sealHtml('<!DOCTYPE html><div>fragment</div>');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out.indexOf(CSP_META)).toBeLessThan(out.indexOf('<div>'));
  });

  it('prepends for a bare fragment', () => {
    expect(sealHtml('<p>hi</p>')).toBe(`${CSP_META}<p>hi</p>`);
  });

  it('always lands the policy before any script the document carries', () => {
    for (const doc of [
      '<!doctype html><html><head></head><body><script>fetch("https://evil")</script></body></html>',
      '<html><body><script>x</script></body></html>',
      '<script>x</script>',
      '<!doctype html><script>x</script>',
    ]) {
      const out = sealHtml(doc);
      expect(out.indexOf(CSP_META)).toBeGreaterThanOrEqual(0);
      expect(out.indexOf(CSP_META)).toBeLessThan(out.indexOf('<script>'));
    }
  });
});

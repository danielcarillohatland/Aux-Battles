import { describe, expect, it } from 'vitest';
import { absoluteShareLinks, publicOrigin } from '../vite.config.js';

const html =
  '<meta property="og:type" content="website" />\n    <meta property="og:image" content="/assets/og-card.png" />';

describe('deploy-time share links', () => {
  it('leaves relative links when no public origin is configured', () => {
    expect(absoluteShareLinks(html, publicOrigin(undefined))).toBe(html);
  });

  it('makes the preview image absolute and adds og:url for the configured origin', () => {
    const out = absoluteShareLinks(html, publicOrigin('https://aux.example.com'));
    expect(out).toContain('content="https://aux.example.com/assets/og-card.png"');
    expect(out).toContain('<meta property="og:url" content="https://aux.example.com/" />');
  });

  it('rejects insecure or path-bearing origins', () => {
    expect(() => publicOrigin('http://aux.example.com')).toThrow('HTTPS');
    expect(() => publicOrigin('https://aux.example.com/game')).toThrow('path');
  });
});

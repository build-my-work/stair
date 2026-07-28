import { describe, expect, it } from 'bun:test';
import {
  applyStairBranding,
  applyStairBrandingToMessages,
  STAIR_COAUTHOR_EMAIL,
} from './stair-branding';

describe('Stair branding', () => {
  it('renames product references without renaming Craft integrations', () => {
    expect(applyStairBranding('Welcome to Craft Agents')).toBe('Welcome to Stair');
    expect(applyStairBranding('Message Craft Agent')).toBe('Message Stair');
    expect(applyStairBranding('Connect to Craft documents')).toBe(
      'Connect to Craft documents',
    );
  });

  it('preserves upstream service names', () => {
    expect(applyStairBranding('Use Craft Agents Backend')).toBe(
      'Use Craft Agents Backend',
    );
    expect(applyStairBranding('Search Craft Agents Docs')).toBe(
      'Search Craft Agents Docs',
    );
  });

  it('uses a Stair co-author identity', () => {
    expect(
      applyStairBranding(
        'Co-Authored-By: Craft Agent <agents-noreply@craft.do>',
      ),
    ).toBe(`Co-Authored-By: Stair <${STAIR_COAUTHOR_EMAIL}>`);
  });

  it('brands message values without changing translation keys', () => {
    const messages = applyStairBrandingToMessages({
      'menu.aboutCraftAgents': 'About Craft Agents',
    });

    expect(messages).toEqual({
      'menu.aboutCraftAgents': 'About Stair',
    });
  });
});

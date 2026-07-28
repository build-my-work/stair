export const STAIR_PRODUCT_NAME = 'Stair';
export const STAIR_COAUTHOR_EMAIL = 'stair@users.noreply.github.com';

const PROTECTED_TERMS = [
  'Craft Agents Backend',
  'Craft Agents Docs',
] as const;

/**
 * Apply Stair's product name at presentation boundaries while preserving
 * upstream service names and technical identifiers.
 */
export function applyStairBranding(value: string): string {
  const protectedValues = new Map<string, string>();
  let branded = value;

  for (const [index, term] of PROTECTED_TERMS.entries()) {
    const token = `__STAIR_PROTECTED_BRAND_${index}__`;
    protectedValues.set(token, term);
    branded = branded.replaceAll(term, token);
  }

  branded = branded
    .replaceAll('agents-noreply@craft.do', STAIR_COAUTHOR_EMAIL)
    .replaceAll('Craft Agents', STAIR_PRODUCT_NAME)
    .replaceAll('Craft Agent', STAIR_PRODUCT_NAME);

  for (const [token, term] of protectedValues) {
    branded = branded.replaceAll(token, term);
  }

  return branded;
}

export function applyStairBrandingToMessages<T extends Record<string, string>>(
  messages: T,
): T {
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      applyStairBranding(value),
    ]),
  ) as T;
}

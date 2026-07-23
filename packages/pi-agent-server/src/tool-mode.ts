export type PiToolMode = 'default' | 'none' | 'tutor-artifact';

export interface PiToolModeCapabilities {
  builtinTools: 'all' | 'read-only' | 'none';
  webTools: boolean;
  proxyTools: boolean;
}

export function getPiToolModeCapabilities(mode: PiToolMode | undefined): PiToolModeCapabilities {
  if (mode === 'none') {
    return { builtinTools: 'none', webTools: false, proxyTools: false };
  }
  if (mode === 'tutor-artifact') {
    return { builtinTools: 'read-only', webTools: false, proxyTools: true };
  }
  return { builtinTools: 'all', webTools: true, proxyTools: true };
}

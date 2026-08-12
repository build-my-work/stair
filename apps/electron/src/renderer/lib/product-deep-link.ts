export function buildProductDeepLink(
  route: string,
  scheme = __APP_DEEP_LINK_SCHEME__,
): string {
  return `${scheme.replace(/:$/u, '')}://${route.replace(/^\/+/, '')}`
}

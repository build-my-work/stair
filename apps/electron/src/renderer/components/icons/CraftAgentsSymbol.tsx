interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * Stair step symbol. The legacy component name keeps upstream imports stable.
 * Uses accent color from theme (currentColor from className)
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 52H20V40H32V28H44V16H56V56H8V52Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  )
}

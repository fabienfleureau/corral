// The Corral mark: a pen (the "C") closed by a gate latch drawn in the
// secondary colour. The tile and both ink colours come from CSS custom
// properties so the light and dark palettes stay in sync; `web/public/favicon.svg`
// draws the same 24-unit geometry at 32px.

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path className="brand-mark-pen" d="M17.5 6.8H10.6A3.6 3.6 0 0 0 7 10.4v3.2a3.6 3.6 0 0 0 3.6 3.6h6.9" />
        <path className="brand-mark-latch" d="M17.5 6.8v5" />
      </svg>
    </span>
  );
}

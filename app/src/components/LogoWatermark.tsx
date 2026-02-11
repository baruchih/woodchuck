/**
 * Large faint Woodchuck logo watermark for background decoration.
 * Centered in the viewport using calc() for precise positioning.
 * v2 - using calc with viewport units
 */
export function LogoWatermark() {
  return (
    <img
      src="/icons/icon.svg"
      alt=""
      style={{
        position: 'fixed',
        top: 'calc(50vh - 9rem)',
        left: 'calc(50vw - 9rem)',
        width: '18rem',
        height: '18rem',
        opacity: 0.2,
        pointerEvents: 'none',
        zIndex: 0,
      }}
      aria-hidden="true"
    />
  );
}

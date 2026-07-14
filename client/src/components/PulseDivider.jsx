// The page's signature element: an ECG-style pulse line. Used once per page,
// beneath the title, as a quiet nod to "vitals" without leaning on medical
// clip-art clichés (stethoscopes, crosses, etc).
export default function PulseDivider() {
  return (
    <div className="pulse-divider" aria-hidden="true">
      <svg viewBox="0 0 600 22" preserveAspectRatio="none">
        <polyline
          points="0,11 220,11 240,11 250,2 260,20 270,4 280,11 300,11 600,11"
          fill="none"
          stroke="#C97B2E"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

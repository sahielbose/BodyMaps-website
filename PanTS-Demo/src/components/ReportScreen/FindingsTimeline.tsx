import React, { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../helpers/motion';
import { findingLabel } from '../../helpers/reportFindings';

interface OrganNode {
  organ: string;
  status: 'normal' | 'check';
}

interface Props {
  organStatuses: OrganNode[];
  comments: string;
  focusedOrgan?: string | null;
  onNodeTap?: (organ: string) => void;
}

// Order organs by where they first appear in the radiologist's comments
// text ("reading order") rather than alphabetically — this makes the
// timeline feel like it's walking through the case the way it was
// actually read, not just listing data.
export function sortByReadingOrder(organStatuses: OrganNode[], comments: string): OrganNode[] {
  const lowerComments = comments.toLowerCase();
  const withIndex = organStatuses.map((node) => {
    const searchTerm = node.organ.replace(/_/g, ' ').split(' ')[0]; // e.g. "kidney_left" -> "kidney"
    const idx = lowerComments.indexOf(searchTerm);
    return { ...node, idx: idx === -1 ? 9999 : idx };
  });
  return withIndex.sort((a, b) => a.idx - b.idx);
}

// Motion here is transform and opacity only, set through classes (not inline
// styles) so the reduced-motion block below can switch it off: the flagged
// node's glow is a halo that scales and fades rather than an animated
// box-shadow, which repainted every frame for as long as the report was open.
const STYLES = `
  @keyframes timelineNodeIn {
    from { opacity: 0; transform: translateY(6px) scale(0.6); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes timelineHaloPulse {
    0%, 100% { opacity: 0.35; transform: scale(1); }
    50% { opacity: 0.8; transform: scale(1.5); }
  }
  @keyframes focusRingPulse {
    0%, 100% { opacity: 0.9; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(1.35); }
  }
  .ft-node { animation: timelineNodeIn 0.4s ease both; }
  .ft-halo { animation: timelineHaloPulse 1.8s ease-in-out infinite; }
  .ft-ring { animation: focusRingPulse 1.6s ease-in-out infinite; }
  /* Two classes deep so it beats the report's white ring on every button. */
  .ft-group .ft-node:focus-visible { outline: 2px solid #fbbf24; outline-offset: 0; border-radius: 8px; }
  @media (prefers-reduced-motion: reduce) {
    .ft-node, .ft-halo, .ft-ring { animation: none !important; }
    .ft-dot, .ft-line { transition: none !important; }
  }
`;

export default function FindingsTimeline({ organStatuses, comments, focusedOrgan, onNodeTap }: Props) {
  const [revealed, setRevealed] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const ordered = sortByReadingOrder(organStatuses, comments);

  // Reveal nodes one at a time, following reading order — gives the
  // sense the AI is "walking through" the case rather than dumping a
  // finished table all at once. With reduced motion they all appear at once.
  useEffect(() => {
    if (ordered.length === 0) return;
    if (prefersReducedMotion()) {
      setRevealed(ordered.length);
      return;
    }
    setRevealed(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    ordered.forEach((_, i) => {
      timers.push(setTimeout(() => setRevealed((r) => Math.max(r, i + 1)), 220 + i * 150));
    });
    return () => timers.forEach(clearTimeout);
  }, [ordered.length]);

  if (ordered.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Findings in reading order"
      className="ft-group"
      style={{
        position: 'fixed', bottom: 76, left: '50%', transform: 'translateX(-50%)',
        zIndex: 10001, pointerEvents: 'auto',
        background: 'rgba(10,12,18,0.6)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(255,255,255,0.08)', borderTop: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 12, padding: '10px 18px',
        display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 0,
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        // The ReportScreen wrapper is a zero-width fixed box and this group is fixed inside it, so
        // the width on offer is 0 and a wrapping row would shrink to its widest single item.
        // max-content gives it its full one-row width; maxWidth is what makes it wrap.
        width: 'max-content', maxWidth: '88vw',
        // A long case wraps onto a second row rather than clipping at the stage edge.
        // NOTE: deliberately no overflowX/Y here — overflow:auto on a flex
        // container clips ANY escaping content (including the hover
        // tooltip, which positions itself above via bottom:100%), even
        // when you only intend to scroll horizontally. Since the node
        // list is short and fits most viewports, we skip scroll affordance
        // entirely rather than reintroduce the clipping bug.
      }}
    >
      <style>{STYLES}</style>
      {/* The label is decoration for the sighted; the group already has its name. */}
      <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.62)', letterSpacing: '0.02em', whiteSpace: 'nowrap', marginRight: 10 }}>
        {ordered.length === 1 ? '1 finding' : `${ordered.length} findings`}
      </span>
      {ordered.map((node, i) => {
        const isVisible = i < revealed;
        const isFlagged = node.status === 'check';
        const isLast = i === ordered.length - 1;
        const isHovered = hovered === node.organ;
        const isFocused = focusedOrgan === node.organ;
        const friendlyName = findingLabel(node.organ);
        const size = isFlagged ? 13 : 8;

        return (
          <React.Fragment key={node.organ}>
            <button
              type="button"
              className={`no-drag${isVisible ? ' ft-node' : ''}`}
              onClick={() => onNodeTap?.(node.organ)}
              onMouseEnter={() => setHovered(node.organ)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(node.organ)}
              onBlur={() => setHovered(null)}
              aria-label={`${friendlyName}, ${isFlagged ? 'finding to review' : 'no finding'}`}
              aria-current={isFocused ? 'step' : undefined}
              tabIndex={isVisible ? 0 : -1}
              style={{
                position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
                cursor: 'pointer', flexShrink: 0,
                minWidth: 32, minHeight: 32,
                // The last button's 32px hit box leaves empty space to the right of its dot, so pull it
                // back by that much and the pill's right inset reads the same as its left.
                padding: 0, margin: isLast ? `0 ${-(32 - size) / 2}px 0 0` : 0, border: 'none', background: 'transparent', font: 'inherit',
                opacity: isVisible ? 1 : 0,
              }}
            >
              {isFocused && (
                <span className="ft-ring" aria-hidden="true" style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: isFlagged ? 26 : 20, height: isFlagged ? 26 : 20,
                  marginLeft: isFlagged ? -13 : -10, marginTop: isFlagged ? -13 : -10,
                  borderRadius: '50%', border: '1.5px solid #fcd34d',
                  pointerEvents: 'none',
                }} />
              )}
              {isFlagged && isVisible && (
                <span className="ft-halo" aria-hidden="true" style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2,
                  borderRadius: '50%', background: 'rgba(251,191,36,0.55)',
                  filter: 'blur(3px)', pointerEvents: 'none',
                }} />
              )}
              <span
                className="ft-dot"
                aria-hidden="true"
                style={{
                  display: 'block',
                  width: size,
                  height: size,
                  borderRadius: '50%',
                  background: isFlagged ? '#fbbf24' : '#34d399',
                  border: isFocused ? '1.5px solid #fcd34d' : '1.5px solid rgba(255,255,255,0.4)',
                  transition: 'transform 0.2s ease',
                  transform: isHovered ? 'scale(1.25)' : 'scale(1)',
                  boxShadow: isFlagged ? '0 0 4px rgba(251,191,36,0.7)' : '0 0 5px rgba(52,211,153,0.5)',
                  position: 'relative', zIndex: 1,
                }}
              />
              {isHovered && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute', bottom: '100%', marginBottom: 8,
                    background: 'rgba(10,12,18,0.96)', border: '0.5px solid rgba(255,255,255,0.14)',
                    borderRadius: 6, padding: '5px 10px', whiteSpace: 'nowrap',
                    fontSize: 12, color: isFlagged ? '#fcd34d' : 'rgba(255,255,255,0.78)',
                    fontWeight: 500,
                    boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
                    zIndex: 20,
                  }}
                >
                  {friendlyName}{isFlagged ? ' · review' : ' · tap to view finding'}
                </span>
              )}
            </button>
            {!isLast && (
              <div
                className="ft-line"
                aria-hidden="true"
                style={{
                  width: 12, height: 1,
                  background: 'rgba(255,255,255,0.15)',
                  transformOrigin: 'left',
                  transform: isVisible ? 'scaleX(1)' : 'scaleX(0)',
                  transition: 'transform 0.3s ease',
                  flexShrink: 0,
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const DESIGN_WIDTH = 794;

/**
 * Scales children as one piece to fit the outer container width (phone preview).
 * Print CSS resets transform so paper output stays pixel-identical.
 */
export function ScaleToFit({ children }: { children: ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    function measure() {
      const o = outerRef.current;
      const i = innerRef.current;
      if (!o || !i) return;
      const outerWidth = o.clientWidth;
      const s = Math.min(1, outerWidth / DESIGN_WIDTH);
      setScale(s);
      setHeight(i.offsetHeight * s);
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [children]);

  return (
    <div
      ref={outerRef}
      className="print-scale-wrap"
      style={{ height: height != null ? `${height}px` : undefined }}
    >
      <div
        ref={innerRef}
        style={{
          width: DESIGN_WIDTH,
          transformOrigin: "top left",
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

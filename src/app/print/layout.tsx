import type { ReactNode } from "react";
import "./print.css";

/**
 * Print-route layout — scopes desk-slip CSS to /print/* only (#64).
 * Interactive desk routes must not load these @page / @media print rules.
 */
export default function PrintLayout({ children }: { children: ReactNode }) {
  return children;
}

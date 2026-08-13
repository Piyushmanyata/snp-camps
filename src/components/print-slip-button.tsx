"use client";

export function PrintSlipButton() {
  return (
    <button
      type="button"
      className="print:hidden mt-3 min-h-12 w-full rounded-xl border border-black px-3 text-sm font-semibold"
      onClick={() => window.print()}
    >
      Print slip
    </button>
  );
}

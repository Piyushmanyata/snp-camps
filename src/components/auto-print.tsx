"use client";

import { useEffect } from "react";

export function AutoPrint() {
  useEffect(() => {
    window.print();
  }, []);
  return null;
}

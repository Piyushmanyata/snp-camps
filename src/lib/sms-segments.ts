export const SMS_UCS2_SINGLE = 70;
export const SMS_UCS2_CONCAT = 67;
export const SMS_MAX_SEGMENTS = 3;

export function ucs2Length(text: string): number {
  return text.length;
}

export function ucs2SegmentCount(text: string): number {
  const n = ucs2Length(text);
  if (n === 0) return 0;
  if (n <= SMS_UCS2_SINGLE) return 1;
  return Math.ceil(n / SMS_UCS2_CONCAT);
}

export function assertSmsSegments(text: string, label = "sms"): string {
  const segments = ucs2SegmentCount(text);
  if (segments > SMS_MAX_SEGMENTS) {
    throw new Error(`SMS_SEGMENTS_EXCEEDED:${label}:${segments}`);
  }
  return text;
}

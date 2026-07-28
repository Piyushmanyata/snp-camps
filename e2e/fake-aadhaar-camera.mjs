import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zxing from "@zxing/library";

export const fakeAadhaarCameraPath = join(
  tmpdir(),
  "snp-e2e-aadhaar-camera.y4m",
);

/**
 * Generate a short Y4M camera loop containing a real Aadhaar-format QR.
 * The file lives in the OS temp directory and is never committed as evidence.
 */
export function ensureFakeAadhaarCamera() {
  if (existsSync(fakeAadhaarCameraPath)) return fakeAadhaarCameraPath;

  const { BarcodeFormat, QRCodeWriter } = zxing;
  const width = 640;
  const height = 480;
  const qrSize = 400;
  const qrLeft = Math.floor((width - qrSize) / 2);
  const qrTop = Math.floor((height - qrSize) / 2);
  const payload =
    '<PrintLetterBarcodeData uid="987654321098" name="Timing Patient" gender="F" dob="15-05-1990" vtc="Jaipur" dist="Jaipur" state="Rajasthan" pc="302001"/>';
  const matrix = new QRCodeWriter().encode(
    payload,
    BarcodeFormat.QR_CODE,
    qrSize,
    qrSize,
    new Map(),
  );

  const luma = Buffer.alloc(width * height, 235);
  for (let y = 0; y < qrSize; y += 1) {
    for (let x = 0; x < qrSize; x += 1) {
      if (matrix.get(x, y)) {
        luma[(qrTop + y) * width + qrLeft + x] = 16;
      }
    }
  }
  const chroma = Buffer.alloc((width * height) / 4, 128);
  const frameHeader = Buffer.from("FRAME\n");
  const fd = openSync(fakeAadhaarCameraPath, "wx");
  try {
    writeSync(
      fd,
      Buffer.from(
        `YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`,
      ),
    );
    // Three seconds is ample for the worker to warm and decode; Chromium loops
    // fake capture files when the camera stays open.
    for (let frame = 0; frame < 45; frame += 1) {
      writeSync(fd, frameHeader);
      writeSync(fd, luma);
      writeSync(fd, chroma);
      writeSync(fd, chroma);
    }
  } finally {
    closeSync(fd);
  }
  return fakeAadhaarCameraPath;
}

import { describe, expect, test } from "bun:test";
import { pngDataUrl, solidPng } from "./images";

describe("synthetic png", () => {
  test("produces a valid PNG header, IHDR and IEND", () => {
    const png = solidPng(8, 4, [255, 0, 0]);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR");
    expect(dv.getUint32(16)).toBe(8);
    expect(dv.getUint32(20)).toBe(4);
    expect(String.fromCharCode(...png.slice(png.length - 8, png.length - 4))).toBe("IEND");
  });

  test("data url round-trips to the same bytes", () => {
    const png = solidPng(2, 2, [0, 128, 255]);
    const url = pngDataUrl(2, 2, [0, 128, 255]);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = url.slice("data:image/png;base64,".length);
    expect(Array.from(Buffer.from(b64, "base64"))).toEqual(Array.from(png));
  });
});

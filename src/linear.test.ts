import { describe, test, expect } from "bun:test";
import { safeFilename, extensionFromUrlOrType } from "./linear.js";

describe("safeFilename", () => {
  test("replaces spaces and special chars with underscores", () => {
    expect(safeFilename("hello world")).toBe("hello_world");
    expect(safeFilename("my file (1)")).toBe("my_file_1");
  });

  test("preserves allowed characters: letters, digits, dots, dashes, underscores", () => {
    expect(safeFilename("my-file_v1.2.txt")).toBe("my-file_v1.2.txt");
  });

  test("trims leading and trailing underscores", () => {
    expect(safeFilename("__hello__")).toBe("hello");
    expect(safeFilename("  spaces  ")).toBe("spaces");
  });

  test("truncates to 80 characters", () => {
    const long = "a".repeat(100);
    expect(safeFilename(long).length).toBe(80);
  });

  test("handles empty string", () => {
    expect(safeFilename("")).toBe("");
  });

  test("handles string with only special chars", () => {
    expect(safeFilename("!!!")).toBe("");
  });
});

describe("extensionFromUrlOrType", () => {
  test("extracts extension from URL pathname", () => {
    expect(extensionFromUrlOrType("https://uploads.linear.app/abc/file.png")).toBe("png");
    expect(extensionFromUrlOrType("https://example.com/document.pdf")).toBe("pdf");
    expect(extensionFromUrlOrType("https://example.com/image.JPEG")).toBe("jpeg");
  });

  test("falls back to content-type when URL has no extension", () => {
    expect(extensionFromUrlOrType("https://example.com/file", "image/jpeg")).toBe("jpeg");
    expect(extensionFromUrlOrType("https://example.com/file", "application/pdf")).toBe("pdf");
  });

  test("handles content-type with parameters", () => {
    expect(extensionFromUrlOrType("https://example.com/f", "text/plain; charset=utf-8")).toBe("plain");
  });

  test("normalizes content-type subtype separators", () => {
    expect(extensionFromUrlOrType("https://example.com/f", "image/svg+xml")).toBe("svg_xml");
  });

  test("returns 'bin' when no extension and no content-type", () => {
    expect(extensionFromUrlOrType("https://example.com/file")).toBe("bin");
    expect(extensionFromUrlOrType("https://example.com/file", null)).toBe("bin");
  });

  test("ignores extensions longer than 8 characters", () => {
    expect(extensionFromUrlOrType("https://example.com/file.toolongext", "image/png")).toBe("png");
  });

  test("handles invalid URL gracefully", () => {
    expect(extensionFromUrlOrType("not-a-url", "image/png")).toBe("png");
    expect(extensionFromUrlOrType("not-a-url")).toBe("bin");
  });
});

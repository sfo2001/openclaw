import { describe, expect, it } from "vitest";
import { isSafeExecutableValue, isSafeFilePath } from "./exec-safety.js";

describe("isSafeExecutableValue", () => {
  it("accepts bare executable names and likely paths", () => {
    expect(isSafeExecutableValue("node")).toBe(true);
    expect(isSafeExecutableValue("/usr/bin/node")).toBe(true);
    expect(isSafeExecutableValue("./bin/openclaw")).toBe(true);
    expect(isSafeExecutableValue("C:\\Tools\\openclaw.exe")).toBe(true);
    expect(isSafeExecutableValue(" tool ")).toBe(true);
  });

  it("rejects blanks, flags, shell metacharacters, quotes, and control chars", () => {
    expect(isSafeExecutableValue(undefined)).toBe(false);
    expect(isSafeExecutableValue("   ")).toBe(false);
    expect(isSafeExecutableValue("-rf")).toBe(false);
    expect(isSafeExecutableValue("node;rm -rf /")).toBe(false);
    expect(isSafeExecutableValue('node "arg"')).toBe(false);
    expect(isSafeExecutableValue("node\nnext")).toBe(false);
    expect(isSafeExecutableValue("node\0")).toBe(false);
  });
});

describe("isSafeFilePath", () => {
  it("accepts absolute paths, relative paths, and Windows paths", () => {
    expect(isSafeFilePath("/usr/share/piper/models/en-us.onnx")).toBe(true);
    expect(isSafeFilePath("./models/en-us.onnx")).toBe(true);
    expect(isSafeFilePath("C:\\Users\\user\\models\\en-us.onnx")).toBe(true);
    expect(isSafeFilePath("en-us.onnx")).toBe(true);
  });

  it("accepts paths and bare filenames that contain spaces", () => {
    expect(isSafeFilePath("/home/user/my models/en-us.onnx")).toBe(true);
    expect(isSafeFilePath("en us model.onnx")).toBe(true);
    expect(isSafeFilePath("/path/with spaces/file.onnx")).toBe(true);
  });

  it("rejects empty, null, and blank values", () => {
    expect(isSafeFilePath(undefined)).toBe(false);
    expect(isSafeFilePath(null)).toBe(false);
    expect(isSafeFilePath("")).toBe(false);
    expect(isSafeFilePath("   ")).toBe(false);
  });

  it("rejects null bytes and control characters", () => {
    expect(isSafeFilePath("/path/file\0.onnx")).toBe(false);
    expect(isSafeFilePath("/path/file\nname.onnx")).toBe(false);
    expect(isSafeFilePath("/path/file\rname.onnx")).toBe(false);
  });

  it("rejects shell metacharacters and quotes", () => {
    expect(isSafeFilePath("/path/file;rm -rf /")).toBe(false);
    expect(isSafeFilePath("/path/file|cat /etc/passwd")).toBe(false);
    expect(isSafeFilePath("/path/file`echo x`")).toBe(false);
    expect(isSafeFilePath("/path/file$HOME")).toBe(false);
    expect(isSafeFilePath('/path/"file".onnx')).toBe(false);
    expect(isSafeFilePath("/path/'file'.onnx")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { extractCdPrefix } from "./bash-tools.exec.js";

describe("extractCdPrefix", () => {
  describe("rewrites cd prefix into workdir", () => {
    it("handles cd /path && cmd", () => {
      const result = extractCdPrefix("cd /tmp && ls -la", undefined);
      expect(result).toEqual({ command: "ls -la", workdir: "/tmp" });
    });

    it("handles cd /path; cmd", () => {
      const result = extractCdPrefix("cd /tmp; ls -la", undefined);
      expect(result).toEqual({ command: "ls -la", workdir: "/tmp" });
    });

    it("handles double-quoted path with spaces", () => {
      const result = extractCdPrefix('cd "/path with spaces" && make', undefined);
      expect(result).toEqual({ command: "make", workdir: "/path with spaces" });
    });

    it("handles single-quoted path", () => {
      const result = extractCdPrefix("cd '/foo/bar' && git status", undefined);
      expect(result).toEqual({ command: "git status", workdir: "/foo/bar" });
    });

    it("preserves complex remainder after first separator", () => {
      const result = extractCdPrefix("cd /app && npm run build && npm test", undefined);
      expect(result).toEqual({ command: "npm run build && npm test", workdir: "/app" });
    });

    it("handles relative path", () => {
      const result = extractCdPrefix("cd src && make", undefined);
      expect(result).toEqual({ command: "make", workdir: "src" });
    });

    it("handles semicolon with complex remainder", () => {
      const result = extractCdPrefix("cd /app; npm run build && npm test", undefined);
      expect(result).toEqual({ command: "npm run build && npm test", workdir: "/app" });
    });
  });

  describe("skips rewriting when it should not apply", () => {
    it("returns null when explicit workdir is already set", () => {
      expect(extractCdPrefix("cd /tmp && ls", "/home/user")).toBeNull();
    });

    it("returns null for bare cd with path (no following command)", () => {
      expect(extractCdPrefix("cd /tmp", undefined)).toBeNull();
    });

    it("returns null for cd alone", () => {
      expect(extractCdPrefix("cd", undefined)).toBeNull();
    });

    it("returns null for pipe", () => {
      expect(extractCdPrefix("cd /tmp | ls", undefined)).toBeNull();
    });

    it("returns null for or-chain", () => {
      expect(extractCdPrefix("cd /tmp || ls", undefined)).toBeNull();
    });

    it("returns null when path contains $", () => {
      expect(extractCdPrefix("cd $HOME && ls", undefined)).toBeNull();
    });

    it("returns null when path contains ${}", () => {
      expect(extractCdPrefix("cd ${PROJECT_DIR} && ls", undefined)).toBeNull();
    });

    it("returns null when path contains tilde", () => {
      expect(extractCdPrefix("cd ~/projects && ls", undefined)).toBeNull();
    });

    it("returns null when path contains backtick", () => {
      expect(extractCdPrefix("cd `pwd` && ls", undefined)).toBeNull();
    });

    it("returns null when path contains $()", () => {
      expect(extractCdPrefix("cd $(echo /tmp) && ls", undefined)).toBeNull();
    });

    it("returns null for non-cd command", () => {
      expect(extractCdPrefix("ls /tmp && echo done", undefined)).toBeNull();
    });

    it("returns null for empty command", () => {
      expect(extractCdPrefix("", undefined)).toBeNull();
    });
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCdPrefix } from "./bash-tools.exec-cd-prefix.js";

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

    it("handles backslash-escaped spaces in unquoted path", () => {
      const result = extractCdPrefix("cd /my\\ project && build", undefined);
      expect(result).toEqual({ command: "build", workdir: "/my project" });
    });

    it("handles extra whitespace around tokens", () => {
      const result = extractCdPrefix("  cd   /tmp   &&   ls  ", undefined);
      expect(result).toEqual({ command: "ls", workdir: "/tmp" });
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

    it("returns null for cd - (previous directory)", () => {
      expect(extractCdPrefix("cd - && ls", undefined)).toBeNull();
    });

    it("returns null for trailing separator with no remainder", () => {
      expect(extractCdPrefix("cd /tmp &&", undefined)).toBeNull();
    });

    it("returns null for trailing semicolon with no remainder", () => {
      expect(extractCdPrefix("cd /tmp;", undefined)).toBeNull();
    });
  });

  describe("integration: relative path resolution", () => {
    it("relative workdir resolves against a base directory", () => {
      const result = extractCdPrefix("cd src && make", undefined);
      expect(result).not.toBeNull();
      // Simulate what the exec handler does: resolve relative against a base.
      const base = "/project/root";
      const resolved = path.isAbsolute(result!.workdir)
        ? result!.workdir
        : path.resolve(base, result!.workdir);
      expect(resolved).toBe(path.join("/project/root", "src"));
      expect(result!.command).toBe("make");
    });

    it("absolute workdir is used as-is", () => {
      const result = extractCdPrefix("cd /opt/app && deploy", undefined);
      expect(result).not.toBeNull();
      const base = "/project/root";
      const resolved = path.isAbsolute(result!.workdir)
        ? result!.workdir
        : path.resolve(base, result!.workdir);
      expect(resolved).toBe("/opt/app");
      expect(result!.command).toBe("deploy");
    });

    it("params mutation preserves other fields", () => {
      const params = { command: "cd /tmp && ls", workdir: undefined, env: { FOO: "bar" } };
      const result = extractCdPrefix(params.command, params.workdir);
      expect(result).not.toBeNull();
      const updated = { ...params, command: result!.command };
      expect(updated.env).toEqual({ FOO: "bar" });
      expect(updated.command).toBe("ls");
    });
  });
});

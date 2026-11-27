import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

// The two ways claude can be installed, both pointed at a pretend claude script.
// before: the script's own arguments, which go ahead of Claude's.
export type Install = (script: string, before?: string[]) => (args: string[]) => { file: string; args: string[] };

const direct: Install = (script, before = []) => (args) => ({ file: process.execPath, args: [script, ...before, ...args] });

// What npm writes on Windows: a claude.cmd that forwards %* to the real program.
const npmCmd: Install = (script, before = []) => {
  const dir = mkdtempSync(join(tmpdir(), "codehands npm "));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claude.cmd");
  writeFileSync(file, `@ECHO off\r\n"${process.execPath}" "${script}" ${before.join(" ")} %*\r\n`);
  return (args) => ({ file, args });
};

export const installs: [string, Install][] = [
  ["a direct executable", direct],
  ...(process.platform === "win32" ? [["an npm claude.cmd", npmCmd] as [string, Install]] : []),
];

// Line breaks and what cmd.exe treats as special.
export const TRICKY = 'line one\nsay "two" & echo %PATH% 100% !PATH! ^ | <x> $HOME\r\nends with a backslash \\\n- é ✓';

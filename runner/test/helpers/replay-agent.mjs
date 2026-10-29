// Stand-in for `claude`: prints a recorded JSONL file line by line, then exits with the given code.
// node replay-agent.mjs <file.jsonl> [exitCode] [edit | hang] [pidFile]
// With "edit" it also changes a.txt and adds new.txt in its working folder, like a real fix would.
// With "hang" it prints the first 2 lines (task.started), starts a child that never exits
// (like claude -> npm test), writes the child's pid to pidFile and never exits itself.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [file, exitCode = "0", mode, pidFile] = process.argv.slice(2);
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(pidFile, String(child.pid));
  process.stdout.write(readFileSync(file, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
  setInterval(() => {}, 1000);
} else {
  if (mode === "edit") {
    writeFileSync("a.txt", "hello\nworld\n");
    writeFileSync("new.txt", "a new file\n");
  }
  if (file) process.stdout.write(readFileSync(file, "utf8"));
  process.exitCode = Number(exitCode);
}

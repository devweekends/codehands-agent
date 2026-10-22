// Stand-in for `claude`: prints a recorded JSONL file line by line, then exits with the given code.
// node replay-agent.mjs <file.jsonl> [exitCode] [edit]
// With "edit" it also changes a.txt and adds new.txt in its working folder, like a real fix would.
import { readFileSync, writeFileSync } from "node:fs";

const [file, exitCode = "0", mode] = process.argv.slice(2);
if (mode === "edit") {
  writeFileSync("a.txt", "hello\nworld\n");
  writeFileSync("new.txt", "a new file\n");
}
if (file) process.stdout.write(readFileSync(file, "utf8"));
process.exitCode = Number(exitCode);

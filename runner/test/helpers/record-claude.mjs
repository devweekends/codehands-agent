// Stand-in for `claude -p --output-format stream-json`. Its result is what reached it:
// the arguments, stdin, and the notes file, so a test can compare them exactly.
import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";

const args = process.argv.slice(2);
const flag = args.indexOf("--append-system-prompt-file");
const notes = flag === -1 ? undefined : readFileSync(args[flag + 1], "utf8");
const input = await text(process.stdin);
console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ args, input, notes }),
    total_cost_usd: 0.01,
}));

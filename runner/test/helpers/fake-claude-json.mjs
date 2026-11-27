// Stand-in for `claude -p --output-format json`: prints one result object, like the real one.
// node fake-claude-json.mjs <ok | error | garbage> ...claudeArgs
// With "ok", result is what reached it: the arguments, stdin and the system prompt file,
// so a test can check every flag and both prompts.
import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";

const [mode, ...args] = process.argv.slice(2);
const input = await text(process.stdin);
if (mode === "garbage") {
    process.stdout.write("this is not json");
    process.exitCode = 1;
} else {
    const flag = args.indexOf("--system-prompt-file");
    const system = flag === -1 ? undefined : readFileSync(args[flag + 1], "utf8");
    process.stdout.write(JSON.stringify({
        type: "result",
        subtype: mode === "error" ? "error_max_budget_usd" : "success",
        is_error: mode === "error",
        result: mode === "error" ? "budget exceeded" : JSON.stringify({ args, input, system }),
        total_cost_usd: 0.0012,
    }));
}

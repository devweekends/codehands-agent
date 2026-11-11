// Stand-in for `claude -p --output-format json`: prints one result object, like the real one.
// node fake-claude-json.mjs <ok | error | garbage> ...claudeArgs
// With "ok", result is the arguments it got, so a test can check every flag and the prompt.
const [mode, ...args] = process.argv.slice(2);
if (mode === "garbage") {
    process.stdout.write("this is not json");
    process.exitCode = 1;
} else {
    process.stdout.write(JSON.stringify({
        type: "result",
        subtype: mode === "error" ? "error_max_budget_usd" : "success",
        is_error: mode === "error",
        result: mode === "error" ? "budget exceeded" : JSON.stringify(args),
        total_cost_usd: 0.0012,
    }));
}
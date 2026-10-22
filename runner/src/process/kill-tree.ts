// Week 1 guide, section 7 and diagram 1e. Killing the parent does not kill its
// children on Windows (claude -> npm test -> node), so kill the whole tree.

// TODO(Wed): ask politely, wait about 3 s, then `tree-kill` (taskkill /T /F on Windows).
export async function stopProcessTree(_pid: number, _graceMs = 3000): Promise<void> {
  throw new Error("not implemented: stopProcessTree (Wed)");
}

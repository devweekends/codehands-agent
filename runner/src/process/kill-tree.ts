// Week 1 guide, section 7 and diagram 1e. Killing the parent does not kill its
// children on Windows (claude -> npm test -> node), so kill the whole tree.

import treeKill from "tree-kill";

// Errors are ignored: the most common one is "already gone", which is what we want.
const kill = (pid: number, signal: NodeJS.Signals) =>
  new Promise<void>((resolve) => treeKill(pid, signal, () => resolve()));

// Ask politely, wait up to graceMs for `exited`, then force. On Windows tree-kill always
// runs `taskkill /T /F`, because a console program can't be asked to close, so the first kill is final.
export async function stopProcessTree(pid: number, exited: Promise<unknown>, graceMs = 3000): Promise<void> {
  await kill(pid, "SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), graceMs))),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    await kill(pid, "SIGKILL");
    await exited;
  }
}

import type { ChildProcess } from "node:child_process";

let observer: ((pid: number, active: boolean) => void) | undefined;
export function observeChildren(callback?: (pid: number, active: boolean) => void): void { observer = callback; }
export function trackChild(child: ChildProcess): void {
  const current = observer;
  if (!current) return;
  const started = () => {
    const pid = child.pid;
    if (!pid) return;
    current(pid, true);
    child.once("close", () => current(pid, false));
  };
  if (child.pid) started(); else child.once("spawn", started);
}

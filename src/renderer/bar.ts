// The floating bar. While recording ("live"): timer, Solace / Local only, two meters, Pause/Resume, Stop. After Stop
// ("follow", UX round 2 P3): the saved call's stage until it is Sent or the TA closes the bar; Retry when it failed.
// It only displays what main and the recorder window report, and sends button presses to main.
import type { BarFollowView } from "../main/barFollow";
import type { BarApi } from "../main/barPreload";
import type { StatusReport } from "../main/ipcTypes";
import { barChip } from "./barText";
import { formatElapsed } from "./elapsedClock";

declare global {
  interface Window {
    barApi: BarApi;
  }
}
const api = (): BarApi => window.barApi;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let current: StatusReport["state"] = "idle";
let following = false;

function chip(linked: boolean | null | undefined): void {
  const c = barChip(linked);
  const el = $("call-chip");
  el.hidden = !c;
  el.textContent = c?.text ?? "";
  el.className = `chip ${c?.kind ?? ""}`;
}

function render(s: StatusReport): void {
  current = s.state;
  document.body.dataset.state = s.state;
  if (s.state !== "idle") {
    following = false;
    document.body.dataset.mode = "live";
  }
  $("timer").textContent = formatElapsed(s.elapsedMs);
  $("meter-left").style.width = `${Math.round(s.levels[0] * 100)}%`;
  $("meter-right").style.width = `${Math.round(s.levels[1] * 100)}%`;
  ($("btn-pause") as HTMLButtonElement).textContent = s.state === "paused" ? "Resume" : "Pause";
  ($("btn-pause") as HTMLButtonElement).disabled = s.state !== "recording" && s.state !== "paused";
  ($("btn-stop") as HTMLButtonElement).disabled = s.state !== "recording" && s.state !== "paused";
  $("bar").title = s.warning ?? "";
  $("warn").hidden = !s.warning;
  $("test-mode-badge").hidden = s.testMode !== true;
  if (!following) chip(s.state === "idle" ? null : s.linked);
}

function renderFollow(f: BarFollowView | null): void {
  following = f !== null;
  document.body.dataset.mode = f ? "follow" : "live";
  if (!f) return;
  $("follow-title").textContent = f.title;
  $("follow-text").textContent = f.text;
  $("bar").title = `${f.title}: ${f.text}`;
  document.body.dataset.final = String(f.final);
  document.body.dataset.failed = String(f.canRetry);
  ($("btn-retry") as HTMLButtonElement).hidden = !f.canRetry;
  ($("btn-retry") as HTMLButtonElement).disabled = false;
  chip(f.linked);
}

$("btn-pause").addEventListener("click", () => api().sendBarCommand(current === "paused" ? "resume" : "pause"));
$("btn-stop").addEventListener("click", () => api().sendBarCommand("stop"));
$("btn-open").addEventListener("click", () => api().sendBarCommand("open"));
$("btn-retry").addEventListener("click", () => {
  ($("btn-retry") as HTMLButtonElement).disabled = true;
  api().sendBarCommand("retry");
});
$("btn-close").addEventListener("click", () => api().sendBarCommand("close"));
api().onStatus(render);
api().onFollow(renderFollow);

// The floating bar shown while recording: timer, two meters, Pause/Resume, Stop. It only displays what the
// recorder window reports and sends button presses to main.
import type { BarApi } from "../main/barPreload";
import type { StatusReport } from "../main/ipcTypes";

declare global {
  interface Window {
    barApi: BarApi;
  }
}
const api = (): BarApi => window.barApi;
import { formatElapsed } from "./elapsedClock";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let current: StatusReport["state"] = "idle";

function render(s: StatusReport): void {
  current = s.state;
  document.body.dataset.state = s.state;
  $("timer").textContent = formatElapsed(s.elapsedMs);
  $("meter-left").style.width = `${Math.round(s.levels[0] * 100)}%`;
  $("meter-right").style.width = `${Math.round(s.levels[1] * 100)}%`;
  ($("btn-pause") as HTMLButtonElement).textContent = s.state === "paused" ? "Resume" : "Pause";
  ($("btn-pause") as HTMLButtonElement).disabled = s.state !== "recording" && s.state !== "paused";
  ($("btn-stop") as HTMLButtonElement).disabled = s.state !== "recording" && s.state !== "paused";
  $("bar").title = s.warning ?? "";
  $("warn").hidden = !s.warning;
}

$("btn-pause").addEventListener("click", () => api().sendBarCommand(current === "paused" ? "resume" : "pause"));
$("btn-stop").addEventListener("click", () => api().sendBarCommand("stop"));
$("btn-open").addEventListener("click", () => api().sendBarCommand("open"));
api().onStatus(render);

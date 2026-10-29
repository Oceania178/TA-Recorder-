// The Windows Task Scheduler task "TA Call Recorder cleanup" (D-140): runs `<app> --sweep` when this user logs
// on, and once a day, so recordings older than 3 days are deleted even if the app is not opened.
//
// Why an XML file and not `schtasks /SC ONLOGON /TR …`: a plain ONLOGON task made by schtasks triggers for
// ANY user's logon, which Windows only lets an administrator create. A task whose logon trigger names this
// user, running as this user with the lowest rights, can be created without admin — and the XML also lets
// one task carry both triggers (logon + daily, as D-140 says).
//
// The command runner is passed in: tests never run schtasks; they check the arguments and the XML.
import { rm, writeFile } from "node:fs/promises";

export const CLEANUP_TASK_NAME = "TA Call Recorder cleanup";
export const SCHTASKS = "schtasks.exe";

export type CommandRunner = (file: string, args: readonly string[]) => Promise<{ code: number | null }>;

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The task definition (Task Scheduler schema 1.2). */
export function cleanupTaskXml(o: { command: string; arguments: string; userId: string }): string {
  const user = xmlEscape(o.userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Deletes TA Call Recorder recordings older than 3 days (D-140). Removed when the app is uninstalled.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T12:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(o.command)}</Command>
      <Arguments>${xmlEscape(o.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Creates (or replaces, /F) the task for this Windows user. `extraArgs` go before --sweep (a development
 * build passes the app folder there). The XML file is written as UTF-16 with a byte-order mark, which is what
 * schtasks expects, and deleted afterwards.
 */
export async function ensureCleanupTask(o: {
  run: CommandRunner;
  exePath: string;
  extraArgs?: string[];
  userId: string;
  xmlFile: string;
}): Promise<boolean> {
  const args = [...(o.extraArgs ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)), "--sweep"].join(" ");
  const xml = cleanupTaskXml({ command: o.exePath, arguments: args, userId: o.userId });
  try {
    await writeFile(o.xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
    const r = await o.run(SCHTASKS, ["/Create", "/TN", CLEANUP_TASK_NAME, "/XML", o.xmlFile, "/F"]);
    return r.code === 0;
  } catch {
    return false;
  } finally {
    await rm(o.xmlFile, { force: true }).catch(() => undefined);
  }
}

export async function removeCleanupTask(run: CommandRunner): Promise<boolean> {
  try {
    return (await run(SCHTASKS, ["/Delete", "/TN", CLEANUP_TASK_NAME, "/F"])).code === 0;
  } catch {
    return false;
  }
}

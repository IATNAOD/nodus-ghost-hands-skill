import { createHash } from "crypto";
import os from "os";
import type { Helper } from "./helper";

/**
 * Hash of the Windows MachineGuid: the skill recognizes this PC when it is paired
 * again (reinstall) and keeps its record. The guid itself never leaves the PC.
 */
export async function machineHash(helper: Helper): Promise<string> {
  let guid = "";

  try {
    const { value } = await helper.call<{ value: unknown }>("registry.read", { hive: "HKLM", path: "SOFTWARE\\Microsoft\\Cryptography", name: "MachineGuid", view: "64" });

    guid = typeof value === "string" ? value : "";
  } catch {
    // no helper yet: the host name is a weaker substitute
  }

  return createHash("sha256").update(`ghost-hands:${guid || os.hostname()}`).digest("hex");
}

/** "Windows 10 (10.0.19045)" */
export function osName(): string {
  const release = os.release();
  const build = Number(release.split(".")[2] ?? 0);

  return `Windows ${build >= 22000 ? "11" : "10"} (${release})`;
}

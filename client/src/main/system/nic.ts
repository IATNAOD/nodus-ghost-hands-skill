import type { Helper } from "./helper";

export interface WolInfo {
  mac: string;
  broadcast: string;
  adapter: "ethernet" | "wifi" | "other";
}

interface Nic {
  mac: string | null;
  type: string;
  up: boolean;
  ipv4: { address: string; mask: string }[];
}

const toNumber = (ip: string): number => ip.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
const toIp = (value: number): string => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");

/** Broadcast address of a network: 192.168.0.10/255.255.255.0 → 192.168.0.255 */
export const broadcastOf = (address: string, mask: string): string => toIp((toNumber(address) | ~toNumber(mask)) >>> 0);

/**
 * Wake-on-LAN data of the adapter that reaches NODUS: the local address of the
 * WebSocket connection tells which adapter it is.
 */
export async function wolInfo(helper: Helper, localAddress: string | null): Promise<WolInfo | null> {
  if (!localAddress) return null;

  const address = localAddress.replace(/^::ffff:/, "");

  try {
    const nics = await helper.call<Nic[]>("nic.info");

    for (const nic of nics) {
      const ip = nic.ipv4.find((item) => item.address === address);

      if (!ip || !nic.mac) continue;

      return {
        mac: nic.mac.toLowerCase(),
        broadcast: broadcastOf(ip.address, ip.mask),
        adapter: nic.type === "ethernet" ? "ethernet" : nic.type === "wifi" ? "wifi" : "other",
      };
    }
  } catch {
    // the helper is down: no Wake-on-LAN until it is back
  }

  return null;
}

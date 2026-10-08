using System;
using System.Collections.Generic;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace GhostHelper
{
    // Network adapter inventory via System.Net.NetworkInformation.
    internal static class Network
    {
        public static List<Dictionary<string, object>> Info()
        {
            var result = new List<Dictionary<string, object>>();
            foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                var ipv4 = new List<Dictionary<string, object>>();
                try
                {
                    foreach (UnicastIPAddressInformation ua in nic.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        ipv4.Add(new Dictionary<string, object>
                        {
                            ["address"] = ua.Address.ToString(),
                            ["mask"] = ua.IPv4Mask != null ? ua.IPv4Mask.ToString() : null
                        });
                    }
                }
                catch { /* some interfaces expose no IP properties */ }

                result.Add(new Dictionary<string, object>
                {
                    ["name"] = nic.Name,
                    ["description"] = nic.Description,
                    ["mac"] = FormatMac(nic.GetPhysicalAddress()),
                    ["type"] = MapType(nic.NetworkInterfaceType),
                    ["up"] = nic.OperationalStatus == OperationalStatus.Up,
                    ["ipv4"] = ipv4
                });
            }
            return result;
        }

        private static string FormatMac(PhysicalAddress addr)
        {
            if (addr == null) return null;
            byte[] bytes = addr.GetAddressBytes();
            if (bytes == null || bytes.Length == 0) return null;
            var parts = new string[bytes.Length];
            for (int i = 0; i < bytes.Length; i++) parts[i] = bytes[i].ToString("x2");
            return string.Join(":", parts);
        }

        private static string MapType(NetworkInterfaceType type)
        {
            switch (type)
            {
                case NetworkInterfaceType.Ethernet:
                case NetworkInterfaceType.GigabitEthernet:
                case NetworkInterfaceType.FastEthernetT:
                case NetworkInterfaceType.FastEthernetFx:
                case NetworkInterfaceType.Ethernet3Megabit:
                    return "ethernet";
                case NetworkInterfaceType.Wireless80211:
                    return "wifi";
                default:
                    return "other";
            }
        }
    }
}

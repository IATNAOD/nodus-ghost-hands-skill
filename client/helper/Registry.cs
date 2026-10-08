using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace GhostHelper
{
    // Registry reads with hive + view selection. Reads only; never writes.
    internal static class RegistryCmd
    {
        public static Dictionary<string, object> Read(string hive, string path, string name, string view)
        {
            using (RegistryKey baseKey = OpenBase(hive, view))
            using (RegistryKey key = baseKey.OpenSubKey(path ?? "", false))
            {
                if (key == null)
                    return new Dictionary<string, object> { ["value"] = null };

                string valueName = name ?? ""; // "" = default value
                object raw = key.GetValue(valueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                if (raw == null)
                    return new Dictionary<string, object> { ["value"] = null };

                RegistryValueKind kind;
                try { kind = key.GetValueKind(valueName); }
                catch { kind = RegistryValueKind.Unknown; }

                return new Dictionary<string, object> { ["value"] = ConvertValue(raw, kind) };
            }
        }

        public static Dictionary<string, object> Enum(string hive, string path, string view)
        {
            var values = new Dictionary<string, object>();
            var subkeys = new List<Dictionary<string, object>>();

            using (RegistryKey baseKey = OpenBase(hive, view))
            using (RegistryKey key = baseKey.OpenSubKey(path ?? "", false))
            {
                if (key == null)
                    return new Dictionary<string, object> { ["values"] = values, ["subkeys"] = subkeys };

                ReadValuesInto(key, values);

                foreach (string subName in key.GetSubKeyNames())
                {
                    var subValues = new Dictionary<string, object>();
                    try
                    {
                        using (RegistryKey sub = key.OpenSubKey(subName, false))
                        {
                            if (sub != null) ReadValuesInto(sub, subValues);
                        }
                    }
                    catch { /* skip inaccessible subkeys */ }

                    subkeys.Add(new Dictionary<string, object>
                    {
                        ["name"] = subName,
                        ["values"] = subValues
                    });
                }
            }

            return new Dictionary<string, object> { ["values"] = values, ["subkeys"] = subkeys };
        }

        private static void ReadValuesInto(RegistryKey key, Dictionary<string, object> dest)
        {
            foreach (string vn in key.GetValueNames())
            {
                object raw;
                RegistryValueKind kind;
                try
                {
                    raw = key.GetValue(vn, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    kind = key.GetValueKind(vn);
                }
                catch { continue; }
                dest[vn] = ConvertValue(raw, kind);
            }
        }

        private static object ConvertValue(object raw, RegistryValueKind kind)
        {
            switch (kind)
            {
                case RegistryValueKind.DWord:
                    return Convert.ToInt32(raw);
                case RegistryValueKind.QWord:
                    return Convert.ToInt64(raw);
                case RegistryValueKind.MultiString:
                    return (string[])raw;
                case RegistryValueKind.Binary:
                    return Convert.ToBase64String((byte[])raw);
                case RegistryValueKind.String:
                case RegistryValueKind.ExpandString:
                    return Convert.ToString(raw);
                default:
                    if (raw is byte[] b) return Convert.ToBase64String(b);
                    if (raw is string[] sa) return sa;
                    return Convert.ToString(raw);
            }
        }

        private static RegistryKey OpenBase(string hive, string view)
        {
            RegistryHive h;
            switch ((hive ?? "").ToUpperInvariant())
            {
                case "HKCU": h = RegistryHive.CurrentUser; break;
                case "HKLM": h = RegistryHive.LocalMachine; break;
                case "HKCR": h = RegistryHive.ClassesRoot; break;
                default: throw new HelperException("invalid-args", "hive must be HKCU, HKLM, or HKCR.");
            }

            RegistryView v;
            switch ((view ?? "default").ToLowerInvariant())
            {
                case "32": v = RegistryView.Registry32; break;
                case "64": v = RegistryView.Registry64; break;
                case "default":
                case "": v = RegistryView.Default; break;
                default: throw new HelperException("invalid-args", "view must be 32, 64, or default.");
            }

            return RegistryKey.OpenBaseKey(h, v);
        }
    }
}

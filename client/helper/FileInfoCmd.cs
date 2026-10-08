using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace GhostHelper
{
    // file.info: version metadata for an executable/dll via FileVersionInfo.
    internal static class FileInfoCmd
    {
        public static Dictionary<string, object> Get(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new HelperException("invalid-args", "Missing required argument: path");

            bool exists = File.Exists(path);
            if (!exists)
            {
                return new Dictionary<string, object>
                {
                    ["exists"] = false,
                    ["product"] = null,
                    ["description"] = null,
                    ["company"] = null,
                    ["version"] = null
                };
            }

            FileVersionInfo fvi = FileVersionInfo.GetVersionInfo(path);
            return new Dictionary<string, object>
            {
                ["exists"] = true,
                ["product"] = Nullify(fvi.ProductName),
                ["description"] = Nullify(fvi.FileDescription),
                ["company"] = Nullify(fvi.CompanyName),
                ["version"] = Nullify(fvi.FileVersion)
            };
        }

        private static string Nullify(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }
}

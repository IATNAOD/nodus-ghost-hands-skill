using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace GhostHelper
{
    // Exception carrying a protocol error code (kebab-case). The dispatcher maps
    // these to {ok:false, code, message}; anything else becomes code "internal".
    internal sealed class HelperException : Exception
    {
        public string Code { get; }
        public HelperException(string code, string message) : base(message) { Code = code; }
    }

    // Typed access to the "args" object of a request.
    internal sealed class Args
    {
        private readonly Dictionary<string, object> _d;

        public Args(object argsObj)
        {
            _d = argsObj as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        public bool Has(string key) => _d.ContainsKey(key) && _d[key] != null;

        public object Raw(string key) => _d.TryGetValue(key, out var v) ? v : null;

        public string GetString(string key, string def = null, bool required = false)
        {
            if (!Has(key))
            {
                if (required) throw new HelperException("invalid-args", "Missing required argument: " + key);
                return def;
            }
            return Convert.ToString(_d[key], CultureInfo.InvariantCulture);
        }

        public int GetInt(string key, int def = 0, bool required = false)
        {
            if (!Has(key))
            {
                if (required) throw new HelperException("invalid-args", "Missing required argument: " + key);
                return def;
            }
            try { return Convert.ToInt32(_d[key], CultureInfo.InvariantCulture); }
            catch { throw new HelperException("invalid-args", "Argument '" + key + "' must be a number."); }
        }

        public bool GetBool(string key, bool def = false, bool required = false)
        {
            if (!Has(key))
            {
                if (required) throw new HelperException("invalid-args", "Missing required argument: " + key);
                return def;
            }
            object v = _d[key];
            if (v is bool b) return b;
            try { return Convert.ToBoolean(v, CultureInfo.InvariantCulture); }
            catch { throw new HelperException("invalid-args", "Argument '" + key + "' must be a boolean."); }
        }

        // Returns a list of ints from a JSON array; empty list if absent.
        public List<int> GetIntArray(string key)
        {
            var result = new List<int>();
            if (!Has(key)) return result;
            if (!(_d[key] is List<object> list))
                throw new HelperException("invalid-args", "Argument '" + key + "' must be an array.");
            foreach (var item in list)
            {
                try { result.Add(Convert.ToInt32(item, CultureInfo.InvariantCulture)); }
                catch { throw new HelperException("invalid-args", "Array '" + key + "' must contain numbers."); }
            }
            return result;
        }

        // Returns a list of strings from a JSON array; empty list if absent.
        public List<string> GetStringArray(string key)
        {
            var result = new List<string>();
            if (!Has(key)) return result;
            if (!(_d[key] is List<object> list))
                throw new HelperException("invalid-args", "Argument '" + key + "' must be an array.");
            foreach (var item in list)
                result.Add(Convert.ToString(item, CultureInfo.InvariantCulture));
            return result;
        }
    }

    // Diagnostic logging to stderr only (the parent captures it). Kept quiet.
    internal static class Log
    {
        private static readonly object _lock = new object();
        private static TextWriter _err;

        public static void Init()
        {
            try
            {
                _err = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch
            {
                _err = Console.Error;
            }
        }

        public static void Write(string message)
        {
            try
            {
                lock (_lock)
                {
                    (_err ?? Console.Error).WriteLine("[GhostHelper] " + message);
                }
            }
            catch { /* never let logging crash the process */ }
        }
    }
}

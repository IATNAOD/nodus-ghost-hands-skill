using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace GhostHelper
{
    // Minimal, dependency-free JSON parser/serializer.
    // Parse yields: Dictionary<string,object>, List<object>, string, bool, long, double, null.
    // Stringify accepts: null, bool, string, integers, floating point, IDictionary, IEnumerable.
    internal static class Json
    {
        // ---------------- Serialize ----------------
        public static string Stringify(object value)
        {
            var sb = new StringBuilder(256);
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object v)
        {
            if (v == null) { sb.Append("null"); return; }

            switch (v)
            {
                case bool b:
                    sb.Append(b ? "true" : "false");
                    return;
                case string s:
                    WriteString(sb, s);
                    return;
                case char c:
                    WriteString(sb, c.ToString());
                    return;
                case float f:
                    WriteDouble(sb, f);
                    return;
                case double d:
                    WriteDouble(sb, d);
                    return;
                case decimal m:
                    sb.Append(m.ToString(CultureInfo.InvariantCulture));
                    return;
                case sbyte _:
                case byte _:
                case short _:
                case ushort _:
                case int _:
                case uint _:
                case long _:
                case ulong _:
                    sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                    return;
            }

            if (v is IDictionary<string, object> dso)
            {
                WriteObject(sb, dso);
                return;
            }
            if (v is IDictionary dict)
            {
                var tmp = new List<KeyValuePair<string, object>>();
                foreach (DictionaryEntry e in dict)
                    tmp.Add(new KeyValuePair<string, object>(Convert.ToString(e.Key, CultureInfo.InvariantCulture), e.Value));
                WriteObject(sb, tmp);
                return;
            }
            if (v is IEnumerable en)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in en)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item);
                }
                sb.Append(']');
                return;
            }

            // Fallback: serialize as string.
            WriteString(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        private static void WriteObject(StringBuilder sb, IEnumerable<KeyValuePair<string, object>> pairs)
        {
            sb.Append('{');
            bool first = true;
            foreach (var kv in pairs)
            {
                if (!first) sb.Append(',');
                first = false;
                WriteString(sb, kv.Key);
                sb.Append(':');
                WriteValue(sb, kv.Value);
            }
            sb.Append('}');
        }

        private static void WriteDouble(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            // "R" round-trips; integers come out without a decimal point which is fine for JSON.
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            sb.Append(c); // keep non-ASCII (UTF-8 output handles it)
                        break;
                }
            }
            sb.Append('"');
        }

        // ---------------- Parse ----------------
        public static object Parse(string text)
        {
            var p = new Parser(text);
            object result = p.ParseValue();
            p.SkipWhitespace();
            if (!p.AtEnd) throw new FormatException("Trailing characters after JSON value.");
            return result;
        }

        private sealed class Parser
        {
            private readonly string _s;
            private int _i;

            public Parser(string s) { _s = s ?? ""; _i = 0; }
            public bool AtEnd => _i >= _s.Length;

            public void SkipWhitespace()
            {
                while (_i < _s.Length)
                {
                    char c = _s[_i];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') _i++;
                    else break;
                }
            }

            public object ParseValue()
            {
                SkipWhitespace();
                if (AtEnd) throw new FormatException("Unexpected end of JSON.");
                char c = _s[_i];
                switch (c)
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return ParseString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return ParseNumber();
                }
            }

            private Dictionary<string, object> ParseObject()
            {
                var obj = new Dictionary<string, object>(StringComparer.Ordinal);
                _i++; // {
                SkipWhitespace();
                if (!AtEnd && _s[_i] == '}') { _i++; return obj; }
                while (true)
                {
                    SkipWhitespace();
                    if (AtEnd || _s[_i] != '"') throw new FormatException("Expected property name.");
                    string key = ParseString();
                    SkipWhitespace();
                    if (AtEnd || _s[_i] != ':') throw new FormatException("Expected ':'.");
                    _i++;
                    object val = ParseValue();
                    obj[key] = val;
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("Unterminated object.");
                    char c = _s[_i++];
                    if (c == ',') continue;
                    if (c == '}') break;
                    throw new FormatException("Expected ',' or '}'.");
                }
                return obj;
            }

            private List<object> ParseArray()
            {
                var arr = new List<object>();
                _i++; // [
                SkipWhitespace();
                if (!AtEnd && _s[_i] == ']') { _i++; return arr; }
                while (true)
                {
                    object val = ParseValue();
                    arr.Add(val);
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("Unterminated array.");
                    char c = _s[_i++];
                    if (c == ',') continue;
                    if (c == ']') break;
                    throw new FormatException("Expected ',' or ']'.");
                }
                return arr;
            }

            private string ParseString()
            {
                var sb = new StringBuilder();
                _i++; // opening quote
                while (true)
                {
                    if (AtEnd) throw new FormatException("Unterminated string.");
                    char c = _s[_i++];
                    if (c == '"') break;
                    if (c == '\\')
                    {
                        if (AtEnd) throw new FormatException("Unterminated escape.");
                        char e = _s[_i++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                sb.Append(ParseUnicodeEscape());
                                break;
                            default: throw new FormatException("Invalid escape: \\" + e);
                        }
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }
                return sb.ToString();
            }

            private char ParseUnicodeEscape()
            {
                if (_i + 4 > _s.Length) throw new FormatException("Invalid \\u escape.");
                int code = int.Parse(_s.Substring(_i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                _i += 4;
                return (char)code; // surrogate halves are preserved as individual chars
            }

            private object ParseNumber()
            {
                int start = _i;
                if (!AtEnd && (_s[_i] == '-' || _s[_i] == '+')) _i++;
                bool isDouble = false;
                while (!AtEnd)
                {
                    char c = _s[_i];
                    if (c >= '0' && c <= '9') { _i++; }
                    else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
                    {
                        isDouble = true;
                        _i++;
                    }
                    else break;
                }
                string num = _s.Substring(start, _i - start);
                if (num.Length == 0) throw new FormatException("Invalid number.");
                if (!isDouble && long.TryParse(num, NumberStyles.Integer, CultureInfo.InvariantCulture, out long l))
                    return l;
                return double.Parse(num, NumberStyles.Float, CultureInfo.InvariantCulture);
            }

            private void Expect(string literal)
            {
                if (_i + literal.Length > _s.Length || _s.Substring(_i, literal.Length) != literal)
                    throw new FormatException("Expected literal '" + literal + "'.");
                _i += literal.Length;
            }
        }
    }
}

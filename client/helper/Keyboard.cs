using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

namespace GhostHelper
{
    // Keyboard input of scenarios. Keys go as scan codes (games read them; Windows maps them to
    // virtual keys by the layout of the window in front); keys without one - media, browser,
    // Pause - as virtual keys. "dryRun" describes the INPUTs instead of sending them (tests).
    internal static class Keyboard
    {
        internal struct Key
        {
            public ushort Scan;
            public bool Ext;
            public ushort Vk;
        }

        private static readonly int InputSize = Marshal.SizeOf(typeof(Native.INPUT));

        // ---- input.keys { keys:[{scan,ext,vk}], action:"press"|"down"|"up", holdMs, repeat, intervalMs, guard, dryRun } ----
        public static Dictionary<string, object> Keys(Args args)
        {
            var keys = ParseKeys(args.Raw("keys"));
            string action = args.GetString("action", "press");
            if (action != "press" && action != "down" && action != "up") throw new HelperException("invalid-args", "action must be press, down or up");

            int hold = Clamp(args.GetInt("holdMs", 40), 0, 10000);
            int repeat = Clamp(args.GetInt("repeat", 1), 1, 100);
            int interval = Clamp(args.GetInt("intervalMs", 60), 0, 10000);
            bool dry = args.GetBool("dryRun", false);
            var described = new List<object>();
            int sent = 0;

            lock (InputGuard.Sync)
            {
                for (int i = 0; i < repeat; i++)
                {
                    if (i > 0 && interval > 0 && !dry) Thread.Sleep(interval);
                    if (!dry) InputGuard.Check(args);

                    if (action != "up")
                        sent += Send(keys.Select(k => KeyInput(k, false)).ToArray(), dry, described);
                    if (action == "press" && hold > 0 && !dry) Thread.Sleep(hold);
                    if (action != "down")
                        sent += Send(keys.AsEnumerable().Reverse().Select(k => KeyInput(k, true)).ToArray(), dry, described);
                }
            }

            return Result(sent, dry, described);
        }

        // ---- input.text { text, mode:"unicode"|"keys", intervalMs, guard, dryRun } ----
        // "keys" types with the keys of the layout in front (games ignore unicode packets);
        // characters the layout has no key for still go as unicode.
        public static Dictionary<string, object> Text(Args args)
        {
            string text = args.GetString("text", required: true);
            if (text.Length > 5000) throw new HelperException("invalid-args", "text is longer than 5000 characters");

            string mode = args.GetString("mode", "unicode");
            int interval = Clamp(args.GetInt("intervalMs", 5), 0, 1000);
            bool dry = args.GetBool("dryRun", false);
            var described = new List<object>();
            int sent = 0;

            lock (InputGuard.Sync)
            {
                if (!dry) InputGuard.Check(args);

                IntPtr layout = ForegroundLayout();
                foreach (char c in text)
                {
                    if (c == '\r') continue;

                    var batch = c == '\n' ? Stroke(new Key { Vk = 0x0D, Scan = 0x1C })
                        : c == '\t' ? Stroke(new Key { Vk = 0x09, Scan = 0x0F })
                        : mode == "keys" ? LayoutStroke(c, layout) ?? Unicode(c)
                        : Unicode(c);

                    sent += Send(batch, dry, described);
                    if (interval > 0 && !dry) Thread.Sleep(interval);
                }
            }

            return Result(sent, dry, described);
        }

        // ---- input.release { keys:[{scan,ext,vk}], buttons:["left",...] } ----
        // After a stopped run: whatever it held down goes up. No checks: releasing is always safe.
        public static Dictionary<string, object> Release(Args args)
        {
            var keys = args.Raw("keys") is List<object> ? ParseKeys(args.Raw("keys"), allowEmpty: true) : new List<Key>();
            var inputs = keys.Select(k => KeyInput(k, true)).ToList();

            foreach (string button in args.GetStringArray("buttons"))
                inputs.Add(Mouse.ButtonInput(button, down: false));

            int sent;
            lock (InputGuard.Sync)
                sent = inputs.Count > 0 ? (int)Native.SendInput((uint)inputs.Count, inputs.ToArray(), InputSize) : 0;

            return new Dictionary<string, object> { ["sent"] = sent };
        }

        // ---- input.state → { modifiers:[...], buttons:[...] } ----
        public static Dictionary<string, object> State()
        {
            return new Dictionary<string, object> { ["modifiers"] = Modifiers(), ["buttons"] = Buttons() };
        }

        // ---- input.waitRelease { timeoutMs } → { released } ----
        // A run started by a hotkey waits until the person lets go of its modifiers.
        public static Dictionary<string, object> WaitRelease(Args args)
        {
            int timeout = Clamp(args.GetInt("timeoutMs", 3000), 0, 10000);
            var until = DateTime.UtcNow.AddMilliseconds(timeout);

            while (Modifiers().Count > 0)
            {
                if (DateTime.UtcNow >= until) return new Dictionary<string, object> { ["released"] = false };
                Thread.Sleep(20);
            }
            return new Dictionary<string, object> { ["released"] = true };
        }

        private static bool Down(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;

        private static List<object> Modifiers()
        {
            var list = new List<object>();
            if (Down(0x10)) list.Add("shift");
            if (Down(0x11)) list.Add("ctrl");
            if (Down(0x12)) list.Add("alt");
            if (Down(0x5B) || Down(0x5C)) list.Add("win");
            return list;
        }

        private static List<object> Buttons()
        {
            var list = new List<object>();
            if (Down(0x01)) list.Add("left");
            if (Down(0x02)) list.Add("right");
            if (Down(0x04)) list.Add("middle");
            return list;
        }

        internal static List<Key> ParseKeys(object raw, bool allowEmpty = false)
        {
            if (!(raw is List<object> list) || (list.Count == 0 && !allowEmpty) || list.Count > 8)
                throw new HelperException("invalid-args", "keys must be 1-8 keys");

            var keys = new List<Key>();
            foreach (var item in list)
            {
                if (!(item is Dictionary<string, object> d)) throw new HelperException("invalid-args", "a key is {scan, ext, vk}");
                int scan = d.TryGetValue("scan", out var s) && s != null ? Convert.ToInt32(s, CultureInfo.InvariantCulture) : 0;
                int vk = d.TryGetValue("vk", out var v) && v != null ? Convert.ToInt32(v, CultureInfo.InvariantCulture) : 0;
                bool ext = d.TryGetValue("ext", out var e) && e is bool b && b;
                if ((scan <= 0 || scan > 0xFF) && (vk <= 0 || vk > 0xFE)) throw new HelperException("invalid-args", "a key needs scan 1-255 or vk 1-254");
                keys.Add(new Key { Scan = (ushort)Math.Max(0, Math.Min(scan, 0xFF)), Ext = ext, Vk = (ushort)Math.Max(0, Math.Min(vk, 0xFE)) });
            }
            return keys;
        }

        internal static Native.INPUT KeyInput(Key key, bool up)
        {
            var input = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            uint flags = (key.Ext ? Native.KEYEVENTF_EXTENDEDKEY : 0) | (up ? Native.KEYEVENTF_KEYUP : 0);

            input.U.ki = key.Scan > 0
                ? new Native.KEYBDINPUT { wVk = 0, wScan = key.Scan, dwFlags = flags | Native.KEYEVENTF_SCANCODE }
                : new Native.KEYBDINPUT { wVk = key.Vk, wScan = 0, dwFlags = flags };
            return input;
        }

        private static Native.INPUT[] Stroke(Key key) => new[] { KeyInput(key, false), KeyInput(key, true) };

        private static Native.INPUT[] Unicode(char c)
        {
            var down = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            down.U.ki = new Native.KEYBDINPUT { wVk = 0, wScan = c, dwFlags = Native.KEYEVENTF_UNICODE };
            var up = down;
            up.U.ki.dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP;
            return new[] { down, up };
        }

        // the character's key and shift state on the layout of the window in front
        private static Native.INPUT[] LayoutStroke(char c, IntPtr layout)
        {
            short scan = Native.VkKeyScanEx(c, layout);
            if (scan == -1) return null;

            uint vk = (uint)(scan & 0xFF);
            int shift = (scan >> 8) & 0xFF;
            var mods = new List<Key>();
            if ((shift & 1) != 0) mods.Add(new Key { Scan = 0x2A, Vk = 0x10 });
            if ((shift & 2) != 0) mods.Add(new Key { Scan = 0x1D, Vk = 0x11 });
            if ((shift & 4) != 0) mods.Add(new Key { Scan = 0x38, Vk = 0x12 });

            var key = new Key { Scan = (ushort)Native.MapVirtualKeyEx(vk, Native.MAPVK_VK_TO_VSC, layout), Vk = (ushort)vk };
            if (key.Scan == 0) key.Vk = (ushort)vk;

            var inputs = new List<Native.INPUT>();
            inputs.AddRange(mods.Select(m => KeyInput(m, false)));
            inputs.AddRange(Stroke(key));
            inputs.AddRange(mods.AsEnumerable().Reverse().Select(m => KeyInput(m, true)));
            return inputs.ToArray();
        }

        private static IntPtr ForegroundLayout()
        {
            uint thread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out _);
            return Native.GetKeyboardLayout(thread);
        }

        internal static int Send(Native.INPUT[] inputs, bool dry, List<object> described)
        {
            if (inputs.Length == 0) return 0;
            if (dry)
            {
                described.AddRange(inputs.Select(Describe));
                return inputs.Length;
            }

            uint sent = Native.SendInput((uint)inputs.Length, inputs, InputSize);
            if (sent != inputs.Length) throw new HelperException("input-blocked", "SendInput sent " + sent + " of " + inputs.Length + ".");
            return (int)sent;
        }

        internal static Dictionary<string, object> Describe(Native.INPUT input)
        {
            if (input.type == Native.INPUT_KEYBOARD)
                return new Dictionary<string, object> { ["type"] = "key", ["vk"] = (int)input.U.ki.wVk, ["scan"] = (int)input.U.ki.wScan, ["flags"] = (int)input.U.ki.dwFlags };
            return new Dictionary<string, object> { ["type"] = "mouse", ["flags"] = (int)input.U.mi.dwFlags, ["data"] = unchecked((int)input.U.mi.mouseData) };
        }

        internal static Dictionary<string, object> Result(int sent, bool dry, List<object> described)
        {
            var result = new Dictionary<string, object> { ["sent"] = sent };
            if (dry) result["inputs"] = described;
            return result;
        }

        internal static int Clamp(int value, int min, int max) => Math.Max(min, Math.Min(max, value));
    }
}

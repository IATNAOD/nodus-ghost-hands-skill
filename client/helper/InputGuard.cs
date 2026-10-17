using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace GhostHelper
{
    // Checks before synthetic input of scenarios, and one lock so two commands never interleave
    // their keys and clicks.
    //   input-blocked   - the secure desktop or a locked session: input goes nowhere
    //   focus-lost      - "guard" names the windows input is for, and another one is in front
    //   needs-elevation - the window in front runs as administrator: Windows drops our input
    //                     silently (UIPI), so we say it instead of pretending it worked
    internal static class InputGuard
    {
        public static readonly object Sync = new object();

        private static readonly Lazy<bool> SelfElevated = new Lazy<bool>(() => TokenElevated(Native.GetCurrentProcess()) == true);

        // guard = { pids?: [int] }
        public static void Check(Args args)
        {
            EnsureInputDesktop();

            IntPtr hwnd = Native.GetForegroundWindow();
            uint pid = 0;
            if (hwnd != IntPtr.Zero) Native.GetWindowThreadProcessId(hwnd, out pid);

            if (args.Raw("guard") is Dictionary<string, object> guard && guard.TryGetValue("pids", out var raw) && raw is List<object> list && list.Count > 0)
            {
                var pids = list.Select(v => Convert.ToInt64(v, CultureInfo.InvariantCulture)).ToList();
                if (!pids.Contains(pid)) throw new HelperException("focus-lost", "Another window is in front.");
            }

            if (pid != 0 && !SelfElevated.Value && IsElevated((int)pid))
                throw new HelperException("needs-elevation", "The window in front runs as administrator.");
        }

        public static void EnsureInputDesktop()
        {
            IntPtr desktop = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
            if (desktop == IntPtr.Zero) throw new HelperException("input-blocked", "The input desktop is not available (locked or a UAC prompt).");
            try
            {
                var name = new StringBuilder(64);
                if (Native.GetUserObjectInformation(desktop, Native.UOI_NAME, name, name.Capacity * 2, out _)
                    && !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase))
                    throw new HelperException("input-blocked", "Another desktop is active: " + name);
            }
            finally
            {
                Native.CloseDesktop(desktop);
            }
        }

        // a process we may not even query (an elevated one, from a normal helper) counts as elevated
        public static bool IsElevated(int pid)
        {
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return true;
            try
            {
                return TokenElevated(process) != false;
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }

        private static bool? TokenElevated(IntPtr process)
        {
            if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out IntPtr token)) return null;
            try
            {
                return Native.GetTokenInformation(token, Native.TokenElevation, out int elevated, sizeof(int), out _) ? elevated != 0 : (bool?)null;
            }
            finally
            {
                Native.CloseHandle(token);
            }
        }
    }
}

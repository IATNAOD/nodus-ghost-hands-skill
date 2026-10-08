using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace GhostHelper
{
    // Top-level window enumeration, focus control, and change-watching.
    internal static class Windows
    {
        // Shell / desktop windows we never report.
        private static readonly HashSet<string> ShellClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Shell_TrayWnd", "Progman", "WorkerW"
        };

        private static readonly ConcurrentDictionary<string, FileVersionInfo> VersionCache =
            new ConcurrentDictionary<string, FileVersionInfo>(StringComparer.OrdinalIgnoreCase);

        private static Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

        // PKEY_AppUserModel_ID
        private static Native.PROPERTYKEY PKEY_AppUserModel_ID = new Native.PROPERTYKEY
        {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5
        };

        // Returns one entry per process that owns a real, visible top-level window.
        public static List<Dictionary<string, object>> List()
        {
            int selfPid = Native.GetCurrentProcessId();
            IntPtr foreground = Native.GetForegroundWindow();

            // Collect qualifying windows grouped by owning process.
            var byPid = new Dictionary<uint, PidWindows>();
            Native.EnumWindows((hWnd, lParam) =>
            {
                if (!IsRealTopLevelWindow(hWnd)) return true;

                uint pid;
                Native.GetWindowThreadProcessId(hWnd, out pid);
                if (pid == 0 || pid == (uint)selfPid) return true;

                if (!byPid.TryGetValue(pid, out var pw))
                {
                    pw = new PidWindows { Representative = hWnd };
                    byPid[pid] = pw;
                }
                if (hWnd == foreground) pw.Foreground = true;
                return true;
            }, IntPtr.Zero);

            var result = new List<Dictionary<string, object>>();
            foreach (var kv in byPid)
            {
                uint pid = kv.Key;
                PidWindows pw = kv.Value;

                string exe = Processes.GetImagePath((int)pid);
                FileVersionInfo fvi = GetVersionInfo(exe);

                string product = Trim(fvi?.ProductName);
                string description = Trim(fvi?.FileDescription);
                string name = FirstNonEmpty(description, product,
                    exe != null ? Path.GetFileNameWithoutExtension(exe) : null) ?? "";

                bool fullscreen = pw.Foreground && IsFullscreen(foreground);

                result.Add(new Dictionary<string, object>
                {
                    ["pid"] = (int)pid,
                    ["exe"] = exe,
                    ["name"] = name,
                    ["product"] = product,
                    ["description"] = description,
                    ["aumid"] = GetAumid(pw.Representative),
                    ["foreground"] = pw.Foreground,
                    ["fullscreen"] = fullscreen
                });
            }
            return result;
        }

        private sealed class PidWindows
        {
            public IntPtr Representative;
            public bool Foreground;
        }

        // A "real" window: visible, unowned, not a tool window, not cloaked,
        // with a non-empty title, and not a shell window.
        internal static bool IsRealTopLevelWindow(IntPtr hWnd)
        {
            if (!Native.IsWindowVisible(hWnd)) return false;
            if (Native.GetWindow(hWnd, Native.GW_OWNER) != IntPtr.Zero) return false;

            long exStyle = Native.GetWindowLongPtr(hWnd, Native.GWL_EXSTYLE).ToInt64();
            if ((exStyle & Native.WS_EX_TOOLWINDOW) != 0) return false;

            int cloaked;
            if (Native.DwmGetWindowAttribute(hWnd, Native.DWMWA_CLOAKED, out cloaked, sizeof(int)) == Native.S_OK
                && cloaked != 0)
                return false;

            if (Native.GetWindowTextLength(hWnd) == 0) return false;

            string cls = GetClassName(hWnd);
            if (ShellClasses.Contains(cls)) return false;

            return true;
        }

        private static string GetClassName(IntPtr hWnd)
        {
            var sb = new StringBuilder(256);
            Native.GetClassName(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static bool IsFullscreen(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return false;
            Native.RECT wr;
            if (!Native.GetWindowRect(hWnd, out wr)) return false;

            IntPtr mon = Native.MonitorFromWindow(hWnd, Native.MONITOR_DEFAULTTONEAREST);
            var mi = new Native.MONITORINFO { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO)) };
            if (!Native.GetMonitorInfo(mon, ref mi)) return false;

            Native.RECT m = mi.rcMonitor;
            // Window covers the whole monitor.
            return wr.Left <= m.Left && wr.Top <= m.Top && wr.Right >= m.Right && wr.Bottom >= m.Bottom;
        }

        private static string GetAumid(IntPtr hWnd)
        {
            IPropertyStore store = null;
            try
            {
                int hr = Native.SHGetPropertyStoreForWindow(hWnd, ref IID_IPropertyStore, out store);
                if (hr != Native.S_OK || store == null) return null;

                Native.PROPVARIANT pv;
                if (store.GetValue(ref PKEY_AppUserModel_ID, out pv) != Native.S_OK) return null;
                try
                {
                    IntPtr ptr;
                    if (Native.PropVariantToStringAlloc(ref pv, out ptr) != Native.S_OK || ptr == IntPtr.Zero)
                        return null;
                    try
                    {
                        string s = Marshal.PtrToStringUni(ptr);
                        return string.IsNullOrEmpty(s) ? null : s;
                    }
                    finally { Native.CoTaskMemFree(ptr); }
                }
                finally { Native.PropVariantClear(ref pv); }
            }
            catch { return null; }
            finally { if (store != null) Marshal.ReleaseComObject(store); }
        }

        private static FileVersionInfo GetVersionInfo(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            return VersionCache.GetOrAdd(path, p =>
            {
                try { return File.Exists(p) ? FileVersionInfo.GetVersionInfo(p) : null; }
                catch { return null; }
            });
        }

        private static string Trim(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

        private static string FirstNonEmpty(params string[] values)
        {
            foreach (var v in values)
                if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
            return null;
        }

        // ---- window.focus ----
        public static Dictionary<string, object> Focus(int pid)
        {
            IntPtr target = FindMainWindow((uint)pid);
            if (target == IntPtr.Zero)
                return new Dictionary<string, object> { ["focused"] = false };

            if (Native.IsIconic(target))
                Native.ShowWindow(target, Native.SW_RESTORE);

            bool ok = Native.SetForegroundWindow(target);
            if (!ok)
            {
                // Classic AttachThreadInput trick to bypass foreground lock.
                uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out _);
                uint ourThread = Native.GetWindowThreadProcessId(target, out _);
                if (fgThread != 0 && ourThread != 0 && fgThread != ourThread)
                {
                    Native.AttachThreadInput(ourThread, fgThread, true);
                    Native.BringWindowToTop(target);
                    ok = Native.SetForegroundWindow(target);
                    Native.AttachThreadInput(ourThread, fgThread, false);
                }
            }
            return new Dictionary<string, object> { ["focused"] = ok };
        }

        // First visible, titled top-level window belonging to pid.
        private static IntPtr FindMainWindow(uint pid)
        {
            IntPtr found = IntPtr.Zero;
            Native.EnumWindows((hWnd, lParam) =>
            {
                uint wpid;
                Native.GetWindowThreadProcessId(hWnd, out wpid);
                if (wpid != pid) return true;
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (Native.GetWindowTextLength(hWnd) == 0) return true;
                if (Native.GetWindow(hWnd, Native.GW_OWNER) != IntPtr.Zero) return true;
                found = hWnd;
                return false; // stop
            }, IntPtr.Zero);
            return found;
        }
    }

    // Periodically polls Windows.List and emits a "windows" event when the set changes.
    internal sealed class WindowsWatcher
    {
        private readonly Action<string, object> _emit;
        private Thread _thread;
        private volatile bool _running;
        private string _lastSignature;

        public WindowsWatcher(Action<string, object> emitEvent) { _emit = emitEvent; }

        public void Start(int intervalMs)
        {
            Stop();
            if (intervalMs < 250) intervalMs = 250;
            _running = true;
            _lastSignature = null;
            _thread = new Thread(() => Loop(intervalMs)) { IsBackground = true, Name = "windows-watch" };
            _thread.Start();
        }

        public void Stop()
        {
            _running = false;
            var t = _thread;
            _thread = null;
            if (t != null && t.IsAlive && t != Thread.CurrentThread)
            {
                try { t.Join(1000); } catch { }
            }
        }

        private void Loop(int intervalMs)
        {
            // Emit the first snapshot immediately, then only on change.
            while (_running)
            {
                try
                {
                    var list = Windows.List();
                    string sig = Signature(list);
                    if (sig != _lastSignature)
                    {
                        _lastSignature = sig;
                        _emit("windows", list);
                    }
                }
                catch (Exception ex)
                {
                    Log.Write("windows.watch error: " + ex.Message);
                }

                // Sleep in small slices so Stop() is responsive.
                int slept = 0;
                while (_running && slept < intervalMs)
                {
                    Thread.Sleep(Math.Min(100, intervalMs - slept));
                    slept += 100;
                }
            }
        }

        // Signature over pid + exe + foreground + fullscreen (order-independent).
        private static string Signature(List<Dictionary<string, object>> list)
        {
            var parts = new List<string>(list.Count);
            foreach (var w in list)
                parts.Add(w["pid"] + "|" + w["exe"] + "|" + w["foreground"] + "|" + w["fullscreen"]);
            parts.Sort(StringComparer.Ordinal);
            return string.Join(";", parts);
        }
    }
}

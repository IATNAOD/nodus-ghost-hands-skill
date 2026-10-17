using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace GhostHelper
{
    // Monitors, screen frames and the cursor for scenarios, in physical pixels (DpiScope).
    // Frames go to temp files given by the client: JSON lines carry no pixels.
    internal static class Screen
    {
        internal sealed class Monitor
        {
            public string Id;
            public bool Primary;
            public Native.RECT Bounds;
            public Native.RECT Work;
            public uint Dpi;
        }

        // The caller is inside a DpiScope.
        internal static List<Monitor> Monitors()
        {
            var list = new List<Monitor>();
            Native.MonitorEnumProc proc = (IntPtr h, IntPtr hdc, ref Native.RECT r, IntPtr d) =>
            {
                var info = new Native.MONITORINFOEX { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX)) };
                if (Native.GetMonitorInfoEx(h, ref info))
                {
                    uint dpi = 96;
                    try
                    {
                        if (Native.GetDpiForMonitor(h, 0, out uint dx, out _) == 0) dpi = dx;
                    }
                    catch (DllNotFoundException) { }
                    catch (EntryPointNotFoundException) { }
                    list.Add(new Monitor { Id = info.szDevice, Primary = (info.dwFlags & Native.MONITORINFOF_PRIMARY) != 0, Bounds = info.rcMonitor, Work = info.rcWork, Dpi = dpi });
                }
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
            GC.KeepAlive(proc);
            return list;
        }

        internal static string MonitorAt(int x, int y)
        {
            IntPtr h = Native.MonitorFromPoint(new Native.POINT { X = x, Y = y }, Native.MONITOR_DEFAULTTONEAREST);
            var info = new Native.MONITORINFOEX { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX)) };
            return h != IntPtr.Zero && Native.GetMonitorInfoEx(h, ref info) ? info.szDevice : null;
        }

        internal static Dictionary<string, object> Rect(Native.RECT r) => Rect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);

        internal static Dictionary<string, object> Rect(int x, int y, int w, int h) =>
            new Dictionary<string, object> { ["x"] = x, ["y"] = y, ["w"] = w, ["h"] = h };

        // ---- screen.list ----
        public static Dictionary<string, object> List()
        {
            using (var scope = DpiScope.PerMonitorV2())
            {
                return new Dictionary<string, object>
                {
                    ["dpiAware"] = scope.Aware,
                    ["virtual"] = Rect(
                        Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN), Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN),
                        Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN), Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN)),
                    ["monitors"] = Monitors().Select(m => (object)new Dictionary<string, object>
                    {
                        ["id"] = m.Id,
                        ["primary"] = m.Primary,
                        ["bounds"] = Rect(m.Bounds),
                        ["work"] = Rect(m.Work),
                        ["dpi"] = (int)m.Dpi,
                        ["scale"] = m.Dpi / 96.0
                    }).ToList()
                };
            }
        }

        // ---- cursor.get ----
        public static Dictionary<string, object> Cursor()
        {
            using (DpiScope.PerMonitorV2())
            {
                Native.GetCursorPos(out var p);
                return new Dictionary<string, object> { ["x"] = p.X, ["y"] = p.Y, ["monitor"] = MonitorAt(p.X, p.Y) };
            }
        }

        // ---- screen.capture {monitors?:[id] | rect?:{x,y,w,h}, format:"gray"|"bgra", files:[path]} ----
        // One file per frame; "uniform" marks a one-colour frame (an exclusive fullscreen game).
        public static Dictionary<string, object> Capture(Args args)
        {
            using (DpiScope.PerMonitorV2())
            {
                var watch = Stopwatch.StartNew();
                string format = args.GetString("format", "gray");
                if (format != "gray" && format != "bgra") throw new HelperException("invalid-args", "format must be gray or bgra");

                var targets = Targets(args);
                var files = args.GetStringArray("files");
                if (files.Count < targets.Count) throw new HelperException("invalid-args", "One file per frame is needed.");

                var frames = new List<object>();
                for (int i = 0; i < targets.Count; i++) frames.Add(Write(targets[i].Key, targets[i].Value, format, files[i]));

                return new Dictionary<string, object> { ["frames"] = frames, ["ms"] = (int)watch.ElapsedMilliseconds };
            }
        }

        // monitor id → rectangle to capture; the caller is inside a DpiScope
        internal static List<KeyValuePair<string, Native.RECT>> Targets(Args args)
        {
            var result = new List<KeyValuePair<string, Native.RECT>>();

            if (args.Raw("rect") is Dictionary<string, object> raw)
            {
                var r = ParseRect(raw);
                result.Add(new KeyValuePair<string, Native.RECT>(MonitorAt((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2), r));
                return result;
            }

            var ids = args.GetStringArray("monitors");
            foreach (var m in Monitors())
                if (ids.Count == 0 || ids.Contains(m.Id, StringComparer.OrdinalIgnoreCase))
                    result.Add(new KeyValuePair<string, Native.RECT>(m.Id, m.Bounds));

            if (result.Count == 0) throw new HelperException("monitor-missing", "No such monitor.");
            return result;
        }

        internal static Native.RECT ParseRect(Dictionary<string, object> raw)
        {
            int Get(string key)
            {
                if (!raw.TryGetValue(key, out var v) || v == null) throw new HelperException("invalid-args", "rect." + key + " is missing");
                return Convert.ToInt32(v, System.Globalization.CultureInfo.InvariantCulture);
            }

            int x = Get("x"), y = Get("y"), w = Get("w"), h = Get("h");
            if (w <= 0 || h <= 0 || w > 16384 || h > 16384) throw new HelperException("invalid-args", "rect size is out of range");
            return new Native.RECT { Left = x, Top = y, Right = x + w, Bottom = y + h };
        }

        // A frame as a 32-bit BGRA bitmap; the caller is inside a DpiScope and disposes it.
        internal static Bitmap Grab(Native.RECT r)
        {
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            try
            {
                using (var g = Graphics.FromImage(bmp))
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                return bmp;
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                // the secure desktop (UAC, lock screen) gives no frame
                bmp.Dispose();
                throw new HelperException("capture-blocked", ex.Message);
            }
        }

        internal static byte[] Pixels(Bitmap bmp, out int stride)
        {
            var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                stride = data.Stride;
                var raw = new byte[stride * bmp.Height];
                Marshal.Copy(data.Scan0, raw, 0, raw.Length);
                return raw;
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }

        private static Dictionary<string, object> Write(string monitor, Native.RECT r, string format, string file)
        {
            CheckFile(file);

            using (var bmp = Grab(r))
            {
                int w = bmp.Width, h = bmp.Height;
                byte[] raw = Pixels(bmp, out int stride);
                byte min = 255, max = 0;
                byte[] output;
                int outStride;

                if (format == "bgra")
                {
                    output = raw;
                    outStride = stride;
                    for (int i = 0; i < raw.Length; i += 64)
                    {
                        byte g = raw[i + 1];
                        if (g < min) min = g;
                        if (g > max) max = g;
                    }
                }
                else
                {
                    output = new byte[w * h];
                    outStride = w;
                    for (int y = 0; y < h; y++)
                    {
                        int src = y * stride, dst = y * w;
                        for (int x = 0; x < w; x++, src += 4)
                        {
                            byte g = (byte)((raw[src + 2] * 77 + raw[src + 1] * 150 + raw[src] * 29) >> 8);
                            output[dst + x] = g;
                            if (g < min) min = g;
                            if (g > max) max = g;
                        }
                    }
                }

                using (var stream = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16))
                    stream.Write(output, 0, output.Length);

                return new Dictionary<string, object>
                {
                    ["monitor"] = monitor,
                    ["x"] = r.Left,
                    ["y"] = r.Top,
                    ["w"] = w,
                    ["h"] = h,
                    ["stride"] = outStride,
                    ["format"] = format,
                    ["file"] = file,
                    ["uniform"] = max - min < 4,
                    ["min"] = (int)min,
                    ["max"] = (int)max
                };
            }
        }

        // frames only go to *.raw files in the temp folder
        private static void CheckFile(string file)
        {
            string full;
            try { full = Path.GetFullPath(file ?? ""); }
            catch { throw new HelperException("invalid-args", "Bad frame file."); }

            string temp = Path.GetFullPath(Path.GetTempPath());
            if (!full.StartsWith(temp, StringComparison.OrdinalIgnoreCase) || !full.EndsWith(".raw", StringComparison.OrdinalIgnoreCase))
                throw new HelperException("invalid-args", "Frame files go to the temp folder as .raw");
            Directory.CreateDirectory(Path.GetDirectoryName(full));
        }
    }
}

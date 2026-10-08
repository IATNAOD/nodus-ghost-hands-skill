using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace GhostHelper
{
    internal static class Processes
    {
        // Names that must never be closed or killed.
        private static readonly HashSet<string> Protected = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "explorer", "csrss", "winlogon", "services", "lsass", "smss", "wininit", "dwm"
        };

        private sealed class ProcRow
        {
            public int Pid;
            public int Ppid;
            public string ExeName; // short name from the snapshot (e.g. "notepad.exe")
        }

        // ---- snapshot ----
        private static List<ProcRow> Snapshot()
        {
            var rows = new List<ProcRow>();
            IntPtr snap = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return rows;
            try
            {
                var pe = new Native.PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32)) };
                if (!Native.Process32First(snap, ref pe)) return rows;
                do
                {
                    rows.Add(new ProcRow
                    {
                        Pid = (int)pe.th32ProcessID,
                        Ppid = (int)pe.th32ParentProcessID,
                        ExeName = pe.szExeFile
                    });
                } while (Native.Process32Next(snap, ref pe));
            }
            finally { Native.CloseHandle(snap); }
            return rows;
        }

        // Full image path via PROCESS_QUERY_LIMITED_INFORMATION; null if inaccessible.
        public static string GetImagePath(int pid)
        {
            if (pid <= 0) return null;
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                int cap = 1024;
                var sb = new StringBuilder(cap);
                return Native.QueryFullProcessImageName(h, 0, sb, ref cap) ? sb.ToString() : null;
            }
            finally { Native.CloseHandle(h); }
        }

        // ---- process.list ----
        public static List<Dictionary<string, object>> List(List<string> underDirs, List<string> exes)
        {
            var dirs = new List<string>();
            foreach (var d in underDirs)
            {
                string n = NormalizeDir(d);
                if (n != null) dirs.Add(n);
            }
            var exeSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var e in exes)
            {
                string n = NormalizePath(e);
                if (n != null) exeSet.Add(n);
            }
            bool matchAll = dirs.Count == 0 && exeSet.Count == 0;

            var result = new List<Dictionary<string, object>>();
            foreach (var row in Snapshot())
            {
                string path = GetImagePath(row.Pid);
                if (path == null) continue; // only processes with an accessible path

                bool include = matchAll;
                if (!include)
                {
                    string norm = NormalizePath(path);
                    if (exeSet.Contains(norm)) include = true;
                    if (!include)
                    {
                        foreach (var dir in dirs)
                        {
                            if (norm.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) { include = true; break; }
                        }
                    }
                }
                if (!include) continue;

                result.Add(new Dictionary<string, object>
                {
                    ["pid"] = row.Pid,
                    ["ppid"] = row.Ppid,
                    ["exe"] = path,
                    ["name"] = Path.GetFileName(path)
                });
            }
            return result;
        }

        private static string NormalizePath(string p)
        {
            if (string.IsNullOrWhiteSpace(p)) return null;
            return p.Trim().Replace('/', '\\');
        }

        private static string NormalizeDir(string p)
        {
            string n = NormalizePath(p);
            if (n == null) return null;
            if (!n.EndsWith("\\")) n += "\\";
            return n;
        }

        // ---- protection checks ----
        private static bool IsProtected(int pid, int selfPid, int parentPid, Dictionary<int, string> names)
        {
            if (pid <= 4) return true;
            if (pid == selfPid || pid == parentPid) return true;
            string name = names.TryGetValue(pid, out var n) ? n : null;
            if (name == null) return false;
            string bare = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? name.Substring(0, name.Length - 4) : name;
            return Protected.Contains(bare);
        }

        private static Dictionary<int, string> NameMap(List<ProcRow> rows)
        {
            var map = new Dictionary<int, string>();
            foreach (var r in rows) map[r.Pid] = r.ExeName;
            return map;
        }

        // ---- process.close ----
        public static Dictionary<string, object> Close(List<int> pids, int softMs, int selfPid, int parentPid)
        {
            if (softMs <= 0) softMs = 3000;
            var rows = Snapshot();
            var names = NameMap(rows);

            var targets = new HashSet<int>();
            var pending = new List<int>();
            foreach (int pid in pids)
            {
                if (IsProtected(pid, selfPid, parentPid, names)) { pending.Add(pid); continue; }
                targets.Add(pid);
            }

            // Post WM_CLOSE to each visible top-level window of the target processes.
            Native.EnumWindows((hWnd, lParam) =>
            {
                uint wpid;
                Native.GetWindowThreadProcessId(hWnd, out wpid);
                if (!targets.Contains((int)wpid)) return true;
                if (!Native.IsWindowVisible(hWnd)) return true;
                string cls = ClassOf(hWnd);
                if (cls == "Shell_TrayWnd" || cls == "Progman" || cls == "WorkerW") return true;
                Native.PostMessage(hWnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return true;
            }, IntPtr.Zero);

            // Wait (shared deadline) for the targets to exit.
            var closed = new List<int>();
            var stillOpen = new List<int>(targets);
            long deadline = Environment.TickCount + softMs;
            while (stillOpen.Count > 0 && Environment.TickCount < deadline)
            {
                for (int i = stillOpen.Count - 1; i >= 0; i--)
                {
                    if (HasExited(stillOpen[i]))
                    {
                        closed.Add(stillOpen[i]);
                        stillOpen.RemoveAt(i);
                    }
                }
                if (stillOpen.Count == 0) break;
                System.Threading.Thread.Sleep(100);
            }
            pending.AddRange(stillOpen);

            return new Dictionary<string, object>
            {
                ["closed"] = closed,
                ["pending"] = pending
            };
        }

        private static string ClassOf(IntPtr hWnd)
        {
            var sb = new StringBuilder(256);
            Native.GetClassName(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static bool HasExited(int pid)
        {
            IntPtr h = Native.OpenProcess(Native.SYNCHRONIZE, false, pid);
            if (h == IntPtr.Zero) return true; // gone or inaccessible -> treat as exited
            try { return Native.WaitForSingleObject(h, 0) == Native.WAIT_OBJECT_0; }
            finally { Native.CloseHandle(h); }
        }

        // ---- process.kill ----
        public static Dictionary<string, object> Kill(List<int> pids, bool tree, int selfPid, int parentPid)
        {
            var rows = Snapshot();
            var names = NameMap(rows);

            // Expand to descendants when tree=true.
            var toKill = new List<int>();
            var seen = new HashSet<int>();
            foreach (int pid in pids)
            {
                if (seen.Add(pid)) toKill.Add(pid);
                if (tree)
                {
                    foreach (int child in Descendants(pid, rows))
                        if (seen.Add(child)) toKill.Add(child);
                }
            }

            var killed = new List<int>();
            var failed = new List<Dictionary<string, object>>();
            foreach (int pid in toKill)
            {
                if (IsProtected(pid, selfPid, parentPid, names))
                {
                    failed.Add(Fail(pid, "protected"));
                    continue;
                }
                IntPtr h = Native.OpenProcess(Native.PROCESS_TERMINATE, false, pid);
                if (h == IntPtr.Zero)
                {
                    int err = Marshal.GetLastWin32Error();
                    // 87 = ERROR_INVALID_PARAMETER (no such pid), 5 = ERROR_ACCESS_DENIED
                    failed.Add(Fail(pid, err == 5 ? "access-denied" : "not-found"));
                    continue;
                }
                try
                {
                    if (Native.TerminateProcess(h, 1)) killed.Add(pid);
                    else failed.Add(Fail(pid, Marshal.GetLastWin32Error() == 5 ? "access-denied" : "not-found"));
                }
                finally { Native.CloseHandle(h); }
            }

            return new Dictionary<string, object>
            {
                ["killed"] = killed,
                ["failed"] = failed
            };
        }

        private static Dictionary<string, object> Fail(int pid, string code) =>
            new Dictionary<string, object> { ["pid"] = pid, ["code"] = code };

        private static IEnumerable<int> Descendants(int root, List<ProcRow> rows)
        {
            var children = new Dictionary<int, List<int>>();
            foreach (var r in rows)
            {
                if (!children.TryGetValue(r.Ppid, out var list)) { list = new List<int>(); children[r.Ppid] = list; }
                list.Add(r.Pid);
            }
            var result = new List<int>();
            var stack = new Stack<int>();
            stack.Push(root);
            var visited = new HashSet<int> { root };
            while (stack.Count > 0)
            {
                int cur = stack.Pop();
                if (children.TryGetValue(cur, out var kids))
                {
                    foreach (int k in kids)
                    {
                        // Guard against ppid reuse cycles.
                        if (visited.Add(k)) { result.Add(k); stack.Push(k); }
                    }
                }
            }
            return result;
        }

        // ---- process.start ----
        public static Dictionary<string, object> Start(string path, string args, string cwd)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new HelperException("invalid-args", "Missing required argument: path");

            var psi = new ProcessStartInfo
            {
                FileName = path,
                UseShellExecute = true // lets shortcuts and UAC-elevating apps run
            };
            if (!string.IsNullOrEmpty(args)) psi.Arguments = args;
            if (!string.IsNullOrEmpty(cwd)) psi.WorkingDirectory = cwd;

            try
            {
                Process p = Process.Start(psi);
                int? pid = null;
                try { if (p != null) pid = p.Id; } catch { /* may have exited already */ }
                return new Dictionary<string, object> { ["pid"] = (object)pid };
            }
            catch (Win32Exception ex)
            {
                if (ex.NativeErrorCode == 1223) // ERROR_CANCELLED (UAC declined)
                    throw new HelperException("cancelled", "The operation was cancelled by the user.");
                if (ex.NativeErrorCode == 2) // ERROR_FILE_NOT_FOUND
                    throw new HelperException("not-found", "File not found: " + path);
                throw new HelperException("launch-failed", ex.Message);
            }
            catch (FileNotFoundException)
            {
                throw new HelperException("not-found", "File not found: " + path);
            }
            catch (DirectoryNotFoundException)
            {
                throw new HelperException("not-found", "Path not found: " + path);
            }
            catch (Exception ex)
            {
                throw new HelperException("launch-failed", ex.Message);
            }
        }
    }
}

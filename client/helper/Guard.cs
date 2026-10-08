using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace GhostHelper
{
    // The watchdog of a client under parental control:
    //   GhostHelper.exe guard --pid <client pid> --run <run.json> --exe <client exe> [--arg <a>]...
    // The first process starts a copy with --child and exits: the copy has no living parent, so
    // "End process tree" on the client does not reach it. The copy waits for the client to exit;
    // when run.json has no clean-exit mark for that pid (killed from Task Manager), it starts the
    // client again. One watchdog per profile (mutex), at most 5 restarts in 10 minutes.
    internal static class Guard
    {
        private const int MaxRestarts = 5;
        private static readonly TimeSpan RestartWindow = TimeSpan.FromMinutes(10);

        public static int Run(string[] args)
        {
            int pid = 0;
            string run = null, exe = null;
            bool child = false;
            var clientArgs = new List<string>();

            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i];
                string next = i + 1 < args.Length ? args[i + 1] : null;
                if (a == "--child") child = true;
                else if (a == "--pid" && next != null) { int.TryParse(next, out pid); i++; }
                else if (a == "--run" && next != null) { run = next; i++; }
                else if (a == "--exe" && next != null) { exe = next; i++; }
                else if (a == "--arg" && next != null) { clientArgs.Add(next); i++; }
            }

            if (pid <= 0 || string.IsNullOrEmpty(run) || string.IsNullOrEmpty(exe))
            {
                Log.Write("guard: --pid, --run and --exe are required");
                return 2;
            }

            try
            {
                return child ? Watch(pid, run, exe, clientArgs) : Detach(args);
            }
            catch (Exception ex)
            {
                Log.Write("guard: " + ex.Message);
                return 1;
            }
        }

        private static int Detach(string[] args)
        {
            var copy = new List<string>(args) { "--child" };
            var psi = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, CommandLine(copy))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (Process.Start(psi)) { }
            return 0;
        }

        private static int Watch(int pid, string run, string exe, List<string> clientArgs)
        {
            string dir = Path.GetDirectoryName(Path.GetFullPath(run));
            string info = Path.Combine(dir, "guard.json");
            var mutex = new Mutex(false, @"Local\GhostHandsGuard-" + Fnv(dir.ToLowerInvariant()));

            if (!Take(mutex)) return 0; // a watchdog of this profile is there already

            try
            {
                TryWrite(info, Json.Stringify(new Dictionary<string, object> { ["pid"] = Native.GetCurrentProcessId(), ["client"] = pid }));
                WaitExit(pid);

                // the client writes the mark before it quits; the pause covers a slow disk
                Thread.Sleep(1500);
                if (!Killed(run, pid)) return 0;
                if (!MayRestart(Path.Combine(dir, "guard-restarts.json")))
                {
                    Log.Write("guard: too many restarts, giving up");
                    return 0;
                }
            }
            finally
            {
                TryDelete(info);
                // the restarted client starts its own watchdog: this one lets the mutex go first
                try { mutex.ReleaseMutex(); } catch { }
                mutex.Dispose();
            }

            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    var psi = new ProcessStartInfo(exe, CommandLine(clientArgs))
                    {
                        UseShellExecute = false,
                        WorkingDirectory = Path.GetDirectoryName(exe),
                    };
                    // Electron with this variable starts as plain Node
                    psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                    using (Process.Start(psi)) { }
                    Log.Write("guard: the client was killed, started again");
                    return 0;
                }
                catch (Exception ex)
                {
                    Log.Write("guard: restart failed: " + ex.Message);
                    Thread.Sleep(2000);
                }
            }
            return 1;
        }

        private static bool Take(Mutex mutex)
        {
            try { return mutex.WaitOne(0); }
            catch (AbandonedMutexException) { return true; } // the previous watchdog was killed
        }

        private static void WaitExit(int pid)
        {
            IntPtr h = Native.OpenProcess(Native.SYNCHRONIZE, false, pid);
            if (h == IntPtr.Zero) return; // gone already
            try { Native.WaitForSingleObject(h, Native.INFINITE); }
            finally { Native.CloseHandle(h); }
        }

        // No clean-exit mark for this pid, and the client was guarded (parental control on). A
        // newer client that has already written its own marker is not ours to restart.
        private static bool Killed(string run, int pid)
        {
            Dictionary<string, object> marker;
            try { marker = Json.Parse(File.ReadAllText(run, Encoding.UTF8)) as Dictionary<string, object>; }
            catch { return true; }
            if (marker == null) return true;
            if (!marker.TryGetValue("pid", out object p) || !(p is long markerPid) || markerPid != pid) return false;
            if (marker.TryGetValue("guarded", out object g) && g is bool guarded && !guarded) return false;
            return !marker.ContainsKey("cleanExitAt") || marker["cleanExitAt"] == null;
        }

        private static bool MayRestart(string file)
        {
            var now = DateTime.UtcNow;
            var recent = new List<object>();
            try
            {
                if (Json.Parse(File.ReadAllText(file, Encoding.UTF8)) is List<object> list)
                {
                    foreach (var item in list)
                    {
                        if (item is long ticks && now - new DateTime(ticks, DateTimeKind.Utc) < RestartWindow) recent.Add(ticks);
                    }
                }
            }
            catch { /* the first restart */ }

            if (recent.Count >= MaxRestarts) return false;
            recent.Add(now.Ticks);
            TryWrite(file, Json.Stringify(recent));
            return true;
        }

        // CommandLineToArgvW quoting
        private static string CommandLine(IEnumerable<string> args)
        {
            var sb = new StringBuilder();
            foreach (string arg in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(arg); continue; }
                sb.Append('"');
                int slashes = 0;
                foreach (char c in arg)
                {
                    if (c == '\\') { slashes++; continue; }
                    if (c == '"') sb.Append('\\', slashes * 2 + 1);
                    else sb.Append('\\', slashes);
                    slashes = 0;
                    sb.Append(c);
                }
                sb.Append('\\', slashes * 2);
                sb.Append('"');
            }
            return sb.ToString();
        }

        private static string Fnv(string s)
        {
            uint hash = 2166136261;
            foreach (char c in s) { hash ^= c; hash *= 16777619; }
            return hash.ToString("x8");
        }

        private static void TryWrite(string file, string text)
        {
            try { File.WriteAllText(file, text, new UTF8Encoding(false)); }
            catch (Exception ex) { Log.Write("guard: " + ex.Message); }
        }

        private static void TryDelete(string file)
        {
            try { File.Delete(file); } catch { }
        }
    }
}

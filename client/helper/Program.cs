using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace GhostHelper
{
    internal static class Program
    {
        public const string Version = "1.0.0";

        private static int _selfPid;
        private static int _parentPid; // 0 = none
        private static StaExecutor _sta;
        private static WindowsWatcher _watcher;

        [STAThread]
        private static int Main(string[] args)
        {
            _selfPid = Native.GetCurrentProcessId();
            Log.Init();

            // CLI selftest mode: run once, print one JSON line, exit 0/1.
            if (args.Length > 0 && string.Equals(args[0], "selftest", StringComparison.OrdinalIgnoreCase))
                return RunCliSelftest();

            ParseParentArg(args);
            SetupStdio();

            _sta = new StaExecutor();
            _watcher = new WindowsWatcher((name, data) => Out.WriteEvent(name, data));

            if (_parentPid != 0)
                StartParentWatch(_parentPid);

            RunLoop();

            // stdin closed -> parent is done with us.
            Shutdown(0);
            return 0;
        }

        private static void ParseParentArg(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--parent", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    if (int.TryParse(args[i + 1], out int pid)) _parentPid = pid;
                }
            }
        }

        private static void SetupStdio()
        {
            var utf8 = new UTF8Encoding(false);
            // Best-effort: align the Console encodings too (ignored if no console).
            try { Console.OutputEncoding = utf8; } catch { }
            try { Console.InputEncoding = utf8; } catch { }

            var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
            var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = false };
            Out.Init(stdout);
            _stdin = stdin;
        }

        private static StreamReader _stdin;

        private static void RunLoop()
        {
            string line;
            while ((line = _stdin.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                string captured = line;
                // Each request runs independently so a slow command never blocks others.
                Task.Run(() => HandleLine(captured));
            }
        }

        private static void HandleLine(string line)
        {
            object parsed;
            try { parsed = Json.Parse(line); }
            catch (Exception ex)
            {
                Out.WriteError(null, "bad-request", "Invalid JSON: " + ex.Message);
                return;
            }

            if (!(parsed is Dictionary<string, object> req))
            {
                Out.WriteError(null, "bad-request", "Request must be a JSON object.");
                return;
            }

            object id = req.TryGetValue("id", out var idVal) ? idVal : null;
            try
            {
                string cmd = req.TryGetValue("cmd", out var cmdVal) ? cmdVal as string : null;
                if (string.IsNullOrEmpty(cmd))
                {
                    Out.WriteError(id, "bad-request", "Missing or invalid 'cmd'.");
                    return;
                }
                object argsObj = req.TryGetValue("args", out var a) ? a : null;
                object data = Dispatch(cmd, new Args(argsObj));
                Out.WriteOk(id, data);
            }
            catch (HelperException hex)
            {
                Out.WriteError(id, hex.Code, hex.Message);
            }
            catch (Exception ex)
            {
                Log.Write("command '" + (req.TryGetValue("cmd", out var c) ? c : "?") + "' failed: " + ex);
                Out.WriteError(id, "internal", ex.Message);
            }
        }

        private static readonly Dictionary<string, object> Empty = new Dictionary<string, object>();

        private static object Dispatch(string cmd, Args args)
        {
            switch (cmd)
            {
                case "ping":
                    return new Dictionary<string, object> { ["version"] = Version, ["pid"] = _selfPid };

                case "selftest":
                    return BuildSelftest(_sta);

                // ---- volume ----
                case "volume.get":
                    return Audio.Get();
                case "volume.set":
                    return Audio.SetLevel(args.GetInt("level", required: true));
                case "volume.change":
                    return Audio.ChangeLevel(args.GetInt("delta", required: true));
                case "volume.mute":
                    return Audio.SetMute(args.GetBool("muted", required: true));

                // ---- media ----
                case "media.key":
                    Input.MediaKey(args.GetString("key", required: true));
                    return Empty;

                // ---- windows ----
                case "windows.list":
                    return Windows.List();
                case "windows.watch":
                    _watcher.Start(args.GetInt("intervalMs", 2000));
                    return Empty;
                case "windows.unwatch":
                    _watcher.Stop();
                    return Empty;

                // ---- processes ----
                case "process.list":
                    return Processes.List(args.GetStringArray("underDirs"), args.GetStringArray("exes"));
                case "process.close":
                    return Processes.Close(args.GetIntArray("pids"), args.GetInt("softMs", 5000), _selfPid, _parentPid);
                case "process.kill":
                    return Processes.Kill(args.GetIntArray("pids"), args.GetBool("tree", false), _selfPid, _parentPid);
                case "process.start":
                    return Processes.Start(args.GetString("path", required: true), args.GetString("args"), args.GetString("cwd"));

                // ---- foreground / focus ----
                case "foreground.allow":
                    Native.AllowSetForegroundWindow(-1); // ASFW_ANY
                    return Empty;
                case "window.focus":
                    return Windows.Focus(args.GetInt("pid", required: true));

                // ---- power / display / desktop ----
                case "power.lock":
                    Power.Lock();
                    return Empty;
                case "power.sleep":
                    Power.SleepDeferred(); // reply now, suspend shortly after
                    return Empty;
                case "display.off":
                    Power.DisplayOff();
                    return Empty;
                case "desktop.show":
                    _sta.Run<object>(() => { Shell.ShowDesktop(); return null; });
                    return Empty;

                // ---- start menu apps (STA) ----
                case "startapps.list":
                    return _sta.Run<object>(() => Shell.StartAppsList());

                // ---- registry ----
                case "registry.read":
                    return RegistryCmd.Read(
                        args.GetString("hive", required: true),
                        args.GetString("path", ""),
                        args.GetString("name", ""),
                        args.GetString("view", "default"));
                case "registry.enum":
                    return RegistryCmd.Enum(
                        args.GetString("hive", required: true),
                        args.GetString("path", ""),
                        args.GetString("view", "default"));

                // ---- network ----
                case "nic.info":
                    return Network.Info();

                // ---- files ----
                case "file.info":
                    return FileInfoCmd.Get(args.GetString("path", required: true));

                default:
                    throw new HelperException("unknown-command", "Unknown command: " + cmd);
            }
        }

        // ---- selftest ----
        private static Dictionary<string, object> BuildSelftest(StaExecutor sta)
        {
            bool audio = false;
            try { Audio.Get(); audio = true; } catch { }

            int windows = 0;
            try { windows = Windows.List().Count; } catch { }

            int startapps = 0;
            try { startapps = ((List<Dictionary<string, object>>)sta.Run<object>(() => Shell.StartAppsList())).Count; }
            catch { }

            bool registry = false;
            try
            {
                var r = RegistryCmd.Read("HKLM", @"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName", "default");
                registry = r["value"] != null;
            }
            catch { }

            int nic = 0;
            try { nic = Network.Info().Count; } catch { }

            return new Dictionary<string, object>
            {
                ["version"] = Version,
                ["audio"] = audio,
                ["windows"] = windows,
                ["startapps"] = startapps,
                ["registry"] = registry,
                ["nic"] = nic
            };
        }

        private static int RunCliSelftest()
        {
            using (var sta = new StaExecutor())
            {
                Dictionary<string, object> result;
                try { result = BuildSelftest(sta); }
                catch (Exception ex)
                {
                    result = new Dictionary<string, object> { ["version"] = Version, ["error"] = ex.Message };
                }

                // Write directly to stdout as one UTF-8 line (no BOM).
                var utf8 = new UTF8Encoding(false);
                try { Console.OutputEncoding = utf8; } catch { }
                using (var w = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true })
                {
                    w.WriteLine(Json.Stringify(result));
                }

                bool ok = result.TryGetValue("registry", out var reg) && reg is bool rb && rb;
                ok = ok || (result.TryGetValue("audio", out var au) && au is bool ab && ab);
                ok = ok || (result.TryGetValue("nic", out var n) && n is int ni && ni > 0);
                return ok ? 0 : 1;
            }
        }

        // ---- parent lifetime ----
        private static void StartParentWatch(int parentPid)
        {
            var t = new Thread(() =>
            {
                IntPtr h = Native.OpenProcess(Native.SYNCHRONIZE, false, parentPid);
                if (h == IntPtr.Zero)
                {
                    Log.Write("parent pid " + parentPid + " not found; exiting.");
                    Shutdown(0);
                    return;
                }
                try
                {
                    Native.WaitForSingleObject(h, Native.INFINITE);
                    Log.Write("parent pid " + parentPid + " exited; shutting down.");
                    Shutdown(0);
                }
                finally { Native.CloseHandle(h); }
            })
            { IsBackground = true, Name = "parent-watch" };
            t.Start();
        }

        private static int _shuttingDown;
        private static void Shutdown(int code)
        {
            if (Interlocked.Exchange(ref _shuttingDown, 1) != 0) return;
            try { _watcher?.Stop(); } catch { }
            try { _sta?.Dispose(); } catch { }
            try { Out.Flush(); } catch { }
            Environment.Exit(code);
        }
    }

    // Thread-safe JSON Lines output to stdout.
    internal static class Out
    {
        private static readonly object _lock = new object();
        private static TextWriter _writer;

        public static void Init(TextWriter writer) { _writer = writer; }

        public static void WriteOk(object id, object data)
        {
            WriteLine(new Dictionary<string, object>
            {
                ["id"] = id,
                ["ok"] = true,
                ["data"] = data
            });
        }

        public static void WriteError(object id, string code, string message)
        {
            WriteLine(new Dictionary<string, object>
            {
                ["id"] = id,
                ["ok"] = false,
                ["code"] = code,
                ["message"] = message ?? ""
            });
        }

        public static void WriteEvent(string name, object data)
        {
            WriteLine(new Dictionary<string, object>
            {
                ["event"] = name,
                ["data"] = data
            });
        }

        private static void WriteLine(Dictionary<string, object> obj)
        {
            string json = Json.Stringify(obj);
            lock (_lock)
            {
                if (_writer == null) return;
                _writer.Write(json);
                _writer.Write('\n');
                _writer.Flush();
            }
        }

        public static void Flush()
        {
            lock (_lock) { _writer?.Flush(); }
        }
    }
}

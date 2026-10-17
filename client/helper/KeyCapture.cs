using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace GhostHelper
{
    /// <summary>
    /// keys.capture: while the client records a hotkey, a low-level keyboard hook takes the keys
    /// before Windows does (Win+D, Alt+Tab, the Start menu on Win) and reports each one as a "keys"
    /// event: {type: down|up, vk, scan, ext}. When it ends: {type: stopped, reason}.
    /// Safety: keys a program injects pass through (scenarios keep typing); a key-up whose key-down
    /// came before the capture passes through (no stuck modifiers); the hook ends by itself after
    /// timeoutMs, on keys.captureStop and with the helper. Win+L and Ctrl+Alt+Del cannot be taken.
    /// </summary>
    internal static class KeyCapture
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const uint WM_QUIT = 0x0012;
        private const uint WM_TIMER = 0x0113;
        private const uint LLKHF_EXTENDED = 0x01;
        private const uint LLKHF_INJECTED = 0x10;

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int ptX;
            public int ptY;
        }

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern UIntPtr SetTimer(IntPtr hWnd, UIntPtr nIDEvent, uint uElapse, IntPtr lpTimerFunc);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        private static readonly object Gate = new object();
        // kept in a field: the hook calls it for as long as it is installed
        private static readonly LowLevelKeyboardProc Proc = Hook;
        private static Thread _thread;
        // written by the hook thread, read by Stop: no lock, Start waits for the hook outside it
        private static int _threadId;
        private static IntPtr _hook;
        private static long _untilTicks;
        private static Action<string, object> _emit;
        /// <summary>keys whose key-down this capture took: only their key-ups are taken too</summary>
        private static readonly HashSet<uint> Held = new HashSet<uint>();
        /// <summary>events leave the hook at once and are written in order by one thread</summary>
        private static BlockingCollection<Dictionary<string, object>> _events;

        public static Dictionary<string, object> Start(Args args, Action<string, object> emit)
        {
            int timeoutMs = Keyboard.Clamp(args.GetInt("timeoutMs", 15000), 1000, 60000);
            var ready = new ManualResetEvent(false);
            string error = null;

            lock (Gate)
            {
                Interlocked.Exchange(ref _untilTicks, DateTime.UtcNow.AddMilliseconds(timeoutMs).Ticks);
                _emit = emit;
                if (_thread != null) return new Dictionary<string, object> { ["capturing"] = true };

                var events = new BlockingCollection<Dictionary<string, object>>();

                _events = events;
                lock (Held) Held.Clear();
                var writer = new Thread(() =>
                {
                    foreach (var item in events.GetConsumingEnumerable())
                    {
                        try { _emit?.Invoke("keys", item); } catch { }
                    }
                }) { IsBackground = true, Name = "keys.capture.out" };
                writer.Start();

                _thread = new Thread(() => Loop(ready, message => error = message, events)) { IsBackground = true, Name = "keys.capture" };
                _thread.Start();
            }

            if (!ready.WaitOne(3000)) error = error ?? "the hook did not start";
            if (error != null)
            {
                Stop();
                throw new HelperException("internal", error);
            }

            return new Dictionary<string, object> { ["capturing"] = true };
        }

        public static Dictionary<string, object> Stop()
        {
            // the time limit is over at once: the loop ends on its next timer tick even if the
            // quit message is lost (the thread had not started its loop yet)
            Interlocked.Exchange(ref _untilTicks, 0);
            int id = Volatile.Read(ref _threadId);
            if (id != 0) PostThreadMessage((uint)id, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            return new Dictionary<string, object> { ["stopped"] = id != 0 };
        }

        private static void Loop(ManualResetEvent ready, Action<string> fail, BlockingCollection<Dictionary<string, object>> events)
        {
            string reason = "stopped";

            Volatile.Write(ref _threadId, (int)GetCurrentThreadId());
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, Proc, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero)
            {
                fail("SetWindowsHookEx: error " + Marshal.GetLastWin32Error());
                Volatile.Write(ref _threadId, 0);
                lock (Gate) _thread = null;
                events.CompleteAdding();
                ready.Set();
                return;
            }

            // a thread timer: WM_TIMER comes to this loop, the time limit is checked there
            SetTimer(IntPtr.Zero, UIntPtr.Zero, 200, IntPtr.Zero);
            ready.Set();

            try
            {
                MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    if (msg.message == WM_TIMER && DateTime.UtcNow.Ticks > Interlocked.Read(ref _untilTicks))
                    {
                        reason = "timeout";
                        break;
                    }
                }
            }
            finally
            {
                UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
                Volatile.Write(ref _threadId, 0);
                lock (Gate) _thread = null;
                events.Add(new Dictionary<string, object> { ["type"] = "stopped", ["reason"] = reason });
                events.CompleteAdding();
            }
        }

        private static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0)
                {
                    var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    int message = wParam.ToInt32();
                    bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                    bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
                    var events = _events;

                    if ((info.flags & LLKHF_INJECTED) == 0 && (down || up) && events != null && !events.IsAddingCompleted)
                    {
                        bool take;
                        lock (Held)
                        {
                            if (down)
                            {
                                Held.Add(info.vkCode);
                                take = true;
                            }
                            else
                            {
                                take = Held.Remove(info.vkCode);
                            }
                        }

                        if (take)
                        {
                            events.Add(new Dictionary<string, object>
                            {
                                ["type"] = down ? "down" : "up",
                                ["vk"] = (int)info.vkCode,
                                ["scan"] = (int)(info.scanCode & 0xFF),
                                ["ext"] = (info.flags & LLKHF_EXTENDED) != 0
                            });
                            return (IntPtr)1;
                        }
                    }
                }
            }
            catch
            {
                // a broken event must never stop the keyboard
            }

            return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }
    }
}

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

namespace GhostHelper
{
    // Runs delegates on a single dedicated STA thread (required for Shell.Application COM).
    internal sealed class StaExecutor : IDisposable
    {
        private readonly BlockingCollection<Action> _queue = new BlockingCollection<Action>();
        private readonly Thread _thread;

        public StaExecutor()
        {
            _thread = new Thread(Loop) { IsBackground = true, Name = "sta-com" };
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
        }

        private void Loop()
        {
            foreach (var action in _queue.GetConsumingEnumerable())
            {
                try { action(); } catch (Exception ex) { Log.Write("STA action error: " + ex.Message); }
            }
        }

        // Enqueues fn on the STA thread and blocks the calling (pool) thread until it finishes.
        public T Run<T>(Func<T> fn)
        {
            using (var done = new ManualResetEventSlim(false))
            {
                T result = default(T);
                Exception error = null;
                _queue.Add(() =>
                {
                    try { result = fn(); }
                    catch (Exception ex) { error = ex; }
                    finally { done.Set(); }
                });
                done.Wait();
                if (error != null) throw error;
                return result;
            }
        }

        public void Dispose()
        {
            try { _queue.CompleteAdding(); } catch { }
        }
    }

    // Shell.Application-based commands (late-bound COM). All methods must run on an STA thread.
    internal static class Shell
    {
        public static List<Dictionary<string, object>> StartAppsList()
        {
            var result = new List<Dictionary<string, object>>();
            object shell = null, folder = null, items = null;
            try
            {
                shell = CreateShell();
                folder = Call(shell, "NameSpace", "shell:AppsFolder");
                if (folder == null) return result;
                items = Call(folder, "Items");
                if (items == null) return result;

                int count = Convert.ToInt32(Call(items, "Count"));
                for (int i = 0; i < count; i++)
                {
                    object item = null;
                    try
                    {
                        item = Call(items, "Item", i);
                        if (item == null) continue;

                        string name = Convert.ToString(Call(item, "Name"));
                        string appId = Convert.ToString(Call(item, "Path"));
                        string target = null;
                        try { target = Call(item, "ExtendedProperty", "System.Link.TargetParsingPath") as string; }
                        catch { target = null; }

                        result.Add(new Dictionary<string, object>
                        {
                            ["name"] = name,
                            ["appId"] = appId,
                            ["target"] = string.IsNullOrEmpty(target) ? null : target
                        });
                    }
                    finally { Release(item); }
                }
            }
            finally
            {
                Release(items);
                Release(folder);
                Release(shell);
            }
            return result;
        }

        public static void ShowDesktop()
        {
            object shell = null;
            try
            {
                shell = CreateShell();
                Call(shell, "MinimizeAll");
            }
            finally { Release(shell); }
        }

        private static object CreateShell()
        {
            Type t = Type.GetTypeFromProgID("Shell.Application");
            if (t == null) throw new HelperException("internal", "Shell.Application is not available.");
            return Activator.CreateInstance(t);
        }

        // Late-bound call that works for both COM methods and properties.
        private static object Call(object target, string name, params object[] args)
        {
            return target.GetType().InvokeMember(
                name,
                BindingFlags.InvokeMethod | BindingFlags.GetProperty,
                null, target, args);
        }

        private static void Release(object comObject)
        {
            if (comObject != null && Marshal.IsComObject(comObject))
            {
                try { Marshal.ReleaseComObject(comObject); } catch { }
            }
        }
    }
}

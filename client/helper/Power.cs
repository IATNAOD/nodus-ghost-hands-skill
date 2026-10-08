using System;
using System.Threading.Tasks;

namespace GhostHelper
{
    // Power / session / display actions.
    internal static class Power
    {
        public static void Lock()
        {
            Native.LockWorkStation();
        }

        // Replies first (caller sends {}), then suspends shortly after in the background.
        public static void SleepDeferred()
        {
            Task.Run(async () =>
            {
                await Task.Delay(700).ConfigureAwait(false);
                try { Native.SetSuspendState(false, false, false); }
                catch (Exception ex) { Log.Write("power.sleep failed: " + ex.Message); }
            });
        }

        public static void DisplayOff()
        {
            // 2 = power off the monitor.
            Native.PostMessage(Native.HWND_BROADCAST, Native.WM_SYSCOMMAND,
                new IntPtr(Native.SC_MONITORPOWER), new IntPtr(2));
        }
    }
}

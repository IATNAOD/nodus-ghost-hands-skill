using System;

namespace GhostHelper
{
    // Scenario commands work in physical pixels of the virtual desktop. The helper itself stays
    // DPI-unaware (old commands keep their coordinates): only the calling pool thread switches to
    // per-monitor awareness for one command, and gets its previous context back on Dispose.
    internal sealed class DpiScope : IDisposable
    {
        private readonly IntPtr _previous;

        public bool Aware { get; }

        private DpiScope(IntPtr previous, bool aware)
        {
            _previous = previous;
            Aware = aware;
        }

        public static DpiScope PerMonitorV2()
        {
            try
            {
                IntPtr previous = Native.SetThreadDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                // Windows 10 before 1703: no V2, the V1 context still gives physical pixels
                if (previous == IntPtr.Zero)
                    previous = Native.SetThreadDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
                return new DpiScope(previous, previous != IntPtr.Zero);
            }
            catch (EntryPointNotFoundException)
            {
                // before Windows 10 1607: coordinates stay virtualized on scaled monitors
                return new DpiScope(IntPtr.Zero, false);
            }
        }

        public void Dispose()
        {
            if (Aware) Native.SetThreadDpiAwarenessContext(_previous);
        }
    }
}

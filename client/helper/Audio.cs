using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace GhostHelper
{
    // Core Audio volume control via direct COM interop (no external libraries).
    internal static class Audio
    {
        private const int CLSCTX_ALL = 23;
        private const int eRender = 0;
        private const int eMultimedia = 1;

        public static Dictionary<string, object> Get()
        {
            return WithEndpointVolume(vol =>
            {
                float scalar;
                Marshal.ThrowExceptionForHR(vol.GetMasterVolumeLevelScalar(out scalar));
                bool muted;
                Marshal.ThrowExceptionForHR(vol.GetMute(out muted));
                return Result(scalar, muted);
            });
        }

        public static Dictionary<string, object> SetLevel(int level)
        {
            level = Clamp(level);
            return WithEndpointVolume(vol =>
            {
                Guid ctx = Guid.Empty;
                Marshal.ThrowExceptionForHR(vol.SetMasterVolumeLevelScalar(level / 100f, ref ctx));
                bool muted;
                Marshal.ThrowExceptionForHR(vol.GetMute(out muted));
                return Result(level / 100f, muted);
            });
        }

        public static Dictionary<string, object> ChangeLevel(int delta)
        {
            return WithEndpointVolume(vol =>
            {
                float scalar;
                Marshal.ThrowExceptionForHR(vol.GetMasterVolumeLevelScalar(out scalar));
                int current = (int)Math.Round(scalar * 100.0, MidpointRounding.AwayFromZero);
                int target = Clamp(current + delta);
                Guid ctx = Guid.Empty;
                Marshal.ThrowExceptionForHR(vol.SetMasterVolumeLevelScalar(target / 100f, ref ctx));

                bool muted;
                Marshal.ThrowExceptionForHR(vol.GetMute(out muted));
                // Turning the volume up unmutes, matching user expectation.
                if (delta > 0 && muted)
                {
                    Marshal.ThrowExceptionForHR(vol.SetMute(false, ref ctx));
                    muted = false;
                }
                return Result(target / 100f, muted);
            });
        }

        public static Dictionary<string, object> SetMute(bool muted)
        {
            return WithEndpointVolume(vol =>
            {
                Guid ctx = Guid.Empty;
                Marshal.ThrowExceptionForHR(vol.SetMute(muted, ref ctx));
                float scalar;
                Marshal.ThrowExceptionForHR(vol.GetMasterVolumeLevelScalar(out scalar));
                bool nowMuted;
                Marshal.ThrowExceptionForHR(vol.GetMute(out nowMuted));
                return Result(scalar, nowMuted);
            });
        }

        // ---- helpers ----
        private static int Clamp(int level) => level < 0 ? 0 : (level > 100 ? 100 : level);

        private static Dictionary<string, object> Result(float scalar, bool muted)
        {
            return new Dictionary<string, object>
            {
                ["level"] = (int)Math.Round(scalar * 100.0, MidpointRounding.AwayFromZero),
                ["muted"] = muted
            };
        }

        // Acquires the default render endpoint volume, runs fn, and always releases COM objects.
        private static Dictionary<string, object> WithEndpointVolume(Func<IAudioEndpointVolume, Dictionary<string, object>> fn)
        {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            object volObj = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();

                int hr = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia, out device);
                if (hr == Native.E_NOTFOUND || device == null)
                    throw new HelperException("no-audio-device", "No active audio output device.");
                Marshal.ThrowExceptionForHR(hr);

                Guid iid = typeof(IAudioEndpointVolume).GUID;
                Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volObj));

                var vol = (IAudioEndpointVolume)volObj;
                return fn(vol);
            }
            finally
            {
                if (volObj != null) Marshal.ReleaseComObject(volObj);
                if (device != null) Marshal.ReleaseComObject(device);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
        // Remaining methods (GetDevice, Register/Unregister notification) are unused.
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        // OpenPropertyStore, GetId, GetState are unused.
    }

    // vtable order per the Core Audio spec, up to the methods we need.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int GetChannelCount(out uint pnChannelCount);
        [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
        [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        // GetVolumeStepInfo, VolumeStepUp/Down, QueryHardwareSupport, GetVolumeRange are unused.
    }
}

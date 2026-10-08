using System;

namespace GhostHelper
{
    // Synthetic input: media transport keys via SendInput.
    internal static class Input
    {
        public static void MediaKey(string key)
        {
            ushort vk;
            switch (key)
            {
                case "play_pause": vk = Native.VK_MEDIA_PLAY_PAUSE; break;
                case "next": vk = Native.VK_MEDIA_NEXT_TRACK; break;
                case "prev": vk = Native.VK_MEDIA_PREV_TRACK; break;
                case "stop": vk = Native.VK_MEDIA_STOP; break;
                default:
                    throw new HelperException("invalid-args",
                        "key must be one of: play_pause, next, prev, stop");
            }
            SendKey(vk);
        }

        private static void SendKey(ushort vk)
        {
            var inputs = new Native.INPUT[2];
            inputs[0].type = Native.INPUT_KEYBOARD;
            inputs[0].U.ki = new Native.KEYBDINPUT { wVk = vk, dwFlags = 0 };
            inputs[1].type = Native.INPUT_KEYBOARD;
            inputs[1].U.ki = new Native.KEYBDINPUT { wVk = vk, dwFlags = Native.KEYEVENTF_KEYUP };

            uint sent = Native.SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != inputs.Length)
                throw new HelperException("internal", "SendInput failed (" + sent + "/" + inputs.Length + ").");
        }
    }
}

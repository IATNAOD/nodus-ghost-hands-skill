using System;
using System.Collections.Generic;
using System.Linq;
using Windows.Media.Control;

namespace GhostHelper
{
    // Media sessions of Windows (System Media Transport Controls): what the system media
    // flyout shows - a browser tab, a player. Real play and pause instead of the toggle key.
    // Called on a thread-pool (MTA) thread; WinRT async calls are awaited synchronously there.
    internal static class Media
    {
        // ---- media.control ----
        //   play   - nothing changes when something already plays (already: true)
        //   pause  - every playing session pauses; nothing plays - already: true
        //   toggle - pause what plays, else play the current session
        //   next / prev - the playing session, else the current one
        //   status - read only: { playing, sessions: [{ app, status }] }
        // Errors: no-session (nothing to control), refused (the app did not accept it).
        public static Dictionary<string, object> Control(string op)
        {
            var manager = GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask().GetAwaiter().GetResult();
            var sessions = manager.GetSessions().ToList();
            var current = manager.GetCurrentSession();

            if (sessions.Count == 0 && current == null)
                throw new HelperException("no-session", "No media session.");

            var playing = sessions.Where(IsPlaying).ToList();

            switch (op)
            {
                case "status":
                    return new Dictionary<string, object>
                    {
                        ["playing"] = playing.Count > 0,
                        ["sessions"] = sessions.Select(s => (object)new Dictionary<string, object> { ["app"] = AppOf(s), ["status"] = StatusOf(s) }).ToList()
                    };
                case "play":
                    if (playing.Count > 0) return Result(playing[0], true);
                    return Do(current ?? sessions[0], s => s.TryPlayAsync().AsTask().GetAwaiter().GetResult());
                case "pause":
                    if (playing.Count == 0) return Result(current ?? sessions[0], true);
                    bool paused = true;
                    foreach (var session in playing)
                        paused &= session.TryPauseAsync().AsTask().GetAwaiter().GetResult();
                    if (!paused) throw new HelperException("refused", "The player did not pause.");
                    return Result(playing[0], false);
                case "toggle":
                    if (playing.Count > 0) return Control("pause");
                    return Control("play");
                case "next":
                    return Do(playing.FirstOrDefault() ?? current ?? sessions[0], s => s.TrySkipNextAsync().AsTask().GetAwaiter().GetResult());
                case "prev":
                    return Do(playing.FirstOrDefault() ?? current ?? sessions[0], s => s.TrySkipPreviousAsync().AsTask().GetAwaiter().GetResult());
                default:
                    throw new HelperException("invalid-args", "Unknown op: " + op);
            }
        }

        private static string AppOf(GlobalSystemMediaTransportControlsSession session)
        {
            try { return session.SourceAppUserModelId; } catch { return null; }
        }

        private static string StatusOf(GlobalSystemMediaTransportControlsSession session)
        {
            try { return session.GetPlaybackInfo()?.PlaybackStatus.ToString().ToLowerInvariant(); }
            catch { return null; }
        }

        private static bool IsPlaying(GlobalSystemMediaTransportControlsSession session)
        {
            try { return session.GetPlaybackInfo()?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing; }
            catch { return false; }
        }

        private static Dictionary<string, object> Do(GlobalSystemMediaTransportControlsSession session, Func<GlobalSystemMediaTransportControlsSession, bool> action)
        {
            if (!action(session)) throw new HelperException("refused", "The player did not accept the command.");
            return Result(session, false);
        }

        private static Dictionary<string, object> Result(GlobalSystemMediaTransportControlsSession session, bool already)
        {
            return new Dictionary<string, object> { ["app"] = AppOf(session), ["already"] = already };
        }
    }
}

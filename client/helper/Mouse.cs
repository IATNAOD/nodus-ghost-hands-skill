using System;
using System.Collections.Generic;
using System.Threading;

namespace GhostHelper
{
    // Mouse input of scenarios, in physical pixels of the virtual desktop (DpiScope): the cursor
    // moves with SetCursorPos, buttons go as SendInput without a move.
    internal static class Mouse
    {
        // ---- input.mouse { action:"move"|"click"|"down"|"up", button, x?, y?, clicks, holdMs, intervalMs, smoothMs, guard, dryRun } → { x, y } ----
        public static Dictionary<string, object> Act(Args args)
        {
            string action = args.GetString("action", "click");
            if (action != "move" && action != "click" && action != "down" && action != "up") throw new HelperException("invalid-args", "action must be move, click, down or up");

            string button = args.GetString("button", "left");
            int clicks = Keyboard.Clamp(args.GetInt("clicks", 1), 1, 3);
            int hold = Keyboard.Clamp(args.GetInt("holdMs", 30), 0, 10000);
            int interval = Keyboard.Clamp(args.GetInt("intervalMs", 80), 0, 5000);
            int smooth = Keyboard.Clamp(args.GetInt("smoothMs", 0), 0, 5000);
            bool hasPoint = args.Has("x") && args.Has("y");
            bool dry = args.GetBool("dryRun", false);
            var described = new List<object>();
            ButtonInput(button, true); // validates the name

            using (DpiScope.PerMonitorV2())
            lock (InputGuard.Sync)
            {
                if (!dry) InputGuard.Check(args);

                if (hasPoint)
                {
                    int x = args.GetInt("x"), y = args.GetInt("y");
                    if (dry) described.Add(new Dictionary<string, object> { ["type"] = "move", ["x"] = x, ["y"] = y });
                    else Move(x, y, smooth);
                }

                switch (action)
                {
                    case "down":
                        Keyboard.Send(new[] { ButtonInput(button, true) }, dry, described);
                        break;
                    case "up":
                        Keyboard.Send(new[] { ButtonInput(button, false) }, dry, described);
                        break;
                    case "click":
                        for (int i = 0; i < clicks; i++)
                        {
                            if (i > 0 && !dry) Thread.Sleep(interval);
                            Keyboard.Send(new[] { ButtonInput(button, true) }, dry, described);
                            if (hold > 0 && !dry) Thread.Sleep(hold);
                            Keyboard.Send(new[] { ButtonInput(button, false) }, dry, described);
                        }
                        break;
                }

                Native.GetCursorPos(out var p);
                var result = new Dictionary<string, object> { ["x"] = p.X, ["y"] = p.Y };
                if (dry) result["inputs"] = described;
                return result;
            }
        }

        // ---- input.scroll { amount, horizontal?, x?, y?, guard, dryRun } ----
        // amount in notches: positive - up (or right), negative - down (or left)
        public static Dictionary<string, object> Scroll(Args args)
        {
            int amount = Keyboard.Clamp(args.GetInt("amount", required: true), -100, 100);
            bool horizontal = args.GetBool("horizontal", false);
            bool dry = args.GetBool("dryRun", false);
            var described = new List<object>();

            using (DpiScope.PerMonitorV2())
            lock (InputGuard.Sync)
            {
                if (!dry) InputGuard.Check(args);
                if (args.Has("x") && args.Has("y") && !dry) Move(args.GetInt("x"), args.GetInt("y"), 0);

                var input = new Native.INPUT { type = Native.INPUT_MOUSE };
                input.U.mi = new Native.MOUSEINPUT { mouseData = unchecked((uint)(amount * 120)), dwFlags = horizontal ? Native.MOUSEEVENTF_HWHEEL : Native.MOUSEEVENTF_WHEEL };
                int sent = Keyboard.Send(new[] { input }, dry, described);
                return Keyboard.Result(sent, dry, described);
            }
        }

        private static void Move(int x, int y, int smoothMs)
        {
            if (smoothMs > 0 && Native.GetCursorPos(out var from))
            {
                int steps = Math.Max(1, smoothMs / 10);
                for (int i = 1; i < steps; i++)
                {
                    double t = (double)i / steps;
                    t = t * t * (3 - 2 * t); // ease in and out
                    Native.SetCursorPos((int)Math.Round(from.X + (x - from.X) * t), (int)Math.Round(from.Y + (y - from.Y) * t));
                    Thread.Sleep(10);
                }
            }
            if (!Native.SetCursorPos(x, y)) throw new HelperException("input-blocked", "The cursor did not move.");
        }

        internal static Native.INPUT ButtonInput(string button, bool down)
        {
            uint flags, data = 0;
            switch (button)
            {
                case "left": flags = down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP; break;
                case "right": flags = down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP; break;
                case "middle": flags = down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP; break;
                case "x1": flags = down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP; data = Native.XBUTTON1; break;
                case "x2": flags = down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP; data = Native.XBUTTON2; break;
                default: throw new HelperException("invalid-args", "button must be left, right, middle, x1 or x2");
            }

            var input = new Native.INPUT { type = Native.INPUT_MOUSE };
            input.U.mi = new Native.MOUSEINPUT { dwFlags = flags, mouseData = data };
            return input;
        }
    }
}

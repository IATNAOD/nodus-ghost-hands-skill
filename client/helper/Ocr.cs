using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace GhostHelper
{
    // Text on the screen for scenarios: the OCR built into Windows 10 (Windows.Media.Ocr),
    // offline, with the recognition languages installed in Windows. Coordinates are physical
    // pixels of the virtual desktop. Called on a thread-pool (MTA) thread, like Media.
    internal static class Ocr
    {
        private const int Overlap = 96;

        // ---- ocr.languages → { languages:[{tag,name}], profile, maxDimension } ----
        public static Dictionary<string, object> Languages()
        {
            string profile = null;
            try { profile = OcrEngine.TryCreateFromUserProfileLanguages()?.RecognizerLanguage?.LanguageTag; }
            catch { }

            return new Dictionary<string, object>
            {
                ["languages"] = OcrEngine.AvailableRecognizerLanguages.Select(l => (object)new Dictionary<string, object> { ["tag"] = l.LanguageTag, ["name"] = l.DisplayName }).ToList(),
                ["profile"] = profile,
                ["maxDimension"] = (int)OcrEngine.MaxImageDimension
            };
        }

        // ---- ocr.read { monitors?|rect?|image?, lang?, upscale? } → { lang, lines:[{text, x,y,w,h, words:[{text,x,y,w,h}]}], ms } ----
        public static Dictionary<string, object> Read(Args args)
        {
            var watch = Stopwatch.StartNew();
            var engine = Engine(args.GetString("lang"));
            int upscale = Keyboard.Clamp(args.GetInt("upscale", 1), 1, 3);
            var lines = new List<object>();

            string image = args.GetString("image");
            if (!string.IsNullOrEmpty(image))
            {
                if (!File.Exists(image)) throw new HelperException("invalid-args", "No such image.");
                using (var bmp = new Bitmap(image))
                    lines.AddRange(Recognize(engine, bmp, 0, 0, upscale));
            }
            else
            {
                using (DpiScope.PerMonitorV2())
                {
                    foreach (var target in Screen.Targets(args))
                        using (var bmp = Screen.Grab(target.Value))
                            lines.AddRange(Recognize(engine, bmp, target.Value.Left, target.Value.Top, upscale));
                }
            }

            return new Dictionary<string, object>
            {
                ["lang"] = engine.RecognizerLanguage.LanguageTag,
                ["lines"] = lines,
                ["ms"] = (int)watch.ElapsedMilliseconds
            };
        }

        private static OcrEngine Engine(string tag)
        {
            OcrEngine engine;
            if (string.IsNullOrEmpty(tag))
            {
                engine = OcrEngine.TryCreateFromUserProfileLanguages();
            }
            else
            {
                Language language;
                try { language = new Language(tag); }
                catch (ArgumentException) { throw new HelperException("invalid-args", "Bad language tag."); }
                engine = OcrEngine.IsLanguageSupported(language) ? OcrEngine.TryCreateFromLanguage(language) : null;
            }
            if (engine == null) throw new HelperException("ocr-language", "No OCR language pack: " + (tag ?? "profile"));
            return engine;
        }

        // the bitmap at (ox, oy) of the screen; large ones in overlapping tiles, every line once
        private static List<object> Recognize(OcrEngine engine, Bitmap source, int ox, int oy, int upscale)
        {
            Bitmap scaled = upscale > 1 ? Upscale(source, upscale) : null;
            var bmp = scaled ?? source;
            try
            {
                int max = Math.Max(Overlap * 4, (int)OcrEngine.MaxImageDimension);
                var lines = new List<object>();

                foreach (int ty in Starts(bmp.Height, max))
                {
                    foreach (int tx in Starts(bmp.Width, max))
                    {
                        int tw = Math.Min(max, bmp.Width - tx), th = Math.Min(max, bmp.Height - ty);
                        using (var tile = bmp.Clone(new Rectangle(tx, ty, tw, th), PixelFormat.Format32bppArgb))
                        {
                            foreach (var line in RecognizeTile(engine, tile))
                            {
                                // a line in the overlap belongs to the tile where its centre is not near the edge
                                double cx = tx + line.X + line.W / 2, cy = ty + line.Y + line.H / 2;
                                if (!Owns(cx, tx, tw, bmp.Width) || !Owns(cy, ty, th, bmp.Height)) continue;
                                lines.Add(line.ToJson(tx, ty, upscale, ox, oy));
                            }
                        }
                    }
                }
                return lines;
            }
            finally
            {
                scaled?.Dispose();
            }
        }

        private static IEnumerable<int> Starts(int size, int max)
        {
            if (size <= max)
            {
                yield return 0;
                yield break;
            }
            for (int start = 0; ; start += max - Overlap)
            {
                if (start + max >= size)
                {
                    yield return Math.Max(0, size - max);
                    yield break;
                }
                yield return start;
            }
        }

        private static bool Owns(double centre, int start, int length, int total)
        {
            double from = start == 0 ? 0 : start + Overlap / 2.0;
            double to = start + length >= total ? total : start + length - Overlap / 2.0;
            return centre >= from && centre < to;
        }

        private static Bitmap Upscale(Bitmap source, int factor)
        {
            var bmp = new Bitmap(source.Width * factor, source.Height * factor, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, 0, 0, bmp.Width, bmp.Height);
            }
            return bmp;
        }

        private sealed class Box
        {
            public string Text;
            public double X, Y, W, H;
        }

        private sealed class Line
        {
            public string Text;
            public double X, Y, W, H;
            public List<Box> Words = new List<Box>();

            public Dictionary<string, object> ToJson(int tx, int ty, int upscale, int ox, int oy)
            {
                Dictionary<string, object> Rect(string text, double x, double y, double w, double h) => new Dictionary<string, object>
                {
                    ["text"] = text,
                    ["x"] = ox + (int)Math.Round((tx + x) / upscale),
                    ["y"] = oy + (int)Math.Round((ty + y) / upscale),
                    ["w"] = Math.Max(1, (int)Math.Round(w / upscale)),
                    ["h"] = Math.Max(1, (int)Math.Round(h / upscale))
                };

                var json = Rect(Text, X, Y, W, H);
                json["words"] = Words.Select(w => (object)Rect(w.Text, w.X, w.Y, w.W, w.H)).ToList();
                return json;
            }
        }

        private static List<Line> RecognizeTile(OcrEngine engine, Bitmap tile)
        {
            byte[] pixels = Screen.Pixels(tile, out int stride);
            // opaque: straight and premultiplied alpha are the same
            for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;

            using (var bitmap = SoftwareBitmap.CreateCopyFromBuffer(pixels.AsBuffer(), BitmapPixelFormat.Bgra8, tile.Width, tile.Height, BitmapAlphaMode.Premultiplied))
            {
                var result = engine.RecognizeAsync(bitmap).AsTask().GetAwaiter().GetResult();
                var lines = new List<Line>();

                foreach (var ocrLine in result.Lines)
                {
                    var line = new Line { Text = ocrLine.Text };
                    foreach (var word in ocrLine.Words)
                    {
                        var r = word.BoundingRect;
                        line.Words.Add(new Box { Text = word.Text, X = r.X, Y = r.Y, W = r.Width, H = r.Height });
                    }
                    if (line.Words.Count == 0) continue;

                    line.X = line.Words.Min(w => w.X);
                    line.Y = line.Words.Min(w => w.Y);
                    line.W = line.Words.Max(w => w.X + w.W) - line.X;
                    line.H = line.Words.Max(w => w.Y + w.H) - line.Y;
                    lines.Add(line);
                }
                return lines;
            }
        }
    }
}

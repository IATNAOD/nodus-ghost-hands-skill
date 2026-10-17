// Keys of scenarios: KeyboardEvent.code (what the recorder sees) → the scan code the helper
// sends (games read scan codes), the virtual key (for keys without one), a label, and the
// Electron accelerator for global hotkeys.

export interface KeyInfo {
  /** set 1 scan code; 0 - send the virtual key */
  scan: number;
  /** extended (E0) key */
  ext: boolean;
  vk: number;
  label: string;
  /** Electron accelerator name; "" - cannot be a global hotkey */
  accel: string;
}

const k = (scan: number, vk: number, label: string, accel = label, ext = false): KeyInfo => ({ scan, ext, vk, label, accel });
const e = (scan: number, vk: number, label: string, accel = label): KeyInfo => k(scan, vk, label, accel, true);
const v = (vk: number, label: string, accel = ""): KeyInfo => ({ scan: 0, ext: false, vk, label, accel });

const LETTER_SCANS = [0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c];
const F_SCANS = [0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76];

export const KEYS: Record<string, KeyInfo> = {
  ...Object.fromEntries(LETTER_SCANS.map((scan, i) => [`Key${String.fromCharCode(65 + i)}`, k(scan, 0x41 + i, String.fromCharCode(65 + i))])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, d) => [`Digit${d}`, k(d === 0 ? 0x0b : d + 1, 0x30 + d, String(d))])),
  ...Object.fromEntries(F_SCANS.map((scan, i) => [`F${i + 1}`, k(scan, 0x70 + i, `F${i + 1}`)])),

  Escape: k(0x01, 0x1b, "Esc", "Escape"),
  Tab: k(0x0f, 0x09, "Tab"),
  CapsLock: k(0x3a, 0x14, "CapsLock", "Capslock"),
  Space: k(0x39, 0x20, "Space"),
  Enter: k(0x1c, 0x0d, "Enter", "Enter"),
  Backspace: k(0x0e, 0x08, "Backspace"),
  Minus: k(0x0c, 0xbd, "-", "-"),
  Equal: k(0x0d, 0xbb, "=", "="),
  BracketLeft: k(0x1a, 0xdb, "[", "["),
  BracketRight: k(0x1b, 0xdd, "]", "]"),
  Backslash: k(0x2b, 0xdc, "\\", "\\"),
  Semicolon: k(0x27, 0xba, ";", ";"),
  Quote: k(0x28, 0xde, "'", "'"),
  Backquote: k(0x29, 0xc0, "`", "`"),
  Comma: k(0x33, 0xbc, ",", ","),
  Period: k(0x34, 0xbe, ".", "."),
  Slash: k(0x35, 0xbf, "/", "/"),
  IntlBackslash: k(0x56, 0xe2, "\\", ""),

  ControlLeft: k(0x1d, 0xa2, "Ctrl", "Control"),
  ControlRight: e(0x1d, 0xa3, "Ctrl", "Control"),
  ShiftLeft: k(0x2a, 0xa0, "Shift", "Shift"),
  ShiftRight: k(0x36, 0xa1, "Shift", "Shift"),
  AltLeft: k(0x38, 0xa4, "Alt", "Alt"),
  AltRight: e(0x38, 0xa5, "Alt", "Alt"),
  MetaLeft: e(0x5b, 0x5b, "Win", "Super"),
  MetaRight: e(0x5c, 0x5c, "Win", "Super"),
  ContextMenu: e(0x5d, 0x5d, "Menu", ""),

  Insert: e(0x52, 0x2d, "Insert"),
  Delete: e(0x53, 0x2e, "Delete"),
  Home: e(0x47, 0x24, "Home"),
  End: e(0x4f, 0x23, "End"),
  PageUp: e(0x49, 0x21, "PageUp"),
  PageDown: e(0x51, 0x22, "PageDown"),
  ArrowUp: e(0x48, 0x26, "↑", "Up"),
  ArrowDown: e(0x50, 0x28, "↓", "Down"),
  ArrowLeft: e(0x4b, 0x25, "←", "Left"),
  ArrowRight: e(0x4d, 0x27, "→", "Right"),

  NumLock: v(0x90, "NumLock", "Numlock"),
  Numpad0: k(0x52, 0x60, "Num0", "num0"),
  Numpad1: k(0x4f, 0x61, "Num1", "num1"),
  Numpad2: k(0x50, 0x62, "Num2", "num2"),
  Numpad3: k(0x51, 0x63, "Num3", "num3"),
  Numpad4: k(0x4b, 0x64, "Num4", "num4"),
  Numpad5: k(0x4c, 0x65, "Num5", "num5"),
  Numpad6: k(0x4d, 0x66, "Num6", "num6"),
  Numpad7: k(0x47, 0x67, "Num7", "num7"),
  Numpad8: k(0x48, 0x68, "Num8", "num8"),
  Numpad9: k(0x49, 0x69, "Num9", "num9"),
  NumpadDecimal: k(0x53, 0x6e, "Num.", "numdec"),
  NumpadAdd: k(0x4e, 0x6b, "Num+", "numadd"),
  NumpadSubtract: k(0x4a, 0x6d, "Num-", "numsub"),
  NumpadMultiply: k(0x37, 0x6a, "Num*", "nummult"),
  NumpadDivide: e(0x35, 0x6f, "Num/", "numdiv"),
  NumpadEnter: e(0x1c, 0x0d, "NumEnter", "Enter"),

  PrintScreen: v(0x2c, "PrintScreen", "PrintScreen"),
  ScrollLock: k(0x46, 0x91, "ScrollLock", "Scrolllock"),
  Pause: v(0x13, "Pause"),

  MediaPlayPause: v(0xb3, "⏯", "MediaPlayPause"),
  MediaTrackNext: v(0xb0, "⏭", "MediaNextTrack"),
  MediaTrackPrevious: v(0xb1, "⏮", "MediaPreviousTrack"),
  MediaStop: v(0xb2, "⏹", "MediaStop"),
  AudioVolumeMute: v(0xad, "🔇", "VolumeMute"),
  AudioVolumeDown: v(0xae, "🔉", "VolumeDown"),
  AudioVolumeUp: v(0xaf, "🔊", "VolumeUp"),
  BrowserBack: v(0xa6, "BrowserBack"),
  BrowserForward: v(0xa7, "BrowserForward"),
  BrowserRefresh: v(0xa8, "BrowserRefresh"),
  BrowserHome: v(0xac, "BrowserHome"),
  BrowserSearch: v(0xaa, "BrowserSearch"),
  LaunchMail: v(0xb4, "Mail"),
  LaunchApp2: v(0xb7, "Calculator"),
};

const MODIFIERS = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"];
const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Super"];

export const isModifier = (code: string): boolean => MODIFIERS.includes(code);

/** Modifiers first (Ctrl, Alt, Shift, Win), then the rest in the pressed order; unknown codes dropped. */
export function normalizeCombo(codes: string[]): string[] {
  const known = [...new Set(codes)].filter((code) => KEYS[code]);
  const mods = known.filter(isModifier).sort((a, b) => MODIFIER_ORDER.indexOf(KEYS[a].accel) - MODIFIER_ORDER.indexOf(KEYS[b].accel));

  return [...mods, ...known.filter((code) => !isModifier(code))].slice(0, 8);
}

/** "Ctrl+Shift+Esc" */
export const comboLabel = (codes: string[]): string => normalizeCombo(codes).map((code) => KEYS[code].label).join("+");

/** What the helper sends: scan codes, or virtual keys for keys without one. */
export const comboKeys = (codes: string[]): { scan: number; ext: boolean; vk: number }[] =>
  normalizeCombo(codes).map((code) => ({ scan: KEYS[code].scan, ext: KEYS[code].ext, vk: KEYS[code].vk }));

/**
 * Electron accelerator ("Control+Alt+K") for a global hotkey, or null: a hotkey needs at least
 * one modifier and exactly one other key that can be an accelerator (media keys may be alone).
 */
export function toAccelerator(codes: string[]): string | null {
  const combo = normalizeCombo(codes);
  const mods = [...new Set(combo.filter(isModifier).map((code) => KEYS[code].accel))];
  const keys = combo.filter((code) => !isModifier(code));

  if (keys.length !== 1 || !KEYS[keys[0]].accel) return null;

  const key = KEYS[keys[0]];
  const alone = key.scan === 0 || /^F\d+$/.test(keys[0]);
  if (!mods.length && !alone) return null;
  return [...mods, key.accel].join("+");
}

/** "Control+Alt+K" → codes, for showing a stored accelerator. */
export function fromAccelerator(accelerator: string): string[] {
  const codes: string[] = [];

  for (const part of accelerator.split("+")) {
    const mod = { Control: "ControlLeft", Ctrl: "ControlLeft", Alt: "AltLeft", Shift: "ShiftLeft", Super: "MetaLeft" }[part];
    if (mod) {
      codes.push(mod);
      continue;
    }
    const code = Object.keys(KEYS).find((name) => KEYS[name].accel === part && !isModifier(name));
    if (code) codes.push(code);
  }
  return normalizeCombo(codes);
}

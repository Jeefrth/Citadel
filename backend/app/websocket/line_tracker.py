"""Best-effort reconstruction of the command line typed in an interactive SSH session.

The terminal only sees keystrokes. Plain typing (with backspace, Ctrl+U,
Ctrl+C) is rebuilt from the input. When the line was edited with cursor
keys, Tab completion or history (escape sequences), the input alone is not
reliable, so the line is read back from the echoed output instead (text
after the last shell prompt marker). In full-screen applications (alternate
screen: vim, less, top...) the screen is not read: only the typed keys are
checked, and only a blocking decision is acted on (no journal noise). The
alternate-screen state comes from the output, which the user controls
(printf), so it must never switch the check off.

Keys that make readline run the line without Enter are handled at the shell
prompt: Ctrl+O (operate-and-get-next) counts as Enter, and the Ctrl+X prefix
(Ctrl+X Ctrl+E runs the line from an editor) is dropped.

This is a guard rail, not a sandbox: a determined user can obfuscate a
command (aliases, scripts, encodings). Session recordings remain the
source of truth for audit.
"""

import asyncio
import re
import time

ALT_ON = ("\x1b[?1049h", "\x1b[?1047h", "\x1b[?47h")
ALT_OFF = ("\x1b[?1049l", "\x1b[?1047l", "\x1b[?47l")
PROMPT_MARKERS = ("$ ", "# ", "> ", "% ")

ENTER = (b"\r", b"\n")
SHELL_ENTER = (b"\x0f",)  # Ctrl+O: readline operate-and-get-next runs the line
SHELL_DROP = (b"\x18",)   # Ctrl+X prefix (Ctrl+X Ctrl+E: edit-and-execute-command)
KILL_LINE = b"\x05\x15"  # Ctrl+E (end of line) then Ctrl+U (kill to start): clears readline


CSI_RE = re.compile(r"\x1b\[([0-9;?]*)([ -/]*)([@-~])")
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


class _ScreenLine:
    """Minimal emulation of the current output line with a cursor (enough for readline)."""

    def __init__(self) -> None:
        self.chars: list[str] = []
        self.cur = 0

    def text(self) -> str:
        return "".join(self.chars)

    def _csi(self, params: str, final: str) -> None:
        nums = [int(x) for x in params.replace("?", "").split(";") if x.isdigit()]
        n = nums[0] if nums else None
        if final == "D":                       # cursor left
            self.cur = max(0, self.cur - (n or 1))
        elif final == "C":                     # cursor right
            self.cur = min(len(self.chars), self.cur + (n or 1))
        elif final == "G":                     # cursor to column (1-based)
            self.cur = min(len(self.chars), max(0, (n or 1) - 1))
        elif final == "K":                     # erase in line
            if not n:                          # 0: to end
                del self.chars[self.cur:]
            elif n == 1:                       # 1: to start
                for i in range(min(self.cur + 1, len(self.chars))):
                    self.chars[i] = " "
            else:                              # 2: whole line
                self.chars = []
                self.cur = 0
        elif final == "@":                     # insert blanks
            for _ in range(n or 1):
                self.chars.insert(self.cur, " ")
        elif final == "P":                     # delete chars
            del self.chars[self.cur:self.cur + (n or 1)]
        elif final == "X":                     # erase chars
            for i in range(self.cur, min(len(self.chars), self.cur + (n or 1))):
                self.chars[i] = " "
        # colours (m), modes (h/l), screen ops (J, H...) do not change the line text

    def write(self, text: str) -> None:
        text = OSC_RE.sub("", text)
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                m = CSI_RE.match(text, i)
                if m:
                    self._csi(m.group(1), m.group(3))
                    i = m.end()
                else:
                    i += 2  # two-byte escape (ESC 7, ESC =, ...)
                continue
            if ch == "\n":
                self.chars, self.cur = [], 0
            elif ch == "\r":
                self.cur = 0
            elif ch == "\b":
                self.cur = max(0, self.cur - 1)
            elif ch == "\x07":
                pass
            elif ch >= " " or ch == "\t":
                if self.cur < len(self.chars):
                    self.chars[self.cur] = ch
                else:
                    self.chars.append(ch)
                self.cur += 1
            i += 1
        if len(self.chars) > 4000:
            self.chars = self.chars[-4000:]
            self.cur = min(self.cur, len(self.chars))


class LineTracker:
    def __init__(self) -> None:
        self.buf: list[str] = []
        self.uncertain = False
        self.screen = _ScreenLine()
        self.prompt_col: int | None = None  # where the command starts on the screen line
        self.alt_screen = False
        self.last_output = 0.0
        self.last_input = 0.0

    @property
    def out_line(self) -> str:
        return self.screen.text()

    # ── output side ──
    def on_output(self, data: bytes) -> None:
        self.last_output = time.monotonic()
        text = data.decode("utf-8", errors="replace")
        for seq in ALT_ON:
            if seq in text:
                self.alt_screen = True
        for seq in ALT_OFF:
            if seq in text:
                self.alt_screen = False
        self.screen.write(text)

    # ── input side ──
    def split(self, data: bytes) -> list[tuple[bytes, bool]]:
        """Split client input into (chunk, followed_by_enter) segments."""
        segments: list[tuple[bytes, bool]] = []
        start = 0
        for i, b in enumerate(data):
            key = bytes([b])
            if key in ENTER or (not self.alt_screen and key in SHELL_ENTER):
                segments.append((data[start:i], True))
                start = i + 1
            elif not self.alt_screen and key in SHELL_DROP:
                if i > start:
                    segments.append((data[start:i], False))
                start = i + 1
        if start < len(data):
            segments.append((data[start:], False))
        return segments

    def feed(self, chunk: bytes) -> None:
        self.last_input = time.monotonic()
        if not self.buf and not self.uncertain and self.prompt_col is None:
            # First key of a new command line: the prompt is on screen, remember its end
            self.prompt_col = len(self.screen.chars)
        text = chunk.decode("utf-8", errors="replace")
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                self.uncertain = True  # cursor keys, history, etc.
                m = CSI_RE.match(text, i)
                i = m.end() if m else i + 2
                continue
            if ch in ("\x7f", "\b"):
                if self.buf:
                    self.buf.pop()
            elif ch in ("\x15", "\x03"):  # Ctrl+U, Ctrl+C
                self.buf.clear()
                self.uncertain = False
            elif ch in ("\t", "\x12", "\x10", "\x0e", "\x01", "\x02", "\x06", "\x17", "\x0b", "\x19"):
                # Tab completion, Ctrl+R / P / N history, cursor moves, word kill, yank
                self.uncertain = True
            elif ch >= " ":
                self.buf.append(ch)
            i += 1

    def _from_output(self) -> str:
        line = self.out_line
        if self.prompt_col is not None and self.prompt_col <= len(line):
            return line[self.prompt_col:]
        markers = [line.rfind(m) + len(m) for m in PROMPT_MARKERS if m in line]
        return line[max(markers):] if markers else line

    async def settle(self, quiet: float = 0.08, max_wait: float = 0.6) -> None:
        """When the line was edited, wait for the remote echo of the last keys to arrive
        (bounded), so the screen line reflects what the shell will actually run."""
        if not self.uncertain:
            return
        deadline = time.monotonic() + max_wait
        while time.monotonic() < deadline:
            now = time.monotonic()
            if self.last_output > self.last_input and now - self.last_output >= quiet:
                return
            await asyncio.sleep(0.02)

    def take_line(self) -> str | None:
        """Command about to be executed (on Enter). Inside a full-screen app only the
        typed keys are returned (the screen line is not a command line there)."""
        typed = "".join(self.buf)
        line = typed if self.alt_screen or not self.uncertain else self._from_output()
        self.buf.clear()
        self.uncertain = False
        self.prompt_col = None
        return line.strip()

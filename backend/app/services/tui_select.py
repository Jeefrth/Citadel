"""Interactive list selector for the SSH proxy (lot 7): arrow keys, live filter,
Enter to choose, Esc to go back. Drawn on the alternate screen, so the user's
terminal is left clean when the session starts.

Selector holds the state and turns key presses into actions (pure, unit
tested); select() runs it against an asyncssh process.
"""

import unicodedata
from dataclasses import dataclass, field

import asyncssh

# Key sequences (raw terminal input)
UP = ("\x1b[A", "\x1bOA", "\x10")            # arrow up, application mode, Ctrl+P
DOWN = ("\x1b[B", "\x1bOB", "\x0e")          # arrow down, application mode, Ctrl+N
PGUP, PGDN = "\x1b[5~", "\x1b[6~"
HOME = ("\x1b[H", "\x1bOH", "\x1b[1~")
END = ("\x1b[F", "\x1bOF", "\x1b[4~")
ENTER = ("\r", "\n")
BACKSPACE = ("\x7f", "\b")
QUIT = ("\x03", "\x04")                        # Ctrl+C, Ctrl+D
CLEAR_FILTER = "\x15"                          # Ctrl+U

ALT_ON, ALT_OFF = "\x1b[?1049h", "\x1b[?1049l"
HIDE_CURSOR, SHOW_CURSOR = "\x1b[?25l", "\x1b[?25h"
REVERSE, DIM, BOLD, RESET = "\x1b[7m", "\x1b[2m", "\x1b[1m", "\x1b[0m"


def _fold(s: str) -> str:
    """Case and accent insensitive matching ("e" finds "é")."""
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def _fit(s: str, width: int) -> str:
    if width <= 0:
        return ""
    return s if len(s) <= width else s[: max(0, width - 1)] + "…"


@dataclass
class Item:
    label: str
    detail: str = ""
    value: object = None


@dataclass
class Selector:
    title: str
    items: list[Item]
    hint: str = ""
    query: str = ""
    cursor: int = 0
    top: int = 0
    _visible: list[int] = field(default_factory=list)

    def __post_init__(self):
        self._refilter()

    # ── state ──
    def _refilter(self) -> None:
        q = _fold(self.query).split()
        self._visible = [i for i, it in enumerate(self.items)
                         if all(t in _fold(f"{it.label} {it.detail}") for t in q)]
        self.cursor = min(self.cursor, max(0, len(self._visible) - 1))

    @property
    def visible(self) -> list[Item]:
        return [self.items[i] for i in self._visible]

    @property
    def current(self) -> Item | None:
        return self.items[self._visible[self.cursor]] if self._visible else None

    def feed(self, key: str, page: int = 10):
        """Apply one key. Returns ("select", Item) | ("back", None) | ("quit", None) | None."""
        if key in ENTER:
            return ("select", self.current) if self.current else None
        if key == "\x1b":
            if self.query:               # first Esc clears the filter, the next one goes back
                self.query = ""
                self._refilter()
                return None
            return ("back", None)
        if key in QUIT:
            return ("quit", None)
        n = len(self._visible)
        if key in UP:
            self.cursor = (self.cursor - 1) % n if n else 0
        elif key in DOWN:
            self.cursor = (self.cursor + 1) % n if n else 0
        elif key == PGUP:
            self.cursor = max(0, self.cursor - page)
        elif key == PGDN:
            self.cursor = min(max(0, n - 1), self.cursor + page)
        elif key in HOME:
            self.cursor = 0
        elif key in END:
            self.cursor = max(0, n - 1)
        elif key in BACKSPACE:
            if self.query:
                self.query = self.query[:-1]
                self._refilter()
        elif key == CLEAR_FILTER:
            self.query = ""
            self._refilter()
        elif len(key) == 1 and key >= " ":
            self.query += key
            self.cursor = 0
            self._refilter()
        return None

    # ── drawing ──
    def render(self, cols: int, rows: int) -> str:
        cols, rows = max(cols, 20), max(rows, 8)
        list_rows = rows - 5                                  # title, filter, blank, ..., blank, help
        if self.cursor < self.top:
            self.top = self.cursor
        elif self.cursor >= self.top + list_rows:
            self.top = self.cursor - list_rows + 1
        self.top = max(0, min(self.top, max(0, len(self._visible) - list_rows)))

        out = ["\x1b[H\x1b[2J", f"{BOLD}{_fit(self.title, cols)}{RESET}\r\n"]
        count = f"{len(self._visible)}/{len(self.items)}"
        out.append(_fit(f"Filtre : {self.query}", cols - len(count) - 1).ljust(cols - len(count) - 1)
                   + f" {DIM}{count}{RESET}\r\n\r\n")
        label_w = min(max((len(it.label) for it in self.items), default=10) + 2, max(12, cols // 2))
        shown = self._visible[self.top:self.top + list_rows]
        if not shown:
            out.append(f"  {DIM}Aucun résultat. Effacez le filtre (Échap) ou tapez autre chose.{RESET}\r\n")
        for row, idx in enumerate(shown):
            it = self.items[idx]
            line = _fit(f"  {it.label.ljust(label_w)}{it.detail}", cols - 1).ljust(cols - 1)
            out.append((f"{REVERSE}{line}{RESET}" if self.top + row == self.cursor else line) + "\r\n")
        out.append(f"\x1b[{rows};1H{DIM}"
                   + _fit(self.hint or "↑↓ choisir   Entrée valider   Échap revenir   tapez pour filtrer", cols - 1)
                   + RESET)
        return "".join(out)


def split_keys(data: str) -> list[str]:
    """Cut raw input into keys (escape sequences kept whole)."""
    keys, i = [], 0
    while i < len(data):
        c = data[i]
        if c == "\x1b" and i + 1 < len(data) and data[i + 1] in "[O":
            j = i + 2
            while j < len(data) and not ("@" <= data[j] <= "~"):
                j += 1
            keys.append(data[i:j + 1])
            i = j + 1
        else:
            keys.append(c)
            i += 1
    return keys


async def select(process, selector: Selector):
    """Run the selector on an asyncssh process (raw mode). Returns the chosen Item,
    "back" (Esc on an empty filter) or None (quit / connection closed)."""
    cols, rows = process.get_terminal_size()[:2]
    cols, rows = cols or 80, rows or 24
    process.stdout.write((ALT_ON + HIDE_CURSOR).encode())
    try:
        while True:
            process.stdout.write(selector.render(cols, rows).encode())
            try:
                data = await process.stdin.read(1024)
            except asyncssh.TerminalSizeChanged as e:
                cols, rows = e.width or cols, e.height or rows
                continue
            except (asyncssh.BreakReceived, asyncssh.SignalReceived):
                return None
            if not data:
                return None
            for key in split_keys(data.decode("utf-8", errors="ignore")):
                action = selector.feed(key, page=max(1, rows - 5))
                if action is None:
                    continue
                kind, item = action
                return item if kind == "select" else ("back" if kind == "back" else None)
    finally:
        process.stdout.write((SHOW_CURSOR + ALT_OFF).encode())

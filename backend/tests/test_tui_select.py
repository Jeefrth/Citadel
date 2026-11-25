"""Interactive selector of the SSH proxy: keys, filter, scrolling."""

from app.services.tui_select import Item, Selector, split_keys

ITEMS = [Item("lab-linux", "lab-linux Labo env=labo"), Item("lab-linux2", "Labo/Web role=app"),
         Item("lab-isolated", "Labo"), Item("prod-élysée", "10.0.0.9")]


def test_arrows_wrap_and_enter():
    s = Selector("t", ITEMS)
    assert s.current.label == "lab-linux"
    s.feed("\x1b[B"); s.feed("\x1b[B")
    assert s.current.label == "lab-isolated"
    s.feed("\x1b[A"); s.feed("\x1b[A"); s.feed("\x1b[A")
    assert s.current.label == "prod-élysée"          # wraps around
    assert s.feed("\r") == ("select", ITEMS[3])


def test_live_filter_accents_and_words():
    s = Selector("t", ITEMS)
    for c in "elysee":
        s.feed(c)
    assert [i.label for i in s.visible] == ["prod-élysée"]
    s.feed("\x7f"); s.feed("\x15")
    assert len(s.visible) == 4
    for c in "labo app":
        s.feed(c)
    assert [i.label for i in s.visible] == ["lab-linux2"]


def test_escape_clears_filter_then_goes_back_and_ctrl_c_quits():
    s = Selector("t", ITEMS)
    s.feed("q"); s.feed("q")
    assert s.visible == [] and s.feed("\r") is None    # nothing to select
    assert s.feed("\x1b") is None and len(s.visible) == 4
    assert s.feed("\x1b") == ("back", None)
    assert s.feed("\x03") == ("quit", None)


def test_split_keys_keeps_sequences():
    assert split_keys("ab\x1b[A\x1b[5~\r\x1b") == ["a", "b", "\x1b[A", "\x1b[5~", "\r", "\x1b"]


def test_render_scrolls_and_highlights():
    many = [Item(f"srv-{i:02d}") for i in range(50)]
    s = Selector("t", many)
    for _ in range(30):
        s.feed("\x1b[B")
    out = s.render(80, 12)
    assert "srv-30" in out and "srv-00" not in out and "\x1b[7m" in out and "50/50" in out

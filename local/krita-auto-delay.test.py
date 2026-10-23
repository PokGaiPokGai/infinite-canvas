"""Exercise native watch timing without a running Krita or real-time sleeps."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

core = types.ModuleType("PyQt5.QtCore")
for name in "QByteArray QBuffer QCoreApplication QIODevice QObject QThread QUuid".split():
    setattr(core, name, type(name, (), {}))
core.pyqtSignal = lambda *args: None
core.pyqtSlot = lambda *args: lambda method: method
core.Qt = types.SimpleNamespace(NoButton=0)
core.QEvent = types.SimpleNamespace(**{name: index for index, name in enumerate("ApplicationDeactivate MouseButtonPress MouseButtonDblClick TabletPress TouchBegin MouseButtonRelease TabletRelease TouchEnd TouchCancel KeyPress KeyRelease".split())})
gui = types.ModuleType("PyQt5.QtGui")
gui.QColorSpace = type("QColorSpace", (), {})
gui.QImage = type("QImage", (), {})
krita = types.ModuleType("krita")
krita.Extension = type("Extension", (), {})
krita.Krita = types.SimpleNamespace(instance=lambda: types.SimpleNamespace(activeDocument=lambda: object()))
with patch.dict(sys.modules, {"krita": krita, "PyQt5": types.ModuleType("PyQt5"), "PyQt5.QtCore": core, "PyQt5.QtGui": gui}):
    spec = importlib.util.spec_from_file_location("native_bridge", Path(__file__).parent / "krita-plugin/infinite_canvas_bridge/bridge.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)


class ClockCondition:
    def __init__(self):
        self.now = 0
        self.events = []
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def notify_all(self):
        pass
    def wait(self, timeout):
        if self.events and self.events[0][0] <= self.now + timeout:
            self.now, action = self.events.pop(0)
            action()
        else:
            self.now += timeout


def event(kind):
    return types.SimpleNamespace(type=lambda: kind, isAutoRepeat=lambda: False, buttons=lambda: 0, key=lambda: 1)


class WatchTiming(unittest.TestCase):
    def setUp(self):
        self.clock = ClockCondition()
        self.service = object.__new__(bridge.BridgeService)
        self.service.session_id = "session"
        self.service._watch_condition = self.clock
        self.service._revision = 0
        self.service._closing = False
        self.service._last_activity_at = 0
        self.service._held_inputs = set()
        self.timer = patch.object(bridge.time, "monotonic", lambda: self.clock.now)
        self.timer.start()
        self.addCleanup(self.timer.stop)
        self.service.eventFilter(None, event(core.QEvent.TabletRelease))

    def test_default_remains_two_seconds(self):
        self.assertTrue(self.service.watch(0)["changed"])
        self.assertEqual(self.clock.now, 2)

    def test_fractional_and_longer_delays(self):
        for delay in [0.25, 5, 120]:
            self.clock.now = 0
            if delay > 60:
                first = self.service.watch(0, delay)
                self.assertEqual(first["revision"], 0)
                self.assertFalse(first["changed"])
            self.assertTrue(self.service.watch(0, delay)["changed"])
            self.assertEqual(self.clock.now, delay)

    def test_new_stroke_restarts_the_idle_wait(self):
        self.clock.events = [(1, lambda: self.service.eventFilter(None, event(core.QEvent.TabletPress))),
                             (3, lambda: self.service.eventFilter(None, event(core.QEvent.TabletRelease)))]
        self.assertTrue(self.service.watch(0, 2)["changed"])
        self.assertEqual(self.clock.now, 5)

    def test_held_pen_never_reports_a_ready_change(self):
        self.service.eventFilter(None, event(core.QEvent.TabletPress))
        result = self.service.watch(0, 0.25)
        self.assertFalse(result["changed"])
        self.assertEqual(result["revision"], 0)
        self.assertEqual(self.clock.now, 60)

    def test_unchanged_revision_returns_only_keepalive(self):
        result = self.service.watch(self.service._revision, 0.25)
        self.assertFalse(result["changed"])
        self.assertEqual(self.clock.now, 60)

    def test_shutdown_ends_the_wait(self):
        self.clock.events = [(1, lambda: setattr(self.service, "_closing", True))]
        with self.assertRaises(bridge.BridgeError) as error:
            self.service.watch(0, 5)
        self.assertEqual(error.exception.status, 503)


if __name__ == "__main__":
    unittest.main()

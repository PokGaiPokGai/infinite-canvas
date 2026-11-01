"""Source selection without connecting to or modifying a real Blender."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
bpy = types.ModuleType("bpy")
sys.modules["bpy"] = bpy
spec = importlib.util.spec_from_file_location("commands", Path(__file__).with_name("blender-commands.py"))
commands = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commands)


class ActiveSource(unittest.TestCase):
    def setUp(self):
        self.window = object()
        self.other = object()
        self.area = types.SimpleNamespace(type="VIEW_3D")
        bpy.context = types.SimpleNamespace(window=self.window, area=self.area)
        self.entries = [({"id": "other", "kind": "viewport"}, (self.other, object(), None)),
                        ({"id": "current", "kind": "viewport"}, (self.window, self.area, None))]

    def test_current_area_not_first_window(self):
        self.assertEqual(commands.active_source_id(self.entries), "current")

    def test_timer_context_single_viewport(self):
        bpy.context.area = None
        self.assertEqual(commands.active_source_id(self.entries), "current")

    def test_ambiguous_views_are_not_guessed(self):
        bpy.context.area = None
        self.entries.append(({"id": "second", "kind": "viewport"}, (self.window, object(), None)))
        self.assertIsNone(commands.active_source_id(self.entries))

    def test_no_current_window(self):
        bpy.context.window = None
        self.assertIsNone(commands.active_source_id(self.entries))

    def test_active_render_editor(self):
        render = object()
        bpy.context.area = types.SimpleNamespace(type="IMAGE_EDITOR", spaces=types.SimpleNamespace(active=types.SimpleNamespace(image=render)))
        self.entries.append(({"id": "render", "kind": "render"}, render))
        self.assertEqual(commands.active_source_id(self.entries), "render")


if __name__ == "__main__":
    unittest.main()

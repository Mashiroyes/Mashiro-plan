import base64
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


RENDERER_PATH = (
    Path(__file__).resolve().parents[1] / "core" / "menu" / "render_help.py"
)


def load_renderer():
    spec = importlib.util.spec_from_file_location("mashirobot_help_renderer", RENDERER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_renderer(payload, output):
    encoded = base64.b64encode(
        json.dumps(payload, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    return subprocess.run(
        [
            sys.executable,
            str(RENDERER_PATH),
            "--payload-base64",
            encoded,
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


class HelpRendererTests(unittest.TestCase):
    def test_main_menu_is_readable_two_column_gradient(self):
        renderer = load_renderer()
        plugins = [
            {
                "name": "计划",
                "description": "计划、记录、作息与提醒",
                "menuIndex": 1,
            },
            {
                "name": "测试插件",
                "description": "第二张卡片用于验证双列布局",
                "menuIndex": 2,
            },
        ]

        image = renderer.render_main_menu(plugins, width=1200, columns=2)

        self.assertEqual(image.width, 1200)
        self.assertGreaterEqual(image.height, 600)
        self.assertNotEqual(image.getpixel((0, 0))[:3], (255, 255, 255))
        self.assertNotEqual(image.getpixel((1199, 0))[:3], (255, 255, 255))
        self.assertNotEqual(image.getpixel((0, 0))[:3], image.getpixel((1199, 0))[:3])
        self.assertIn("MashiroBot", image.info["mashirobot-text"])
        self.assertIn("计划", image.info["mashirobot-text"])
        self.assertIn("No.1", image.info["mashirobot-text"])

        # The centers of the first two cards are both visibly lighter than the background.
        self.assertGreater(sum(image.getpixel((315, 420))[:3]), sum(image.getpixel((20, 420))[:3]))
        self.assertGreater(sum(image.getpixel((885, 420))[:3]), sum(image.getpixel((1180, 420))[:3]))
        self.assertGreater(sum(abs(left - right) for left, right in zip(image.getpixel((167, 152))[:3], image.getpixel((20, 152))[:3])), 40)

    def test_main_menu_records_unavailable_plugin_notice(self):
        renderer = load_renderer()
        image = renderer.render_main_menu(
            [{"name": "计划", "description": "计划、记录、作息与提醒", "menuIndex": 1}],
            unavailable_plugin_count=2,
        )

        self.assertIn("另有 2 个插件不可用", image.info["mashirobot-text"])

    def test_detailed_help_cli_paginates_at_fixed_height(self):
        groups = []
        for group_index in range(10):
            groups.append(
                {
                    "title": f"功能组 {group_index + 1}",
                    "items": [
                        f"第 {item_index + 1} 条本地指令说明，保持手机端可读"
                        for item_index in range(8)
                    ],
                }
            )
        payload = {
            "kind": "plugin",
            "detailed": True,
            "plugin": {"name": "计划", "menuIndex": 1},
            "groups": groups,
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "detail-1.png"
            completed = run_renderer(payload, output)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            pages = sorted(output.parent.glob("detail-*.png"))
            self.assertGreaterEqual(len(pages), 2)
            for page in pages:
                with Image.open(page) as image:
                    self.assertEqual(image.width, 1200)
                    self.assertLessEqual(image.height, 1800)
                    self.assertIn("计划", image.info["mashirobot-text"])


if __name__ == "__main__":
    unittest.main()

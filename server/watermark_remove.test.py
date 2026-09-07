import json, os, subprocess, sys, tempfile, unittest
from PIL import Image, ImageDraw, ImageFont

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'watermark_remove.py')

def make_watermarked(path):
    """构造带右下角水印的测试图：纯色底 + 半透明白色圆角矩形 + 文字。"""
    img = Image.new('RGB', (400, 300), (120, 160, 200))
    d = ImageDraw.Draw(img, 'RGBA')
    d.rectangle([300, 230, 395, 290], fill=(255, 255, 255, 160))  # 半透明白块（模拟豆包水印）
    img.save(path, 'PNG')
    return img

class WatermarkTest(unittest.TestCase):
    def run_script(self, *args):
        r = subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=30)
        return r

    def test_inpaint_mode_removes_region(self):
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, 'in.png')
            make_watermarked(src)
            r = self.run_script(src, '--mode', 'auto')
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertTrue(out['ok'])
            self.assertEqual(out['mode'], 'inpaint')
            self.assertTrue(os.path.exists(out['output']))
            # 输出图尺寸不变，右下角水印像素应接近底色
            clean = Image.open(out['output'])
            self.assertEqual(clean.size, (400, 300))
            px = clean.convert('RGB').getpixel((350, 260))
            # 去水印后右下角应接近底色 (120,160,200)，容差 20（TELEA 插值不保证完全一致）
            self.assertTrue(abs(px[0] - 120) < 20 and abs(px[1] - 160) < 20 and abs(px[2] - 200) < 20,
                            f'pixel {px} not close to bg after inpaint')

    def test_crop_mode(self):
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, 'in.png')
            make_watermarked(src)
            r = self.run_script(src, '--mode', 'crop')
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertTrue(out['ok'])
            self.assertEqual(out['mode'], 'crop')
            clean = Image.open(out['output'])
            self.assertLess(clean.size[0], 400)  # 宽度被裁小（只裁右侧水印列）
            self.assertEqual(clean.size[1], 300)  # 高度不变（保留全部行）
            clean.close()  # 显式释放句柄（Windows 下懒加载句柄会阻塞临时目录清理）

    def test_missing_input_fails(self):
        r = self.run_script('/nonexistent/xx.png')
        self.assertEqual(r.returncode, 1)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertFalse(out['ok'])

if __name__ == '__main__':
    unittest.main()

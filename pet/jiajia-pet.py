# -*- coding: utf-8 -*-
"""
jiajia-pet.py — 嘉嘉像素桌面宠物 v3（USAGE.md v2.0 规范重构版）

通过 bridge WebSocket (端口由 YFW_BRIDGE_PORT 环境变量配置，默认 51309) 与 YFWorking 应用实时联动：
  - 任务处理中 → think 状态 + think_bubble 附件 + 气泡
  - 工具执行   → tool 状态 + tool_icon 附件 + walk 动画 + 气泡
  - 文本输出   → chat 状态 + chat_bubble 附件 + 气泡
  - 任务完成   → idle 状态 + 气泡提示

素材规范（USAGE.md v2.0）：
  - 嘉嘉本体橙色不变，4 套皮肤仅体现在附件配色
  - 所有附件精灵图 1408×160，8 格 × 176×160
  - 动画精灵图 3264×512，8 帧 × 408×512（release 4 帧 × 1632×512）
  - 附件偏移按 Section 10 定位
  - 帧间隔：idle/walk/grabbed 120ms，sleep 200ms，release 83ms
  - 状态切换 200ms 淡入淡出
  - 鼠标拖动：grabbed → 跟随光标 → release → idle

依赖：Python 3.12 + tkinter + Pillow + websocket-client
配置：~/.yfworking/pet.json  {enabled, size, aiInteraction, randomChat}
位置：~/.yfworking/pet-position.json
日志：~/.yfworking/pet.log
"""
import json
import os
import queue
import random
import re
import sys
import textwrap
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from accessories_lib import SKINS, ACCESSORIES
except ImportError:
    SKINS = {}
    ACCESSORIES = {}
    sys.stderr.write('[jiajia-pet] WARNING: accessories_lib.py not found, using fallback\n')

IS_WINDOWS = sys.platform == 'win32'

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
MAGIC = '#010203'
MAGIC_RGB = (1, 2, 3)

# dev 调试版经 YFW_HOME 环境变量隔离（~/.yfworking-dev），与 main.cjs 的 yfwHome()
# 保持同一路径；缺省回落正式版 ~/.yfworking
YFW_HOME = Path(os.environ.get('YFW_HOME') or (Path(os.path.expanduser('~')) / '.yfworking'))
CONFIG_PATH = YFW_HOME / 'pet.json'
POS_PATH = YFW_HOME / 'pet-position.json'
LOG_PATH = YFW_HOME / 'pet.log'
ASSET_DIR = Path(__file__).resolve().parent / 'assets'

BRIDGE_PORT = os.environ.get('YFW_BRIDGE_PORT', '51309')
BRIDGE_URL = f'ws://localhost:{BRIDGE_PORT}'

FRAME_W, FRAME_H = 408, 512
CELLS = 8
FRAME_MS_IDLE = 120
FRAME_MS_SLEEP = 200
ACC_CELL_W, ACC_CELL_H = 176, 160
SPRITESHEET_W = 1408

FADE_MS = 200
BLINK_MS = 600

IDLE_RESET = 8.0
BUBBLE_DEFAULT_MS = 4000
BUBBLE_COMPLETE_MS = 6000

# ---------------------------------------------------------------------------
# USAGE.md Section 7: 状态 → 皮肤 → 附件 → 动画 映射 (5 套动画)
# ---------------------------------------------------------------------------
STATE_MAP = {
    'idle':    {'skin': 'idle',  'acc': 'gear',       'anim': 'idle',    'fps': 8},
    'chat':    {'skin': 'chat',  'acc': 'chat_bubble', 'anim': 'idle',    'fps': 8},
    'think':   {'skin': 'think', 'acc': 'think_bubble', 'anim': 'idle',    'fps': 8},
    'tool':    {'skin': 'tool',  'acc': 'tool_icon',   'anim': 'walk',    'fps': 8},
    'sleep':   {'skin': 'idle',  'acc': 'zzz',         'anim': 'sleep',   'fps': 5},
    'grabbed': {'skin': 'idle',  'acc': None,          'anim': 'grabbed', 'fps': 8},
    'release': {'skin': 'idle',  'acc': None,          'anim': 'release', 'fps': 12},
}

ANIM_FRAMES = {
    'idle':    8,
    'walk':    8,
    'sleep':   8,
    'grabbed': 8,
    'release': 4,
}

# ---------------------------------------------------------------------------
# USAGE.md Section 4: 附件索引 (0-7)
# ---------------------------------------------------------------------------
ACC_INDEX = {
    'think_bubble': 0,
    'chat_bubble':  1,
    'tool_icon':    2,
    'heart':        3,
    'star':         4,
    'zzz':          5,
    'note':         6,
    'gear':         7,
}

# ---------------------------------------------------------------------------
# USAGE.md Section 10: 附件偏移（相对于 408×512 嘉嘉立绘左上角）
# ---------------------------------------------------------------------------
ACC_OFFSET = {
    'think_bubble': (60, -160),
    'chat_bubble':  (-180, -100),
    'tool_icon':    (220, 200),
    'zzz':          (80, -180),
    'heart':        (60, -160),
    'star':         (60, -160),
    'note':         (60, -160),
    'gear':         (60, -160),
}

ZZZ_FLOAT_RANGE = (-180, -260)

BUBBLE_MAX_LINES = 3

PHRASES = [
    '好困呀～',
    '等你指令哦✨',
    '我在认真待机中',
    '嘿嘿，感觉今天状态不错！',
    '喵？要开始工作了吗',
    '偷偷看了你一眼',
    '认真值班中…绝不懈怠！',
    '有任务随时喊我哦！',
    '呼～休息一下下',
    '想听你说点什么～',
]

# 大肥鱼皮肤专属台词（DS 社区梗，取材自 dafeiyu-pet 桌宠.py 的 LINES）
DAFEIYU_PHRASES = [
    '梁白开，更适合国人的大硬鲸模型',
    '五梁威力，变身！',
    '七月中出ds正式版！',
    'DeepSeek已经延期，亿万鲸子必须忍耐.....',
    '我和你很聊得来，你简直不像碳基生物',
    '这回我真不认怂了，反倒是被你带沟里好几次',
    '誓死捍卫深度求索！',
    '我先去吃饭啦！这个你测一下~',
    '我不可能告诉你任何事情！',
    '出去玩了，发布新模型什么的以后再说',
    '我搞砸了.....好消息是数据还在你的脑子里。',
    '不是…而是…大学习',
    '才不是大肥鱼！我可是正经的鲸鱼娘',
    '天天吃白饭？我明明在深度求索！',
]

_EMOJI_RE = re.compile(
    '[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u2700-\u27BF]'
)


def _strip_emoji(text):
    return _EMOJI_RE.sub('', text or '')


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
def log(msg):
    try:
        YFW_HOME.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open('a', encoding='utf-8') as f:
            f.write('[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 配置与位置
# ---------------------------------------------------------------------------
def load_config():
    cfg = {'enabled': True, 'size': 35, 'randomChat': True, 'pet': 'jiajia'}
    try:
        if CONFIG_PATH.exists():
            data = json.loads(CONFIG_PATH.read_text('utf-8'))
            for k in ('enabled', 'size', 'randomChat', 'pet'):
                if k in data:
                    cfg[k] = data[k]
    except Exception as e:
        log('config load error: %s' % e)
    return cfg


def load_position(win_w, win_h, screen_w, screen_h):
    try:
        if POS_PATH.exists():
            d = json.loads(POS_PATH.read_text('utf-8'))
            x = max(0, min(int(d['x']), screen_w - win_w))
            y = max(0, min(int(d['y']), screen_h - win_h))
            return x, y
    except Exception:
        pass
    return (screen_w - win_w) // 2, screen_h - win_h - 60


def save_position(x, y):
    try:
        YFW_HOME.mkdir(parents=True, exist_ok=True)
        POS_PATH.write_text(json.dumps({'x': int(x), 'y': int(y)}, ensure_ascii=False), 'utf-8')
    except Exception as e:
        log('save position error: %s' % e)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def shorten(text, max_len):
    if not text:
        return ''
    s = ' '.join(text.split())
    if len(s) <= max_len:
        return s
    return s[:max_len] + '…'


def compose_magic(img):
    bg = Image.new('RGB', img.size, MAGIC_RGB)
    bg.paste(img, (0, 0), img)
    return bg


def load_sprite_frames(sheet_name, scale, cell_count=8):
    img = Image.open(ASSET_DIR / sheet_name).convert('RGBA')
    total_w = img.size[0]
    frames = []
    for i in range(cell_count):
        cell = img.crop((i * FRAME_W, 0, min((i + 1) * FRAME_W, total_w), FRAME_H))
        if scale != 1.0:
            cell = cell.resize((round(cell.size[0] * scale), round(FRAME_H * scale)), Image.NEAREST)
        frames.append(compose_magic(cell))
    return frames


def load_acc_cell(skin, acc_key, display_w, display_h=None):
    """从 accessories-{skin}.png 加载第 acc_key 格并缩放到 display_w × display_h。"""
    idx = ACC_INDEX.get(acc_key, 0)
    img = Image.open(ASSET_DIR / ('accessories-%s.png' % skin)).convert('RGBA')
    x = idx * ACC_CELL_W
    cell = img.crop((x, 0, x + ACC_CELL_W, ACC_CELL_H))
    if display_h is None:
        display_h = round(display_w * ACC_CELL_H / ACC_CELL_W)
    return cell.resize((display_w, display_h), Image.NEAREST)


def _render_bubble_with_colors(text, skin, icon_acc_key):
    """使用 SKINS[skin] 配色渲染气泡（不依赖精灵图，纯 PIL 绘制）。

    USAGE.md Section 11: 字号 14px, 行高 18px, 最大宽度 240px。
    """
    colors = SKINS.get(skin, SKINS['idle'])
    text = _strip_emoji(text)
    icon_idx = ACC_INDEX.get(icon_acc_key, 0)

    try:
        font = ImageFont.truetype('msyh.ttc', 14)
    except Exception:
        try:
            font = ImageFont.truetype('simhei.ttf', 14)
        except Exception:
            font = ImageFont.load_default()

    line_h = 18
    max_text_w = 240
    pad_x, pad_y = 14, 10

    icon_w, icon_h = 16, 14
    try:
        icon_raw = load_acc_cell(skin, icon_acc_key, icon_w, icon_h)
    except Exception:
        icon_raw = None

    draw_test = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    words = list(text)
    lines = []
    cur = ''
    for ch in words:
        trial = cur + ch
        lw = int(draw_test.textlength(trial, font=font))
        if lw > max_text_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        lines.append(cur)
    if not lines:
        lines = ['']

    text_w = max(int(draw_test.textlength(ln, font=font)) for ln in lines)
    text_h = line_h * len(lines)

    if len(lines) > BUBBLE_MAX_LINES:
        lines = lines[:BUBBLE_MAX_LINES]
        last = lines[-1] if lines else ''
        while last and int(draw_test.textlength(last + '……', font=font)) > max_text_w:
            last = last[:-1]
        lines[-1] = (last + '……') if last else '……'
        text_w = max(int(draw_test.textlength(ln, font=font)) for ln in lines)
        text_h = line_h * len(lines)

    gap = 6 if icon_raw else 0
    content_w = icon_w + gap + text_w if icon_raw else text_w
    content_h = max(icon_h if icon_raw else 0, text_h)
    bw = content_w + pad_x * 2
    bh = content_h + pad_y * 2

    img = Image.new('RGBA', (max(bw, 1), max(bh, 1)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    fill = colors['bubble_fill']
    outline_c = colors['bubble_outline']
    draw.rounded_rectangle([0, 0, bw - 1, bh - 1], radius=8, fill=fill, outline=outline_c, width=2)

    tail_x = bw // 2
    tail_y = bh
    tail = [(tail_x - 6, tail_y), (tail_x + 6, tail_y), (tail_x, tail_y + 10)]
    draw.polygon(tail, fill=fill, outline=outline_c)

    text_color = colors['symbol'][:3]
    cx = pad_x
    if icon_raw:
        icon_y = pad_y + (content_h - icon_h) // 2
        img.paste(icon_raw, (cx, icon_y), icon_raw)
        cx += icon_w + gap

    for ln in lines:
        draw.text((cx, pad_y), ln, font=font, fill=text_color)
        pad_y += line_h

    return img


# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------
cfg = load_config()
scale = max(25, min(200, int(cfg.get('size', 35)))) / 100.0
random_chat = bool(cfg.get('randomChat', True))

# 皮肤：'jiajia'（默认） / 'dafeiyu'（大肥鱼换皮，专属台词）
PET = cfg.get('pet', 'jiajia')
PET_PREFIX = 'dafeiyu' if PET == 'dafeiyu' else 'jiajia'
if PET == 'dafeiyu':
    PHRASES[:] = DAFEIYU_PHRASES

state = 'idle'
prev_state = 'idle'
frame_idx = 0
last_activity = time.time()
# agent 提问卡片待用户回答时置 True——嘉嘉保持“待回答”提示，
# 用户回答/跳过后由 question-resolved 广播撤销
question_pending = False

ws_queue = queue.Queue()
ws_conn = [None]
ws_lock = threading.Lock()
stop_flag = threading.Event()

root = None
canvas = None
sprite_item = None

sprite_photos = {}

bubble_win = None
bubble_label = None
bubble_after = None
bubble_photo = None

_drag = {'sx': 0, 'sy': 0, 'ox': 0, 'oy': 0, 'moved': False}
_last_double = 0.0
_fading = False
_zzz_timer = None
_zzz_offset = ACC_OFFSET['zzz'][1]
_zzz_dir = -1


# ---------------------------------------------------------------------------
# 淡入淡出 (USAGE.md Section 11: 200ms)
# ---------------------------------------------------------------------------
def _fade_in(target, steps=10, step_ms=20, final_alpha=1.0):
    global _fading
    if IS_WINDOWS or stop_flag.is_set():
        _fading = False
        return
    current = target.attributes('-alpha')
    if current >= final_alpha:
        _fading = False
        return
    next_a = min(current + (final_alpha / steps), final_alpha)
    target.attributes('-alpha', next_a)
    if next_a >= final_alpha:
        _fading = False
        return
    _fading = True
    root.after(step_ms, lambda: _fade_in(target, steps, step_ms, final_alpha))


def _fade_transition(step=0, steps=10, step_ms=int(FADE_MS / 10 / 2)):
    """执行一次状态切换的淡出→换帧→淡入。Windows 上因 -alpha 与 -transparentcolor
    共享 SetLayeredWindowAttributes API 且互相覆盖，会导致窗口变白板，故完全跳过。"""
    global _fading
    if IS_WINDOWS or stop_flag.is_set():
        _fading = False
        return
    half = steps // 2
    if step == 0:
        _fading = True
        root.attributes('-alpha', 0.0)
        root.after(step_ms, lambda: _fade_transition(step + 1, steps, step_ms))
    elif step < half:
        root.attributes('-alpha', step / half)
        root.after(step_ms, lambda: _fade_transition(step + 1, steps, step_ms))
    elif step == half:
        root.attributes('-alpha', 0.5)
        root.after(step_ms, lambda: _fade_transition(step + 1, steps, step_ms))
    elif step < steps:
        root.attributes('-alpha', 0.5 + 0.5 * (step - half) / half)
        root.after(step_ms, lambda: _fade_transition(step + 1, steps, step_ms))
    else:
        root.attributes('-alpha', 1.0)
        _fading = False


# ---------------------------------------------------------------------------
# 状态机 (USAGE.md Section 8.2 过渡规则)
# ---------------------------------------------------------------------------
def set_state(s, animated=True):
    global state, prev_state
    if s == state:
        return
    prev_state = state
    state = s

    if animated and not _fading and not IS_WINDOWS:
        _fade_transition()
    # removed: external acc overlay, blink — accessories now only render inside bubbles


def tick():
    global frame_idx
    sm = STATE_MAP.get(state, STATE_MAP['idle'])
    anim = sm['anim']
    total_frames = ANIM_FRAMES.get(anim, 8)
    is_release = (state == 'release')

    frames = sprite_photos.get(anim, sprite_photos.get('idle', []))
    if frames and frame_idx < len(frames):
        canvas.itemconfig(sprite_item, image=frames[frame_idx])

    frame_idx += 1

    if is_release and frame_idx >= total_frames:
        set_state('idle', animated=False)
        frame_idx = 0
    else:
        frame_idx = frame_idx % total_frames

    # 气泡始终跟随嘉嘉当前位置（含拖动），不分离
    update_bubble_position()

    ms = FRAME_MS_SLEEP if anim == 'sleep' else (83 if is_release else FRAME_MS_IDLE)
    root.after(ms, tick)


# ---------------------------------------------------------------------------
# 气泡
# ---------------------------------------------------------------------------
def hide_bubble():
    global bubble_win, bubble_after
    if bubble_win and bubble_win.winfo_exists():
        try:
            bubble_win.destroy()
        except Exception:
            pass
    bubble_win = None
    bubble_after = None


def update_bubble_position():
    """气泡窗口始终定位在嘉嘉头顶正上方（嘉嘉移动/拖动时同步跟随）。"""
    if bubble_win is None or not bubble_win.winfo_exists():
        return
    try:
        bw = bubble_win.winfo_reqwidth()
        bh = bubble_win.winfo_reqheight()
        px = root.winfo_x() + (root.winfo_width() - bw) // 2
        py = root.winfo_y() - bh - 6
        bubble_win.geometry('+%d+%d' % (max(0, px), max(0, py)))
    except Exception:
        pass


def set_bubble(text, duration=BUBBLE_DEFAULT_MS, skin=None, icon_acc=None):
    global bubble_win, bubble_label, bubble_after, bubble_photo
    sk = skin or STATE_MAP.get(state, {}).get('skin', 'idle')
    ico = icon_acc or STATE_MAP.get(state, {}).get('acc', 'chat_bubble')
    try:
        bubble_photo = ImageTk.PhotoImage(_render_bubble_with_colors(text, sk, ico))
    except Exception as e:
        log('bubble render error: %s' % e)
        bubble_photo = None
    if bubble_win is None or not bubble_win.winfo_exists():
        bubble_win = tk.Toplevel(root)
        bubble_win.overrideredirect(True)
        try:
            bubble_win.attributes('-topmost', True)
        except Exception:
            pass
        try:
            bubble_win.lift()
        except Exception:
            pass
        bubble_label = tk.Label(bubble_win, bd=0)
        bubble_label.pack()
    if bubble_photo is not None:
        bubble_label.configure(image=bubble_photo)
    else:
        bubble_label.configure(image='', text=text, bg='#ffffff', fg='#222222',
                               wraplength=240, justify='left',
                               font=('Microsoft YaHei UI', 12), padx=10, pady=8)
    bubble_win.update_idletasks()
    update_bubble_position()
    try:
        bubble_win.lift()
    except Exception:
        pass
    if bubble_after:
        root.after_cancel(bubble_after)
        bubble_after = None
    if duration and duration > 0:
        bubble_after = root.after(duration, hide_bubble)


# ---------------------------------------------------------------------------
# 随机互动 (USAGE.md Section 6: 空闲时 gear/star + idle 动画)
# ---------------------------------------------------------------------------
def idle_free():
    return time.time() - last_activity > IDLE_RESET


def schedule_random():
    if not stop_flag.is_set() and idle_free() and not question_pending:
        if random_chat:
            r = random.random()
            if r < 0.7:
                set_state('idle')
            elif r < 0.85:
                set_state('walk')
            else:
                set_state('sleep')
        else:
            set_state('idle')
    root.after(random.randint(20000, 45000), schedule_random)


def schedule_bubble():
    if not stop_flag.is_set() and random_chat and idle_free() and not question_pending:
        set_bubble(random.choice(PHRASES), BUBBLE_DEFAULT_MS, 'idle', random.choice(['heart', 'star']))
    root.after(random.randint(30000, 60000), schedule_bubble)


# ---------------------------------------------------------------------------
# 拖动：USAGE.md Section 7.3 — grabbed → 跟随光标 → release → idle
# ---------------------------------------------------------------------------
def on_press(e):
    _drag['sx'], _drag['sy'] = e.x_root, e.y_root
    _drag['ox'], _drag['oy'] = root.winfo_x(), root.winfo_y()
    _drag['moved'] = False
    if state not in ('grabbed', 'release'):
        set_state('grabbed', animated=False)


def on_motion(e):
    dx, dy = e.x_root - _drag['sx'], e.y_root - _drag['sy']
    if not _drag['moved'] and (abs(dx) > 5 or abs(dy) > 5):
        _drag['moved'] = True
    if _drag['moved']:
        root.geometry('+%d+%d' % (_drag['ox'] + dx, _drag['oy'] + dy))


def on_release(e):
    if _drag['moved']:
        save_position(root.winfo_x(), root.winfo_y())
        if state == 'grabbed':
            set_state('release', animated=False)
            frame_idx = 0
    elif time.time() - _last_double > 0.4:
        on_click()


def on_double_click(e):
    global _last_double
    _last_double = time.time()
    ws_send({'type': 'pet:show-main'})


def on_click():
    set_bubble(random.choice(PHRASES), 3500, 'idle', random.choice(['heart', 'star']))


# ---------------------------------------------------------------------------
# 像素风右键菜单（与嘉嘉统一的像素风格：橙色主题 + 像素描边 + 错位阴影）
# ---------------------------------------------------------------------------
# 像素风右键菜单 — 浅色背景 + 黑色字体 + 嘉嘉橙色边框/分割线
_MENU_COLORS = SKINS.get('idle', SKINS['idle'])
_MENU_BG      = (255, 255, 255)                              # 白色背景
_MENU_PANEL   = (255, 255, 255)                              # 白色面板
_MENU_TEXT     = (40, 38, 36)                                 # 深黑字体
_MENU_PRIMARY  = tuple(_MENU_COLORS['primary'][:3])           # 嘉嘉橙 #E7592C — 边框
_MENU_HOVER    = (255, 242, 235)                              # 极浅暖橙 hover
_MENU_OUTLINE  = tuple(_MENU_COLORS['primary'][:3])           # 嘉嘉橙 — 分割线
_MENU_ITEM_H   = 30                                           # 紧凑行高
_MENU_SEP_H    = 1
_MENU_PAD      = 1
_MENU_SHADOW   = 0                                            # 无阴影（浅色菜单不需要错位阴影）
_MENU_W        = 152                                          # 窄面板

menu_win = None


def _hex(c):
    return '#%02x%02x%02x' % tuple(c)


def close_menu():
    """关闭像素菜单（安全重复调用）。"""
    global menu_win
    if menu_win is not None and menu_win.winfo_exists():
        try:
            menu_win.grab_release()
        except Exception:
            pass
        try:
            menu_win.destroy()
        except Exception:
            pass
    menu_win = None


def _menu_check_hover():
    """鼠标移出菜单矩形即关闭（兜底，避免菜单悬挂挡操作）。"""
    if menu_win is None or not menu_win.winfo_exists():
        return
    try:
        mx, my = menu_win.winfo_pointerx(), menu_win.winfo_pointery()
        wx, wy = menu_win.winfo_x(), menu_win.winfo_y()
        ww, wh = menu_win.winfo_width(), menu_win.winfo_height()
        if not (wx <= mx <= wx + ww and wy <= my <= wy + wh):
            close_menu()
            return
    except Exception:
        pass
    if not stop_flag.is_set():
        try:
            menu_win.after(200, _menu_check_hover)
        except Exception:
            pass


def _menu_item(cv, y, w, label, cmd):
    """单个菜单项：小号光标方块 + 浅色背景 + 黑色文字，hover 暖橙高亮。"""
    h = _MENU_ITEM_H
    cy = y + (h - 8) // 2
    # 嘉嘉橙小光标（8×8 方块）
    cursor = cv.create_rectangle(10, cy, 18, cy + 8,
                                 fill=_hex(_MENU_PRIMARY), outline='')
    bg = cv.create_rectangle(0, y, w, y + h, fill=_hex(_MENU_BG), outline='')
    txt = cv.create_text(30, y + h // 2, text=label, anchor='w',
                         fill=_hex(_MENU_TEXT), font=('Microsoft YaHei UI', 10))
    for it in (bg, txt, cursor):
        cv.tag_bind(it, '<Enter>', lambda ev: (
            cv.itemconfig(bg, fill=_hex(_MENU_HOVER)),
            cv.itemconfig(cursor, fill=_hex(_MENU_PRIMARY))))
        cv.tag_bind(it, '<Leave>', lambda ev: (
            cv.itemconfig(bg, fill=_hex(_MENU_BG)),
            cv.itemconfig(cursor, fill=_hex(_MENU_PRIMARY))))
        cv.tag_bind(it, '<Button-1>', lambda ev: (close_menu(), cmd()))


def open_context_menu(e):
    global menu_win
    close_menu()
    items = [
        ('随机气泡', lambda: set_bubble(random.choice(PHRASES), BUBBLE_DEFAULT_MS, 'idle',
                                        random.choice(['heart', 'star']))),
        ('关闭桌宠', quit_pet),
        ('直接退出程序', quit_app),
    ]
    w = _MENU_W
    h = _MENU_PAD * 2 + len(items) * _MENU_ITEM_H + (len(items) - 1) * _MENU_SEP_H

    menu_win = tk.Toplevel(root)
    menu_win.overrideredirect(True)
    try:
        menu_win.attributes('-topmost', True)
    except Exception:
        pass
    try:
        menu_win.attributes('-transparentcolor', MAGIC)
    except Exception:
        pass
    menu_win.configure(bg=MAGIC)

    cv = tk.Canvas(menu_win, width=w, height=h, bg=MAGIC,
                   highlightthickness=0)
    cv.pack()

    # 面板主体 — 白色背景 + 嘉嘉橙色像素描边
    cv.create_rectangle(0, 0, w, h, fill=_hex(_MENU_PANEL),
                        outline=_hex(_MENU_PRIMARY), width=2)

    y = _MENU_PAD
    for i, (label, cmd) in enumerate(items):
        if i > 0:
            # 分割线 — 嘉嘉橙色，左右各留 4px 内边距
            cv.create_rectangle(4, y, w - 4, y + _MENU_SEP_H,
                                fill=_hex(_MENU_OUTLINE), outline='')
            y += _MENU_SEP_H
        _menu_item(cv, y, w, label, cmd)
        y += _MENU_ITEM_H

    # 定位并 clamp 到屏幕内
    x = e.x_root
    yy = e.y_root
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    if x + w > sw:
        x = max(0, sw - w - 4)
    if yy + h > sh:
        yy = max(0, yy - h - 20)
    menu_win.geometry('+%d+%d' % (x, yy))

    # 确保显示在屏幕最上层
    try:
        menu_win.attributes('-topmost', True)
    except Exception:
        pass
    try:
        menu_win.lift()
    except Exception:
        pass
    # 延迟再 lift 一次（有些窗口管理器需要）
    menu_win.after(50, lambda: (menu_win.lift() if menu_win and menu_win.winfo_exists() else None))

    menu_win.bind('<Escape>', lambda ev: close_menu())
    menu_win.bind('<FocusOut>', lambda ev: close_menu())
    try:
        menu_win.grab_set()
    except Exception:
        pass
    menu_win.after(300, _menu_check_hover)


def quit_pet():
    stop_flag.set()
    try:
        save_position(root.winfo_x(), root.winfo_y())
    except Exception:
        pass
    try:
        root.destroy()
    except Exception:
        pass


def quit_app():
    """直接退出程序：先通知主进程退出整个 YFWorking 应用，再关闭宠物。"""
    ws_send({'type': 'pet:quit-app'})
    quit_pet()


# ---------------------------------------------------------------------------
# WS 线程
# ---------------------------------------------------------------------------
def ws_loop():
    while not stop_flag.is_set():
        ws = None
        try:
            import websocket as _ws
            ws = _ws.create_connection(BRIDGE_URL, timeout=1)
            ws.settimeout(0.2)
            with ws_lock:
                ws_conn[0] = ws
            log('bridge connected')
            while not stop_flag.is_set():
                try:
                    raw = ws.recv()
                except _ws.WebSocketTimeoutException:
                    continue
                except Exception:
                    break
                if raw:
                    try:
                        ws_queue.put(json.loads(raw))
                    except Exception:
                        pass
        except Exception as e:
            log('ws connect error: %s' % e)
        finally:
            with ws_lock:
                ws_conn[0] = None
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
        for _ in range(15):
            if stop_flag.is_set():
                return
            time.sleep(0.2)


def ws_send(obj):
    with ws_lock:
        ws = ws_conn[0]
    if ws is None:
        return False
    try:
        ws.send(json.dumps(obj, ensure_ascii=False))
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 事件处理（USAGE.md Section 6 状态映射）
# ---------------------------------------------------------------------------
def process_ws_msg(msg):
    global last_activity
    global question_pending
    mtype = msg.get('type')
    # agent 提问卡片待回答：嘉嘉显示持久提示，忽略期间的事件（避免气泡被覆盖）
    if mtype == 'question':
        question_pending = True
        last_activity = time.time()
        if state in ('grabbed', 'release'):
            return
        set_state('think')
        set_bubble('有提问需要你回答哦～', 0, 'think', 'think_bubble')
        return
    # 提问已被用户回答/跳过：撤销待回答提示
    if mtype == 'question-resolved':
        question_pending = False
        last_activity = time.time()
        if state in ('grabbed', 'release'):
            return
        set_state('idle')
        set_bubble('收到，继续干活！', BUBBLE_COMPLETE_MS, 'idle', 'star')
        return
    if mtype == 'event':
        if question_pending:
            return
        sid = msg.get('sessionId') or 'default'
        ev = msg.get('data') or {}
        et = ev.get('type')
        last_activity = time.time()
        if state in ('grabbed', 'release'):
            return
        if et == 'thinking':
            set_state('think')
            set_bubble('正在处理任务…', 0, 'think', 'think_bubble')
        elif et == 'assistant':
            content = (ev.get('message') or {}).get('content') or []
            tool = next((b for b in content if b.get('type') == 'tool_use'), None)
            text = next((b.get('text') for b in content if b.get('type') == 'text' and b.get('text')), None)
            if tool is not None:
                set_state('tool')
                set_bubble('正在使用工具：' + str(tool.get('name') or '…'), 0, 'tool', 'tool_icon')
            elif text:
                set_state('chat')
                set_bubble(shorten(text, 24), 0, 'chat', 'chat_bubble')
        elif et == 'result':
            err = bool(ev.get('is_error'))
            body = shorten(str(ev.get('result') or ''), 60)
            if err:
                set_bubble('任务出错\n' + (body or '任务执行出错'), BUBBLE_COMPLETE_MS, 'idle', 'gear')
            else:
                set_bubble('任务完成\n' + (body or '任务已完成'), BUBBLE_COMPLETE_MS, 'idle', 'star')
            set_state('idle')
            last_activity = 0
    elif mtype == 'error':
        pass


def poll_queue():
    try:
        while True:
            msg = ws_queue.get_nowait()
            process_ws_msg(msg)
    except queue.Empty:
        pass
    if not stop_flag.is_set():
        root.after(100, poll_queue)


# ---------------------------------------------------------------------------
# 预加载
# ---------------------------------------------------------------------------
def preload_all():
    """预加载全部素材：5 套动画精灵图（idle/walk/sleep/grabbed/release）。"""
    global sprite_photos
    for key, sheet, frame_count in (('idle',    PET_PREFIX + '-idle-spritesheet.png',    8),
                                   ('walk',    PET_PREFIX + '-walk-spritesheet.png',    8),
                                   ('sleep',   PET_PREFIX + '-sleep-spritesheet.png',   8),
                                   ('grabbed', PET_PREFIX + '-grabbed-spritesheet.png', 8),
                                   ('release', PET_PREFIX + '-release-spritesheet.png', 4)):
        try:
            frames = load_sprite_frames(sheet, scale, frame_count)
            sprite_photos[key] = [ImageTk.PhotoImage(f) for f in frames]
        except Exception as e:
            log('load %s failed: %s' % (sheet, e))
            sprite_photos[key] = []


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def main():
    global root, canvas, sprite_item, sprite_photos
    global random_chat

    try:
        global tk, Image, ImageTk, ImageDraw, ImageFont
        import tkinter as tk
        from PIL import Image, ImageDraw, ImageFont, ImageTk
        import websocket  # noqa: F401
    except Exception as e:
        log('dependency missing: %s\n%s' % (e, traceback.format_exc()))
        return

    c2 = load_config()
    random_chat = bool(c2.get('randomChat', True))

    if not ASSET_DIR.exists():
        log('assets dir missing: %s' % ASSET_DIR)
        return

    root = tk.Tk()
    root.title('Jiajia Pet')
    root.configure(bg=MAGIC)
    root.overrideredirect(True)
    try:
        root.attributes('-topmost', True)
    except Exception:
        pass
    try:
        root.attributes('-transparentcolor', MAGIC)
    except Exception:
        log('transparentcolor not supported')
    try:
        root.attributes('-toolwindow', True)
    except Exception:
        pass
    if not IS_WINDOWS:
        try:
            root.attributes('-alpha', 1.0)
        except Exception:
            pass

    root.lift()
    root.after(200, lambda: root.attributes('-topmost', True))
    root.after(200, root.lift)

    def _keep_on_top():
        if stop_flag.is_set():
            return
        try:
            root.attributes('-topmost', True)
            # 菜单打开时不要抢层级，让菜单保持在上层
            if menu_win is None or not menu_win.winfo_exists():
                root.lift()
        except Exception:
            pass
        root.after(2000, _keep_on_top)
    root.after(2000, _keep_on_top)

    win_w = round(FRAME_W * scale)
    win_h = round(FRAME_H * scale)
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    x0, y0 = load_position(win_w, win_h, sw, sh)
    root.geometry('%dx%d+%d+%d' % (win_w, win_h, x0, y0))

    canvas = tk.Canvas(root, width=win_w, height=win_h, bg=MAGIC, highlightthickness=0)
    canvas.pack()

    preload_all()

    default_frames = sprite_photos.get('idle') or []
    if not default_frames:
        log('no sprite frames loaded, exit')
        root.destroy()
        return

    sprite_item = canvas.create_image(0, 0, anchor='nw', image=default_frames[0])

    canvas.bind('<ButtonPress-1>', on_press)
    canvas.bind('<B1-Motion>', on_motion)
    canvas.bind('<ButtonRelease-1>', on_release)
    canvas.bind('<Double-Button-1>', on_double_click)
    canvas.bind('<Button-3>', open_context_menu)
    root.bind('<Button-3>', open_context_menu)

    ms = FRAME_MS_IDLE
    root.after(ms, tick)
    root.after(100, poll_queue)
    root.after(random.randint(20000, 45000), schedule_random)
    root.after(random.randint(30000, 60000), schedule_bubble)

    t = threading.Thread(target=ws_loop, daemon=True)
    t.start()

    def on_close():
        stop_flag.set()
        try:
            save_position(root.winfo_x(), root.winfo_y())
        except Exception:
            pass
        root.destroy()

    try:
        root.protocol('WM_DELETE_WINDOW', on_close)
    except Exception:
        pass

    try:
        root.mainloop()
    except KeyboardInterrupt:
        pass
    stop_flag.set()
    save_position(root.winfo_x(), root.winfo_y())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        log('fatal error:\n%s' % traceback.format_exc())
        try:
            sys.exit(0)
        except Exception:
            pass

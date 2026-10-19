"""读取给定标题关键词的顶层窗口状态（是否可见、位置、尺寸），输出 JSON。

只用于验收脚本判断「窗口到底有没有显示」：CDP 连着的时候渲染器的
document.visibilityState 会被焦点仿真钉在 visible，不能拿来当窗口显隐证据。
只用标准库（ctypes），Windows 专用。

用法：python window_state.py [标题关键词]，默认 "AI Tree"
"""
import ctypes
import ctypes.wintypes as wt
import json
import sys

user32 = ctypes.windll.user32

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def window_title(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ''
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def describe(hwnd):
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return {
        'hwnd': int(hwnd),
        'title': window_title(hwnd),
        'visible': bool(user32.IsWindowVisible(hwnd)),
        'rect': [rect.left, rect.top, rect.right, rect.bottom],
    }


def main(argv):
    keyword = argv[1] if len(argv) > 1 else 'AI Tree'
    found = []

    def callback(hwnd, _):
        title = window_title(hwnd)
        if keyword in title:
            found.append(describe(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(callback), 0)
    visible = [w for w in found if w['visible']]
    print(json.dumps({'keyword': keyword, 'windows': found, 'any_visible': bool(visible),
                      'visible_count': len(visible)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

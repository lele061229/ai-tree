#!/usr/bin/env python3
"""knowledge-os-sync: submit a structured learning update to a self-hosted Knowledge OS.

Standard library only. The token is read from a 0600 config file or stdin, never from
argv, so it does not land in shell history or process listings.
"""
import argparse
import json
import os
import re
import ssl
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid

HOME = os.environ.get('KO_SYNC_HOME') or os.path.expanduser('~')
CONFIG_DIR = os.path.join(HOME, '.ko-sync')
CONFIG_PATH = os.path.join(CONFIG_DIR, 'config.json')
PENDING_DIR = os.path.join(CONFIG_DIR, 'pending')
SENT_DIR = os.path.join(CONFIG_DIR, 'sent')
FORMAT = 'ko.learning-update'
FORMAT_VERSION = 1
LOOPBACK = {'127.0.0.1', 'localhost', '::1'}
WINDOWS = os.name == 'nt'
_ACL_DONE = set()
DIR_WARNINGS = []


def local_desktop_info():
    """发现本机 AI Tree 桌面端（本地优先模式）。

    桌面端启动本地服务后会在 <userData>/local/server.json 写 {origin, pid}。
    查找顺序：KO_DESKTOP_SERVER_FILE（显式）→ KO_USERDATA/local →
    %APPDATA%\\AI Tree 本地版\\local（0.2.0 起的正式名称）→ %APPDATA%\\AI Tree\\local（旧名）。
    找不到或进程已死都返回 None——调用方显式失败，绝不静默改道云端。
    """
    override = os.environ.get('KO_DESKTOP_SERVER_FILE')
    candidates = []
    if override:
        candidates.append(override)
    else:
        base = os.environ.get('KO_USERDATA')
        if base:
            candidates.append(os.path.join(base, 'local', 'server.json'))
        else:
            appdata = os.environ.get('APPDATA')
            if not appdata:
                return None
            for name in ('AI Tree 本地版', 'AI Tree'):
                candidates.append(os.path.join(appdata, name, 'local', 'server.json'))
    info = None
    path = None
    for candidate in candidates:
        try:
            with open(candidate, encoding='utf-8') as handle:
                info = json.load(handle)
            path = candidate
            break
        except (OSError, ValueError):
            info = None
    if info is None:
        return None
    origin = info.get('origin') or ''
    pid = info.get('pid')
    if not origin.startswith('http://127.0.0.1:'):
        return None
    if pid:
        try:
            if WINDOWS:
                # tasklist /FI 精确过滤；退出码 0 且包含 PID 行才算存活
                out = subprocess.run(
                    ['tasklist', '/FI', 'PID eq %d' % pid, '/FO', 'CSV', '/NH'],
                    capture_output=True, text=True, timeout=10).stdout or ''
                if str(pid) not in out:
                    return None
            else:
                os.kill(pid, 0)
        except (OSError, subprocess.SubprocessError):
            return None
    return {'origin': origin.rstrip('/'), 'pid': pid, 'info_path': path}


def _record_dir_warning(message):
    if message not in DIR_WARNINGS:
        DIR_WARNINGS.append(message)


DIR_HINT = ('这**不等于**「所有凭据路径都已安全」：目录仍在按继承的 ACL 授权，'
            '凭据文件是逐个加固的。写入流程会先把临时文件的 ACL 收紧到当前用户、'
            '再写入内容，所以令牌不会以继承权限落盘；但目录未加固时，'
            '目录本身的列目录/替换文件等操作仍受继承主体影响（通常是 SYSTEM、Administrators）。'
            '请在普通终端（非受限代理环境）重跑一次 check；若仍不通过，'
            '检查安全软件或沙箱对用户目录 ACL 修改的限制。')


class Failure(Exception):
    def __init__(self, message, code='error', detail=None, retryable=False):
        super().__init__(message)
        self.code, self.detail, self.retryable = code, detail, retryable


def ensure_dirs():
    for path in (CONFIG_DIR, PENDING_DIR, SENT_DIR):
        os.makedirs(path, exist_ok=True)
    try:
        os.chmod(CONFIG_DIR, 0o700)
    except OSError:
        pass
    if WINDOWS:
        # 目录先断继承，子文件创建时才会继承到正确的单一主体。
        # 三个目录都要加固：pending/sent 里放的是用户的学习内容，同样不该被其他用户读到。
        for path in (CONFIG_DIR, PENDING_DIR, SENT_DIR):
            ok, message = harden_private(path)
            if not ok:
                # 失败不静默：icacls 可能被沙箱/安全软件假成功，必须留痕并让 config/check 说出实情。
                _record_dir_warning('目录 ACL 未加固：%s（%s）' % (path, message))


def current_sid():
    """当前用户的 SID。Windows 上按 SID 授权，避免用户名/域名的编码问题。"""
    try:
        out = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'],
                             capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None
    match = re.search(r'S-1-5-21(?:-\d+){2,}', out or '')
    return match.group(0) if match else None


def current_account():
    """形如 ler\\lenovo。ACL 里同一个主体可能显示成 SID，也可能显示成账号名。"""
    try:
        out = subprocess.run(['whoami'], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None
    return (out or '').strip().lower() or None


def is_self(name):
    """同一个主体可能以 SID 或 域\\用户名 两种形式出现在 DACL 里，都要认。"""
    if not name:
        return False
    sid = current_sid()
    if sid and name.upper() == sid.upper():
        return True
    account = current_account()
    if account and name.lower() == account:
        return True
    # 只给了用户名（没有域前缀）时也按当前用户算
    if account and '\\' in account and name.lower() == account.split('\\', 1)[1]:
        return True
    return False


def parse_acl(text, path):
    """解析 icacls 输出里的受托人。

    坑：第一个 ACE 和路径在同一行（`<path> NT AUTHORITY\\SYSTEM:(OI)(CI)(F)`），
    而且受托人本身可能带空格（`NT AUTHORITY\\SYSTEM`）。所以先去掉路径前缀，
    再按两个以上空格切分，最后按第一个冒号取受托人名。
    """
    label = str(path)
    entries = []
    for line in (text or '').splitlines():
        body = line.strip()
        if not body or body.startswith('Successfully') or body.startswith('Failed'):
            continue
        if label in body:
            body = body.split(label, 1)[1].strip()
        if not body:
            continue
        for chunk in re.split(r'\s{2,}', body):
            head, sep, tail = chunk.strip().partition(':')
            if not sep or not tail.startswith('('):
                continue
            name = head.strip()
            if not name:
                continue
            entries.append((name, tail.strip('()').replace(')(', ' ')))
    return entries


def acl_entries(path):
    """读取实际 ACL 中的受托人列表，用于校验而不是假设。"""
    try:
        out = subprocess.run(['icacls', path], capture_output=True, text=True, timeout=15).stdout
    except Exception as exc:
        return None, 'icacls 读取失败：%s' % exc
    return parse_acl(out, path), ''


def acl_inherited(path):
    """该对象是否仍在继承父目录的 ACL（icacls 输出里带 (I) 标记）。读不出返回 None。"""
    if not WINDOWS:
        return None
    try:
        out = subprocess.run(['icacls', str(path)], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None
    return '(I)' in (out or '')


def acl_owner(path):
    """所有者不在 DACL 里，必须单独读：只看 DACL 无法断言权限归属。"""
    if not WINDOWS:
        return None
    try:
        out = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command',
             "(Get-Acl -LiteralPath '%s').Owner" % str(path).replace("'", "''")],
            capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return None
    return (out or '').strip() or None


def describe(path):
    """一行式实况：DACL 结论 + 是否仍继承 + 所有者。读不出来就说读不出来。"""
    ok, message = verify_private(path)
    inherited = acl_inherited(path)
    owner = acl_owner(path)
    inherit_text = {True: '仍启用（未断继承）', False: '已断继承', None: '读取失败'}[inherited]
    return ok, message, '%s · 所有者 %s' % (inherit_text, owner or '读取失败')


def harden_private(path):
    """Windows 上 chmod(0600) 只改只读属性，不改 ACL：这里断继承并只授权当前用户。

    返回 (ok, message)。非 Windows 返回 (True, 'posix')，POSIX 由 0600 保证。
    """
    if not WINDOWS:
        return True, 'posix'
    if path in _ACL_DONE:
        return True, 'cached'
    sid = current_sid()
    if not sid:
        return False, '无法取得当前用户 SID，ACL 未加固'
    flag = '(OI)(CI)(F)' if os.path.isdir(path) else '(F)'
    try:
        result = subprocess.run(['icacls', path, '/inheritance:r', '/grant:r', '*%s:%s' % (sid, flag)],
                                capture_output=True, text=True, timeout=20)
    except Exception as exc:
        return False, 'icacls 执行失败：%s' % exc
    if result.returncode != 0:
        return False, (result.stderr or result.stdout).strip()[:200]
    entries, error = acl_entries(path)
    if entries is None:
        return False, error
    foreign = [name for name, _ in entries if not is_self(name)]
    if foreign:
        return False, '仍有其他主体可访问：%s' % ', '.join(foreign)
    _ACL_DONE.add(path)
    return True, 'only current user'


def verify_private(path):
    """只读校验：返回 (ok, message)，不修改任何 ACL。"""
    if not WINDOWS:
        try:
            mode = os.stat(path).st_mode & 0o777
        except OSError as exc:
            return False, str(exc)
        return (mode & 0o077) == 0, 'mode %03o' % mode
    entries, error = acl_entries(path)
    if entries is None:
        return False, error
    sid = current_sid()
    if not sid:
        return False, '无法取得当前用户 SID'
    foreign = [name for name, _ in entries if not is_self(name)]
    return (not foreign), ('only current user' if not foreign else '额外主体：%s' % ', '.join(foreign))


def write_private(path, text, sensitive=False):
    """写入私有文件：先把临时文件的 ACL 收紧，再写入内容。

    顺序很重要。旧实现是「写内容 → 替换 → 加固」，在目录本身未加固时，
    临时文件会带着目录继承来的 ACL 短暂保存明文（凭据就落在这个窗口里）。
    现在改为：建空临时文件 → 收紧 ACL → 失败就放弃（sensitive）→ 写内容 → 原子替换。
    """
    ensure_dirs()
    tmp = str(path) + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    ok, message = harden_private(tmp)
    if not ok and sensitive:
        os.close(fd)
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise Failure('无法把凭据文件权限收紧到仅当前用户（%s），已放弃写入。'
                      ' 在普通终端重试；若仍失败，检查安全软件/沙箱对 ACL 的限制。' % message,
                      'insecure_path')
    if not ok:
        print('警告：临时文件权限未加固（%s），内容仍会写入。' % message, file=sys.stderr)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.replace(tmp, path)
    # 替换后 ACL 随文件走；这里只读复核一次，不修改，避免把「加固成功」当假设。
    final_ok, final_message = verify_private(path)
    if not final_ok:
        if sensitive:
            raise Failure('凭据文件写入后复核未通过（%s）。' % final_message, 'insecure_path')
        print('警告：文件权限复核未通过（%s）。' % final_message, file=sys.stderr)


def load_config(required=True):
    if not os.path.exists(CONFIG_PATH):
        if required:
            raise Failure('尚未配置。先运行: ko_sync.py config --url <平台地址> --token-stdin', 'no_config')
        return {}
    with open(CONFIG_PATH, encoding='utf-8') as handle:
        config = json.load(handle)
    if required and not config.get('token'):
        raise Failure('配置里没有凭据。重新运行 config 并通过标准输入写入。', 'no_token')
    return config


def mask(token):
    return token[:16] + '…' + token[-4:] if len(token) > 22 else '…'


def request(method, path, config, payload=None):
    base = config['url'].rstrip('/')
    url = base + path
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
    headers = {'Accept': 'application/json', 'User-Agent': 'ko-sync/1.0'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    if config.get('token'):
        headers['Authorization'] = 'Bearer ' + config['token']

    context = None
    if url.startswith('https://'):
        context = ssl.create_default_context()
        if config.get('insecure'):
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context)) if context else urllib.request.build_opener()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(req, timeout=45) as response:
            return response.status, json.loads(response.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode('utf-8', 'replace')
        try:
            body = json.loads(raw)
        except ValueError:
            body = {'detail': raw[:300]}
        detail = body.get('detail')
        if isinstance(detail, dict):
            raise Failure(detail.get('message', '请求被拒绝'), detail.get('code', 'http_%d' % exc.code), detail,
                          retryable=bool(detail.get('retryable')))
        raise Failure(str(detail or 'HTTP %d' % exc.code), 'http_%d' % exc.code, body)
    except urllib.error.URLError as exc:
        if config.get('target') == 'local':
            raise Failure('本机 AI Tree 不可达（%s）。请先启动桌面端再重试；'
                          '不会自动改道云端。' % exc.reason, 'network', retryable=True)
        raise Failure('无法连接 %s：%s' % (base, exc.reason), 'network', retryable=True)
    except ssl.SSLError as exc:
        raise Failure('TLS 校验失败：%s。不要用自签名证书或跳过校验来绕过。' % exc, 'tls')


def normalize(value):
    return re.sub(r'[^\w\u3400-\u9fff]', '', unicodedata.normalize('NFKC', str(value)).casefold())


def local_check(package):
    """Mirror of the server's hard rules, so the agent catches mistakes before uploading."""
    problems = []
    if package.get('format') != FORMAT:
        problems.append(('format', '必须是 %s' % FORMAT))
    if package.get('formatVersion') != FORMAT_VERSION:
        problems.append(('formatVersion', '目前只支持 1'))
    if not re.match(r'^[A-Za-z0-9_-]{8,80}$', str(package.get('submissionId', ''))):
        problems.append(('submissionId', '8–80 位，只用字母、数字、- 和 _'))
    if not str(package.get('scope', '')).strip():
        problems.append(('scope', '必须写明本次整理范围'))
    fragments = package.get('fragments') or []
    if not fragments:
        problems.append(('fragments', '至少一个来源片段'))
    for index, fragment in enumerate(fragments):
        kind = fragment.get('kind', 'user_original')
        if kind == 'user_original' and len(str(fragment.get('text', '')).strip()) < 10:
            problems.append(('fragments[%d].text' % index, '声明为原文时必须带原文；只留摘要请用 ai_summary'))
    items = package.get('items') or []
    if not items:
        problems.append(('items', '至少一个知识点'))
    keys = [item.get('key') for item in items]
    if len(set(keys)) != len(keys):
        problems.append(('items[].key', '必须唯一'))
    for index, item in enumerate(items):
        if len(str(item.get('key', ''))) > 20:
            problems.append(('items[%d].key' % index, '最多 20 个字符（与服务端一致）'))
    titles = [normalize(item.get('title', '')) for item in items]
    if len(set(titles)) != len(titles):
        problems.append(('items[].title', '归一化后必须唯一，同一节点合并成一条'))
    for index, item in enumerate(items):
        for field in ('level', 'stage', 'mastery', 'verified'):
            if field in item:
                problems.append(('items[%d].%s' % (index, field),
                                 '智能体不能声明掌握等级、验证或上线状态'))
        if not str(item.get('summary', '')).strip():
            problems.append(('items[%d].summary' % index, '不能为空'))
        if not item.get('concepts'):
            problems.append(('items[%d].concepts' % index, '至少一个要点'))
        if not item.get('tasks'):
            problems.append(('items[%d].tasks' % index, '至少一个练习'))
    return problems


def submit_package(package, config, quiet=False):
    problems = local_check(package)
    if problems:
        lines = ['本地校验未通过，未上传：']
        lines += ['  %-28s %s' % (path, message) for path, message in problems]
        raise Failure('\n'.join(lines), 'invalid_package', {'paths': [p for p, _ in problems]})

    status, body = request('POST', '/api/sync/submissions', config, package)
    submission = package['submissionId']
    print('提交目标 %s（%s）' % ('本机 AI Tree' if config.get('target') == 'local' else '云端平台', config['url']))
    if body.get('duplicate'):
        print('已提交过（幂等命中），未重复创建：')
    else:
        print('已提交，等待你在网页端确认：')
    print('  提交编号  %s' % body.get('submissionId', submission))
    print('  批次编号  %s' % body.get('batchId', '-'))
    print('  状态      %s' % body.get('status', '-'))
    print('  基线版本  v%s' % body.get('baseVersion', '-'))
    print('  变更项    %d 项' % len(body.get('changes') or []))
    for change in body.get('changes') or []:
        print('    - %s %s' % (change.get('type'), change.get('title')))
    url = body.get('reviewUrl')
    if url:
        print('  审阅地址  %s' % url)
    print('能力等级与项目阶段不会因为这次提交自动提升。')
    remember_sent(submission, body)
    return body


def pending_path(submission):
    return os.path.join(PENDING_DIR, submission + '.json')


def remember_pending(package, error=None):
    submission = package['submissionId']
    record = {'package': package, 'error': error, 'savedAt': int(time.time())}
    write_private(pending_path(submission), json.dumps(record, ensure_ascii=False, indent=1))
    return pending_path(submission)


def remember_sent(submission, result):
    write_private(os.path.join(SENT_DIR, submission + '.json'),
                  json.dumps(result, ensure_ascii=False, indent=1))
    stale = pending_path(submission)
    if os.path.exists(stale):
        os.remove(stale)


def load_pending(submission):
    path = pending_path(submission)
    if not os.path.exists(path):
        raise Failure('没有找到待上传包 %s。' % submission, 'no_pending')
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)['package']


def cmd_config(args):
    if getattr(args, 'local', False) and not args.url:
        info = local_desktop_info()
        if not info:
            raise Failure('没有发现运行中的本机 AI Tree 桌面端（本地服务未启动）。'
                          '先启动桌面端，或改用 --url 指定云端地址。', 'local_unavailable')
        url = info['origin']
        args.insecure = False
    elif args.url:
        url = args.url.rstrip('/')
    else:
        raise Failure('请指定提交目标：--local（本机桌面端）或 --url <平台地址>。', 'bad_url')
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise Failure('地址必须以 http:// 或 https:// 开头', 'bad_url')
    if parsed.scheme == 'http' and parsed.hostname not in LOOPBACK:
        raise Failure('非回环地址必须使用 https://；本轮不接受明文提交。', 'bad_url')
    config = load_config(required=False)
    config['url'] = url
    config['target'] = 'local' if getattr(args, 'local', False) else 'cloud'
    if args.token_stdin:
        token = sys.stdin.readline().strip()
        if not token:
            raise Failure('标准输入里没有读到凭据。', 'no_token')
        if not token.startswith('ko_sync_'):
            raise Failure('凭据格式不对，应以 ko_sync_ 开头。', 'bad_token')
        config['token'] = token
    if args.insecure:
        if parsed.hostname not in LOOPBACK and not os.getenv('KO_SYNC_ALLOW_INSECURE'):
            raise Failure('只有回环地址允许 --insecure。', 'bad_url')
        config['insecure'] = True
    write_private(CONFIG_PATH, json.dumps(config, ensure_ascii=False, indent=1), sensitive=True)
    print('已写入 %s' % CONFIG_PATH)
    print('提交目标 %s（%s）' % ('本机 AI Tree' if config.get('target') == 'local' else '云端平台', url))
    if WINDOWS:
        ok_dir, msg_dir, extra_dir = describe(CONFIG_DIR)
        print('目录权限 %s（%s；%s）' % ('已加固' if ok_dir else '未加固', msg_dir, extra_dir))
        if not ok_dir:
            print('         %s' % DIR_HINT)
    ok, message, extra = describe(CONFIG_PATH)
    print('权限     %s（%s；%s）' % ('已加固' if ok else '未加固', message, extra))
    print('平台地址 %s' % url)
    if config.get('token'):
        print('凭据     %s（已保存，不再明文显示）' % mask(config['token']))
        status, body = request('GET', '/api/sync/status', config)
        print('账号     %s · 当前 v%s · 待审 %s 项' % (body.get('user'), body.get('currentVersion'), body.get('pending')))
    return 0


def cmd_status(args):
    config = load_config()
    _, body = request('GET', '/api/sync/status', config)
    print('提交目标 %s（%s）' % ('本机 AI Tree' if config.get('target') == 'local' else '云端平台', config['url']))
    print('账号     %s' % body.get('user'))
    print('当前版本 v%s' % body.get('currentVersion'))
    print('模型接口 %s（本路径不需要）' % ('已配置' if body.get('aiReady') else '未配置'))
    print('待审提交 %s 项' % body.get('pending'))
    token = body.get('token') or {}
    print('凭据     %s · 到期 %s' % (token.get('label'), time.strftime('%Y-%m-%d', time.localtime(token.get('expiresAt', 0)))))
    return 0


def cmd_submit(args):
    config = load_config()
    with open(args.file, encoding='utf-8') as handle:
        package = json.load(handle)
    package.setdefault('submissionId', 'sub_' + uuid.uuid4().hex[:16])
    package.setdefault('createdAt', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    if args.dry_run:
        problems = local_check(package)
        if problems:
            for path, message in problems:
                print('%-28s %s' % (path, message))
            return 2
        print('本地校验通过，未上传（--dry-run）。')
        return 0
    try:
        submit_package(package, config)
    except Failure as exc:
        remember_pending(package, str(exc))
        print('提交未通过：%s' % exc.code, file=sys.stderr)
        print(str(exc), file=sys.stderr)
        detail = exc.detail or {}
        for problem in detail.get('problems') or []:
            print('  %-28s %s' % (problem.get('path'), problem.get('message')), file=sys.stderr)
        for path in detail.get('paths') or []:
            print('  违规字段 %s' % path, file=sys.stderr)
        print('包已保留：%s' % pending_path(package['submissionId']), file=sys.stderr)
        print('修正后重试（沿用同一提交标识）：ko_sync.py retry --submission-id %s' % package['submissionId'], file=sys.stderr)
        return 2
    return 0


def cmd_retry(args):
    config = load_config()
    package = load_pending(args.submission_id)
    if args.file:
        with open(args.file, encoding='utf-8') as handle:
            package = json.load(handle)
        package['submissionId'] = args.submission_id
    try:
        submit_package(package, config)
    except Failure as exc:
        remember_pending(package, str(exc))
        print('重试仍未通过：%s' % exc.code, file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 2
    return 0


def cmd_pending(args):
    ensure_dirs()
    files = sorted(os.listdir(PENDING_DIR))
    if not files:
        print('没有待上传包。')
        return 0
    for name in files:
        with open(os.path.join(PENDING_DIR, name), encoding='utf-8') as handle:
            record = json.load(handle)
        error = (record.get('error') or '').splitlines()
        print('%s  %s' % (record['package'].get('submissionId'), time.strftime('%Y-%m-%d %H:%M', time.localtime(record.get('savedAt', 0)))))
        print('   范围 %s' % record['package'].get('scope', '')[:60])
        if error:
            print('   上次失败 %s' % error[0][:100])
    return 0


def cmd_show(args):
    config = load_config()
    _, body = request('GET', '/api/sync/submissions/' + urllib.parse.quote(args.submission_id), config)
    print('提交编号 %s' % body.get('submissionId'))
    print('状态     %s' % body.get('status'))
    print('批次     %s' % body.get('batchId'))
    print('尝试次数 %s' % body.get('attempts'))
    if body.get('error'):
        print('失败原因 %s' % body.get('error'))
    for change in body.get('changes') or []:
        print('  - %s %s' % (change.get('type'), change.get('title')))
    return 0


def cmd_check(args):
    """只读自检：每个路径的实际 ACL、继承状态、所有者、配置完整性和连通性。

    它检查的是「这几个具体路径」，不是「本机所有凭据路径都安全」的结论。
    """
    ok_all = True
    print('配置目录 %s' % CONFIG_DIR)
    if not os.path.isdir(CONFIG_DIR):
        print('  尚未创建（第一次 config 时生成）')
    else:
        for label, path in (('目录', CONFIG_DIR), ('待传目录', PENDING_DIR), ('已传目录', SENT_DIR)):
            if not os.path.isdir(path):
                continue
            ok, message, extra = describe(path)
            ok_all = ok_all and ok
            print('  %s权限 %s  %s；%s' % (label, '通过' if ok else '不通过', message, extra))
        if not verify_private(CONFIG_DIR)[0] and os.path.exists(CONFIG_PATH):
            print('  说明     %s' % DIR_HINT)
    if os.path.exists(CONFIG_PATH):
        ok, message, extra = describe(CONFIG_PATH)
        ok_all = ok_all and ok
        print('凭据文件 %s' % CONFIG_PATH)
        print('  文件权限 %s  %s；%s' % ('通过' if ok else '不通过', message, extra))
    else:
        print('凭据文件 不存在（尚未 config）')
    print('说明     以上只覆盖列出的路径；新建文件在收紧 ACL 前的短暂窗口由目录 ACL 决定。')
    config = load_config(required=False)
    if not config.get('token'):
        print('凭据 未配置')
        return 0 if ok_all else 1
    print('平台地址 %s' % config.get('url'))
    try:
        _, body = request('GET', '/api/sync/status', config)
        print('连通性   通过 · 账号 %s · 当前 v%s · 待审 %s' % (body.get('user'), body.get('currentVersion'), body.get('pending')))
    except Failure as exc:
        ok_all = False
        print('连通性   不通过 · %s' % exc)
    return 0 if ok_all else 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog='ko_sync.py', description='Knowledge OS 学习更新包同步')
    sub = parser.add_subparsers(dest='command', required=True)

    p = sub.add_parser('config', help='配置提交目标与凭据')
    p.add_argument('--url', required=False, help='云端平台地址（--local 时不填）')
    p.add_argument('--local', action='store_true', help='提交到本机 AI Tree 桌面端（自动发现地址）')
    p.add_argument('--token-stdin', action='store_true', help='从标准输入读取凭据（推荐）')
    p.add_argument('--insecure', action='store_true', help='仅回环地址，跳过 TLS 校验')
    p.set_defaults(func=cmd_config)

    p = sub.add_parser('status', help='查看账号、版本与待审数量')
    p.set_defaults(func=cmd_status)

    p = sub.add_parser('submit', help='上传更新包')
    p.add_argument('--file', required=True)
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(func=cmd_submit)

    p = sub.add_parser('retry', help='用同一提交标识重试')
    p.add_argument('--submission-id', required=True)
    p.add_argument('--file', help='修正后的包；省略则用保留的原包')
    p.set_defaults(func=cmd_retry)

    p = sub.add_parser('pending', help='列出保留的待上传包')
    p.set_defaults(func=cmd_pending)

    p = sub.add_parser('show', help='查询某次提交的状态')
    p.add_argument('--submission-id', required=True)
    p.set_defaults(func=cmd_show)

    p = sub.add_parser('check', help='只读自检：权限、配置与连通性')
    p.set_defaults(func=cmd_check)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Failure as exc:
        print('错误：%s' % exc, file=sys.stderr)
        return 3 if exc.code in ('network', 'tls', 'invalid_token', 'missing_token') else 1
    except FileNotFoundError as exc:
        print('找不到文件：%s' % exc, file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print('JSON 解析失败：%s' % exc, file=sys.stderr)
        return 1
    except (KeyError, TypeError, AttributeError) as exc:
        print('更新包结构不完整：%s（用 ko_package.py check 先做本地校验）' % exc, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

"""Windows 凭据保护的行为测试（KO-003-R1 补充决策第 2 项）。

目录 ACL 写入在受限环境（代理沙箱）里可能被静默拦截，所以这里把「加固必须被验证、
失败必须留痕」当作契约来测：不假设 icacls 一定成功，而是验证代码如实报告结果。
"""
import importlib.util
import os
import pathlib
import shutil
import subprocess

import pytest

SKILL_SCRIPTS = pathlib.Path(__file__).resolve().parents[2] / 'skill' / 'knowledge-os-sync' / 'scripts'


def load_ko_sync(tmp_root: pathlib.Path):
    spec = importlib.util.spec_from_file_location('ko_sync_under_test', SKILL_SCRIPTS / 'ko_sync.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.CONFIG_DIR = tmp_root / '.ko-sync-test'
    module.CONFIG_PATH = module.CONFIG_DIR / 'config.json'
    module.PENDING_DIR = module.CONFIG_DIR / 'pending'
    module.SENT_DIR = module.CONFIG_DIR / 'sent'
    module._ACL_DONE.clear()
    module.DIR_WARNINGS.clear()
    return module


@pytest.fixture()
def acl_root(tmp_path_factory):
    # 放在工作区内：HOME 下的目录 ACL 修改可能被沙箱拦截，工作区内已实测可写。
    root = pathlib.Path(__file__).resolve().parents[2] / '.acltest'
    root.mkdir(parents=True, exist_ok=True)
    yield root
    # 收尾：先把 ACL 交还继承再删目录。用例目录被收紧过，不 reset 会删不掉，
    # 留下 untracked 目录会污染 git 状态与交付清单。
    for child in list(root.iterdir()):
        subprocess.run(['icacls', str(child), '/reset', '/T', '/C'], capture_output=True)
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    try:
        root.rmdir()
    except OSError:
        pass


@pytest.mark.skipif(os.name != 'nt', reason='Windows ACL 行为')
def test_harden_fresh_dir_leaves_only_current_user(acl_root):
    import subprocess
    m = load_ko_sync(acl_root / 'case1')
    m.ensure_dirs()
    ok, message = m.verify_private(m.CONFIG_DIR)
    assert ok, message
    entries, error = m.acl_entries(m.CONFIG_DIR)
    assert error == ''
    assert m.current_sid()
    # 同一个主体可能显示成 SID，也可能显示成 域\用户名
    assert all(m.is_self(name) for name, _ in entries), entries
    # 清理：把 ACL 交还给继承，避免残留
    subprocess.run(['icacls', str(m.CONFIG_DIR), '/reset'], capture_output=True)


@pytest.mark.skipif(os.name != 'nt', reason='Windows ACL 行为')
def test_verify_detects_foreign_trustee(acl_root):
    m = load_ko_sync(acl_root / 'case2')
    m.ensure_dirs()
    m.acl_entries = lambda path: ([('BUILTIN\\Administrators', 'F'), (m.current_sid(), 'F')], '')
    ok, message = m.verify_private(m.CONFIG_DIR)
    assert not ok
    assert 'Administrators' in message


def test_parse_acl_keeps_trustee_on_the_path_line(acl_root):
    """真实 icacls 输出里第一个 ACE 和路径同行，且受托人含空格。"""
    m = load_ko_sync(acl_root / 'case7')
    sample = (
        'C:\\Users\\lenovo\\.ko-sync NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\r\n'
        '                         BUILTIN\\Administrators:(OI)(CI)(F)\r\n'
        '                         LER\\lenovo:(OI)(CI)(F)\r\n'
        '\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n'
    )
    entries = m.parse_acl(sample, 'C:\\Users\\lenovo\\.ko-sync')
    assert [name for name, _ in entries] == [
        'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', 'LER\\lenovo'], entries

    file_sample = 'C:\\Users\\lenovo\\.ko-sync\\config.json LER\\lenovo:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n'
    entries = m.parse_acl(file_sample, 'C:\\Users\\lenovo\\.ko-sync\\config.json')
    assert entries == [('LER\\lenovo', 'F')], entries


@pytest.mark.skipif(os.name != 'nt', reason='Windows ACL 行为')
def test_dir_hardening_failure_is_recorded_not_swallowed(acl_root):
    m = load_ko_sync(acl_root / 'case3')
    m.harden_private = lambda path: (False, '仍有其他主体可访问：BUILTIN\\Administrators')
    m.ensure_dirs()
    assert m.DIR_WARNINGS, '目录加固失败必须留痕，不能静默'
    assert 'Administrators' in m.DIR_WARNINGS[0]


@pytest.mark.skipif(os.name != 'nt', reason='Windows ACL 行为')
def test_ensure_dirs_hardens_pending_and_sent_too(acl_root):
    """pending/sent 里是用户的学习内容，不能只加固根目录。"""
    m = load_ko_sync(acl_root / 'case4')
    seen = []
    m.harden_private = lambda path: (seen.append(str(path)), (True, 'stub'))[1]
    m.ensure_dirs()
    assert str(m.CONFIG_DIR) in seen
    assert str(m.PENDING_DIR) in seen
    assert str(m.SENT_DIR) in seen


@pytest.mark.skipif(os.name != 'nt', reason='Windows ACL 行为')
def test_sensitive_write_fails_closed_when_acl_cannot_be_hardened(acl_root):
    """收紧不了就放弃写入：宁可让用户重来，也不把令牌写进可被其他主体读的文件。"""
    m = load_ko_sync(acl_root / 'case5')
    m.harden_private = lambda path: (False, '仍有其他主体可访问：BUILTIN\\Administrators')
    with pytest.raises(m.Failure) as excinfo:
        m.write_private(m.CONFIG_PATH, '{"token": "ko_sync_test-only"}', sensitive=True)
    assert excinfo.value.code == 'insecure_path'
    assert not os.path.exists(m.CONFIG_PATH), '收紧失败时不该留下凭据文件'
    assert not os.path.exists(str(m.CONFIG_PATH) + '.tmp'), '临时文件也要清掉'


@pytest.mark.skipif(os.name != 'nt', reason='Windows ACL 行为')
def test_acl_is_hardened_before_content_is_written(acl_root):
    """写内容之前必须先收紧临时文件，否则令牌会带着目录继承的 ACL 落盘。"""
    m = load_ko_sync(acl_root / 'case6')
    order = []

    def fake_harden(path):
        order.append(('harden', os.path.basename(path), os.path.exists(path),
                      os.path.getsize(path) if os.path.exists(path) else -1))
        return True, 'stub'

    m.harden_private = fake_harden
    m.verify_private = lambda path: (True, 'stub')  # 收尾复核另有用例覆盖
    m.write_private(m.CONFIG_PATH, 'x' * 32, sensitive=True)
    tmp_calls = [item for item in order if item[1].endswith('.tmp')]
    assert tmp_calls, order
    first = tmp_calls[0]
    assert first[2] is True, '收紧前临时文件必须已存在'
    assert first[3] == 0, '收紧时文件必须是空的：内容还没写入'
    assert m.CONFIG_PATH.read_text(encoding='utf-8') == 'x' * 32

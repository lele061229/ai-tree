"""本地优先（local-first）运行入口。

设计边界：
- 只监听 127.0.0.1 回环地址；鉴权体系（cookie 会话 + CSRF + origin 校验）全部保留，
  不提供任何“关闭鉴权”的本地模式。
- 首次启动自动建库（alembic 迁移到 head）并创建本地账号 `local`，随机口令写入
  数据目录下的 local-auth.json（仅本机当前用户可读），供桌面壳自动登录。
- server.json 记录当前端口与进程，供 Skill 等本机工具发现本地目标；正常退出时清除。
- 备份使用 SQLite VACUUM INTO，取一致性快照，不需要先停止服务；恢复必须先停止。
"""
import argparse
import json
import os
import secrets
import socket
import sys
import time
from pathlib import Path

import uvicorn
from sqlalchemy import text

from .config import Settings
from .database import User, make_database
from .knowledge import ensure_workspace, identifier
from .main import create_app
from .manage import create_user, migrate
from .security import passwords
from sqlalchemy import select

AUTH_FILE = 'local-auth.json'
SERVER_FILE = 'server.json'


def build_settings(data_dir: Path, port: int) -> Settings:
    db_path = data_dir / 'ko.db'
    url = 'sqlite:///' + str(db_path).replace('\\', '/')
    # COOKIE_SECURE=False 仅允许回环 http，这与既有部署约束一致；
    # origin 固定为回环地址，鉴权与来源校验保持开启。
    return Settings(url, 'http://127.0.0.1:' + str(port), False, '', '', '', False)


def ensure_local_account(settings: Settings, data_dir: Path):
    auth_path = data_dir / AUTH_FILE
    engine, factory = make_database(settings.database_url)
    try:
        if auth_path.exists():
            try:
                info = json.loads(auth_path.read_text(encoding='utf-8'))
            except Exception:
                info = None
            if info:
                with factory() as db:
                    user = db.scalar(select(User).where(User.username == info.get('username', '')))
                    if user and passwords.verify(info.get('password', ''), user.password_hash):
                        return info['username'], info['password']
            # 记录与库不一致（例如手工删过库）：重建记录，不静默重置已有账号。
        username, password = 'local', secrets.token_urlsafe(18)
        if not create_user(settings, username, password):
            # 账号已存在但口令未知（例如手动清了 auth 文件）：生成新口令写库。
            with factory() as db:
                user = db.scalar(select(User).where(User.username == username))
                user.password_hash = passwords.hash(password)
                ensure_workspace(db, user.id)
                db.commit()
        auth_path.write_text(json.dumps({'username': username, 'password': password},
                                        ensure_ascii=False), encoding='utf-8')
        try:
            os.chmod(auth_path, 0o600)
        except OSError:
            pass
        return username, password
    finally:
        engine.dispose()


def write_server_info(data_dir: Path, port: int):
    (data_dir / SERVER_FILE).write_text(json.dumps({
        'pid': os.getpid(), 'port': port, 'origin': 'http://127.0.0.1:' + str(port),
        'started_at': int(time.time()),
    }), encoding='utf-8')


def clear_server_info(data_dir: Path):
    try:
        (data_dir / SERVER_FILE).unlink()
    except OSError:
        pass


def backup(data_dir: Path, out: Path):
    """一致性快照：服务器运行中也可以执行（WAL 下 VACUUM INTO 安全）。

    VACUUM INTO 要求目标不存在，而“另存为”对话框允许用户选已有文件；
    因此先写同目录临时文件，成功后原子替换，避免半截文件或覆盖失败。
    """
    settings = build_settings(data_dir, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + '.partial')
    if tmp.exists():
        tmp.unlink()
    engine, _ = make_database(settings.database_url)
    try:
        with engine.connect() as c:
            c.exec_driver_sql("VACUUM INTO '" + str(tmp).replace('\\', '/') + "'")
    finally:
        engine.dispose()
    os.replace(tmp, out)
    return out


def restore(data_dir: Path, src: Path):
    """恢复备份：必须先退出 AI Tree（ko.db 无进程占用）。"""
    db_path = data_dir / 'ko.db'
    if db_path.exists():
        # Windows 上文件被进程持有（即便空闲）时 rename 会失败，以此探测占用。
        probe = db_path.with_name('ko.restore-probe.db')
        try:
            db_path.rename(probe)
            probe.rename(db_path)
        except OSError:
            raise SystemExit('数据库仍被占用：请先完全退出 AI Tree 再恢复。')
    if not src.exists():
        raise SystemExit('备份文件不存在：' + str(src))
    import shutil
    for suffix in ('', '-wal', '-shm'):
        p = Path(str(db_path) + suffix)
        if p.exists():
            p.unlink()
    shutil.copyfile(src, db_path)
    # 恢复后校验可打开且完整性通过
    settings = build_settings(data_dir, 0)
    engine, _ = make_database(settings.database_url)
    try:
        with engine.connect() as c:
            result = c.execute(text('PRAGMA integrity_check')).scalar()
            if str(result).lower() != 'ok':
                raise SystemExit('恢复后的数据库完整性校验失败：' + str(result))
    finally:
        engine.dispose()


def serve(data_dir: Path, port: int):
    data_dir.mkdir(parents=True, exist_ok=True)
    settings = build_settings(data_dir, port)
    migrate(settings)
    username, _ = ensure_local_account(settings, data_dir)
    write_server_info(data_dir, port)
    import atexit
    atexit.register(clear_server_info, data_dir)
    app = create_app(settings)
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning', access_log=False)


def main():
    parser = argparse.ArgumentParser(description='AI Tree 本地服务（仅回环监听）')
    sub = parser.add_subparsers(dest='action')
    run = sub.add_parser('run')
    run.add_argument('--data', required=True)
    run.add_argument('--port', type=int, default=0)
    bk = sub.add_parser('backup')
    bk.add_argument('--data', required=True)
    bk.add_argument('--out', required=True)
    rs = sub.add_parser('restore')
    rs.add_argument('--data', required=True)
    rs.add_argument('--from', dest='src', required=True)
    args = parser.parse_args()
    if args.action == 'run':
        port = args.port or _free_port()
        serve(Path(args.data), port)
    elif args.action == 'backup':
        out = backup(Path(args.data), Path(args.out))
        print(json.dumps({'ok': True, 'backup': str(out), 'bytes': out.stat().st_size}, ensure_ascii=False))
    elif args.action == 'restore':
        restore(Path(args.data), Path(args.src))
        print(json.dumps({'ok': True}, ensure_ascii=False))
    else:
        parser.print_help(sys.stderr)
        raise SystemExit(2)


def _free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


if __name__ == '__main__':
    main()

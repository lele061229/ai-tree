import argparse
import getpass
import os
from pathlib import Path
from alembic import command
from alembic.config import Config
from sqlalchemy import select
from .config import ROOT, Settings, secret
from .database import User, make_database
from .knowledge import ensure_workspace, identifier
from .security import passwords

def migrate(settings):
    config = Config(str(ROOT / 'backend' / 'alembic.ini'))
    config.attributes['settings'] = settings
    command.upgrade(config, 'head')

def create_user(settings, username, password):
    if len(password) < 12 or len(password) > 256:
        raise ValueError('密码长度应为12–256个字符')
    if not username.strip() or len(username) > 80:
        raise ValueError('账号名称无效')
    engine, factory = make_database(settings.database_url)
    try:
        with factory() as db:
            if db.scalar(select(User).where(User.username == username)):
                return False
            user = User(id=identifier('user_'), username=username, password_hash=passwords.hash(password))
            db.add(user)
            db.flush()
            ensure_workspace(db, user.id)
            db.commit()
            return True
    finally:
        engine.dispose()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['migrate', 'bootstrap', 'create-user'])
    parser.add_argument('--username', default='admin')
    args = parser.parse_args()
    settings = Settings.from_env()
    if args.action == 'migrate':
        migrate(settings)
    elif args.action == 'bootstrap':
        password = secret('ADMIN_PASSWORD')
        if password:
            create_user(settings, os.getenv('ADMIN_USER', 'admin'), password)
    else:
        first, second = getpass.getpass('Password: '), getpass.getpass('Confirm password: ')
        if first != second:
            raise SystemExit('Passwords do not match')
        print('Created' if create_user(settings, args.username, first) else 'Account already exists; unchanged')

if __name__ == '__main__':
    main()

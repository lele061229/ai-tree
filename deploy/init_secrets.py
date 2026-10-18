"""Run once in the deployment checkout. Creates credentials locally without printing values."""
import argparse
import os
import secrets
from pathlib import Path
from urllib.parse import urlparse

def initialize(root, origin, local_tunnel=False):
    parsed = urlparse(origin)
    local_origin = 'http://127.0.0.1:18080'
    if local_tunnel and origin != local_origin:
        raise ValueError('SSH 隧道模式仅允许 '+local_origin)
    if (not local_tunnel and parsed.scheme != 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or any(c.isspace() for c in origin):
        raise ValueError('请提供完整 HTTPS 地址，例如 https://knowledge.example.com 或 HTTPS 公网 IP')
    # Validate malformed ports before creating any files.
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError('无效的端口')
    secret_dir = root / '.secrets'
    if secret_dir.exists() or (root / '.env').exists():
        raise FileExistsError('已有配置或密钥目录；未覆盖。请复用或人工检查原配置。')
    old = os.umask(0o077)
    try:
        secret_dir.mkdir(mode=0o700)
        for name in ['db_password','db_root_password','admin_password']:
            (secret_dir/name).write_text(secrets.token_urlsafe(32))
        (secret_dir/'ai_api_key').write_text('')
        (root/'.env').write_text('APP_ORIGIN='+origin.rstrip('/')+'\nAPP_PORT=18080\nCOOKIE_SECURE='+('false' if local_tunnel else 'true')+'\nADMIN_USER=admin\nAI_BASE_URL=\nAI_MODEL=\n')
    finally:
        os.umask(old)
    # The app container runs as a separate UID. Docker Compose secrets are file mounts;
    # allow that UID to read the mounted individual files without exposing the parent directory.
    for file in secret_dir.iterdir():
        file.chmod(0o444)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--origin',required=True)
    parser.add_argument('--local-tunnel',action='store_true',help='Only for the fixed loopback origin over an SSH tunnel')
    args=parser.parse_args()
    initialize(Path(__file__).resolve().parents[1],args.origin,args.local_tunnel)
    print('已生成本地配置与密钥。账号为 admin；初始密码位于 .secrets/admin_password。')

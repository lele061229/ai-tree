from pathlib import Path
import os
import pytest
from deploy.init_secrets import initialize
from backend.config import Settings

def test_initialization_keeps_credentials_local_and_refuses_overwrite(tmp_path):
    initialize(tmp_path,'https://knowledge.example.com')
    files=list((tmp_path/'.secrets').iterdir())
    assert len(files)==4
    if os.name != 'nt':
        # POSIX：mode 位就是隔离本身。
        assert (tmp_path/'.secrets').stat().st_mode & 0o777 == 0o700
        assert (tmp_path/'.env').stat().st_mode & 0o777 == 0o600
    else:
        # Windows 没有 POSIX mode 位，chmod 不构成隔离；权限必须用 ACL 验证。
        # 这里只断言文件确实落盘，权限由 Skill 的 check 命令（icacls）负责。
        assert (tmp_path/'.secrets'/'admin_password').is_file()
    before=(tmp_path/'.secrets/admin_password').read_text()
    assert len(before)>=32
    with pytest.raises(FileExistsError):initialize(tmp_path,'https://other.example.com')
    assert (tmp_path/'.secrets/admin_password').read_text()==before

def test_production_origin_must_be_https(tmp_path):
    with pytest.raises(ValueError):initialize(tmp_path,'http://example.com')
    assert not (tmp_path/'.secrets').exists()

def test_explicit_ssh_tunnel_creates_loopback_configuration(tmp_path):
    initialize(tmp_path, 'http://127.0.0.1:18080', local_tunnel=True)
    config = (tmp_path/'.env').read_text()
    assert 'COOKIE_SECURE=false\n' in config
    assert 'APP_ORIGIN=http://127.0.0.1:18080\n' in config

@pytest.mark.parametrize('origin', ['http://120.25.151.128:18080', 'http://localhost:18080', 'http://127.0.0.1:18081'])
def test_tunnel_option_cannot_enable_public_http(tmp_path, origin):
    with pytest.raises(ValueError): initialize(tmp_path, origin, local_tunnel=True)
    assert not (tmp_path/'.secrets').exists()

def test_https_ip_is_supported_and_remains_secure(tmp_path):
    initialize(tmp_path, 'https://192.0.2.10:18443')
    assert 'COOKIE_SECURE=true\n' in (tmp_path/'.env').read_text()

@pytest.mark.parametrize('origin', ['https://example.com\nOTHER=value', 'https://name:password@example.com', 'https://example.com:broken'])
def test_invalid_origin_does_not_create_secrets(tmp_path, origin):
    with pytest.raises(ValueError): initialize(tmp_path, origin)
    assert not (tmp_path/'.secrets').exists()

def test_runtime_rejects_public_http_even_with_cookie_override(monkeypatch):
    monkeypatch.setenv('DATABASE_URL', 'sqlite:///unused-test-only.db')
    monkeypatch.setenv('COOKIE_SECURE', 'false')
    monkeypatch.setenv('APP_ORIGIN', 'http://192.0.2.10:18080')
    with pytest.raises(RuntimeError, match='loopback'): Settings.from_env()
    monkeypatch.setenv('APP_ORIGIN', 'http://127.0.0.1:18080')
    assert Settings.from_env().secure_cookie is False

def test_loopback_session_can_login_save_and_logout(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import create_app
    from backend.manage import migrate, create_user
    origin = 'http://127.0.0.1:18080'
    monkeypatch.setenv('DATABASE_URL', 'sqlite:///'+str(tmp_path/'tunnel.db'))
    monkeypatch.setenv('APP_ORIGIN', origin)
    monkeypatch.setenv('COOKIE_SECURE', 'false')
    settings = Settings.from_env()
    migrate(settings)
    create_user(settings, 'pilot', 'test-only-password')
    app = create_app(settings)
    try:
        with TestClient(app, base_url=origin) as client:
            assert client.get('/api/state').status_code == 401
            login = client.post('/api/login', headers={'Origin': origin},
                                json={'username':'pilot','password':'test-only-password'})
            assert login.status_code == 200
            cookie = login.headers['set-cookie'].lower()
            assert 'httponly' in cookie and 'samesite=strict' in cookie and '; secure' not in cookie
            client.headers.update({'Origin':origin, 'X-CSRF-Token':login.json()['csrf']})
            assert client.patch('/api/preferences',json={'goal_text':'私密试运行'}).status_code == 200
            assert client.post('/api/logout').status_code == 200
            assert client.get('/api/state').status_code == 401
    finally:
        app.state.engine.dispose()

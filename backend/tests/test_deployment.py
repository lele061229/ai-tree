from pathlib import Path
import pytest
from deploy.init_secrets import initialize

def test_initialization_keeps_credentials_local_and_refuses_overwrite(tmp_path):
    initialize(tmp_path,'https://knowledge.example.com')
    files=list((tmp_path/'.secrets').iterdir())
    assert len(files)==4
    assert (tmp_path/'.secrets').stat().st_mode & 0o777 == 0o700
    assert (tmp_path/'.env').stat().st_mode & 0o777 == 0o600
    before=(tmp_path/'.secrets/admin_password').read_text()
    assert len(before)>=32
    with pytest.raises(FileExistsError):initialize(tmp_path,'https://other.example.com')
    assert (tmp_path/'.secrets/admin_password').read_text()==before

def test_production_origin_must_be_https(tmp_path):
    with pytest.raises(ValueError):initialize(tmp_path,'http://example.com')
    assert not (tmp_path/'.secrets').exists()

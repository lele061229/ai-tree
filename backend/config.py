"""Runtime configuration. Secrets are read from environment or Docker secret files."""
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote_plus

ROOT = Path(__file__).resolve().parents[1]

def secret(name: str, default: str = '') -> str:
    path = os.getenv(name + '_FILE')
    return Path(path).read_text().strip() if path else os.getenv(name, default)

@dataclass(frozen=True)
class Settings:
    database_url: str
    origin: str = 'http://localhost:18080'
    secure_cookie: bool = True
    ai_url: str = ''
    ai_key: str = ''
    ai_model: str = ''
    testing: bool = False

    @property
    def ai_ready(self):
        return bool(self.ai_url and self.ai_key and self.ai_model)

    @classmethod
    def from_env(cls):
        url = os.getenv('DATABASE_URL')
        if not url:
            password = secret('DB_PASSWORD')
            if not password:
                raise RuntimeError('DB_PASSWORD / DB_PASSWORD_FILE must be configured')
            url = ('mysql+pymysql://' + quote_plus(os.getenv('DB_USER', 'knowledge_os')) + ':'
                   + quote_plus(password) + '@' + os.getenv('DB_HOST', 'db') + ':3306/'
                   + os.getenv('DB_NAME', 'knowledge_os') + '?charset=utf8mb4')
        origin = os.getenv('APP_ORIGIN', '').rstrip('/')
        if not origin:
            raise RuntimeError('APP_ORIGIN must be configured')
        secure = os.getenv('COOKIE_SECURE', 'true').lower() == 'true'
        if secure and not origin.startswith('https://'):
            raise RuntimeError('Secure-cookie deployment requires an HTTPS APP_ORIGIN')
        if not secure and origin != 'http://127.0.0.1:18080':
            raise RuntimeError('Non-secure cookies are permitted only for the fixed loopback SSH-tunnel origin')
        ai_url = os.getenv('AI_BASE_URL', '').rstrip('/')
        if ai_url and not ai_url.startswith('https://'):
            raise RuntimeError('AI_BASE_URL must use HTTPS')
        return cls(url, origin, secure, ai_url,
                   secret('AI_API_KEY'), os.getenv('AI_MODEL', ''))

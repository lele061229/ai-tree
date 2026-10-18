import hashlib
import secrets
import time
from fastapi import Depends, HTTPException, Request
from pwdlib import PasswordHash
from sqlalchemy import select
from .database import SessionRecord, User, get_db

passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash('not-a-real-account-' + secrets.token_hex(16))
def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def cookie_name(settings):
    return '__Host-knowledge_session' if settings.secure_cookie else 'knowledge_session'

def check_origin(request):
    origin = request.headers.get('origin')
    if origin and origin.rstrip('/') != request.app.state.settings.origin:
        raise HTTPException(403, '请求来源不匹配')

def current_user(request: Request, db=Depends(get_db)):
    settings = request.app.state.settings
    token = request.cookies.get(cookie_name(settings), '')
    session = db.get(SessionRecord, digest(token)) if token else None
    if not session or session.expires <= int(time.time()):
        raise HTTPException(401, '请先登录')
    user = db.get(User, session.user_id)
    if not user:
        raise HTTPException(401, '账号不存在')
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        check_origin(request)
        if not secrets.compare_digest(request.headers.get('x-csrf-token', ''), session.csrf):
            raise HTTPException(403, '请求校验失败，请刷新页面')
    request.state.session = session
    return user

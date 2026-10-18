import secrets
import time
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select, delete
from ..database import LoginBucket, SessionRecord, User, get_db
from ..schemas import LoginInput
from ..security import DUMMY_HASH, check_origin, cookie_name, current_user, digest, passwords

router = APIRouter(prefix='/api')

@router.post('/login')
def login(data: LoginInput, request: Request, response: Response, db=Depends(get_db)):
    check_origin(request)
    now = int(time.time())
    key = digest((request.client.host if request.client else 'unknown') + ':' + data.username.casefold())
    bucket = db.scalar(select(LoginBucket).where(LoginBucket.key == key).with_for_update())
    if not bucket:
        bucket = LoginBucket(key=key, count=0, reset_at=now + 900)
        db.add(bucket)
        db.flush()
    if bucket.reset_at <= now:
        bucket.count, bucket.reset_at = 0, now + 900
    if bucket.count >= 10:
        raise HTTPException(429, '登录尝试过多，请15分钟后再试')
    user = db.scalar(select(User).where(User.username == data.username))
    valid = passwords.verify(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        bucket.count += 1
        db.commit()
        raise HTTPException(401, '用户名或密码不正确')
    bucket.count = 0
    token, csrf = secrets.token_urlsafe(40), secrets.token_hex(24)
    db.execute(delete(SessionRecord).where(SessionRecord.expires <= now))
    db.add(SessionRecord(token_hash=digest(token), csrf=csrf, user_id=user.id, expires=now + 604800))
    db.commit()
    response.set_cookie(cookie_name(request.app.state.settings), token, max_age=604800,
                        secure=request.app.state.settings.secure_cookie, httponly=True, samesite='strict', path='/')
    return {'user': user.username, 'csrf': csrf}

@router.get('/session')
def session(request: Request, user=Depends(current_user)):
    return {'user': user.username, 'csrf': request.state.session.csrf}

@router.post('/logout')
def logout(request: Request, response: Response, user=Depends(current_user), db=Depends(get_db)):
    db.delete(request.state.session)
    db.commit()
    response.delete_cookie(cookie_name(request.app.state.settings), path='/', secure=request.app.state.settings.secure_cookie,
                           httponly=True, samesite='strict')
    return {'ok': True}

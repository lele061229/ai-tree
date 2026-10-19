"""Agent submission intake: scoped credentials, idempotent packages, review-only plans.

A sync token can only submit and read back its own submission. It cannot read the
workspace, apply a plan, or impersonate a browser session. Applying still requires the
owner's cookie session plus CSRF token on /api/imports/{id}/apply.
"""
import json
import secrets
import time
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from ..database import ImportBatch, Source, SyncSubmission, SyncToken, User, get_db
from ..knowledge import build_plan, ensure_workspace, identifier, latest, normalize
from ..schemas import Extraction, SyncPackage, SyncTokenInput
from ..security import current_user, digest

router = APIRouter(prefix='/api/sync')

# Fields that would let an agent declare mastery, verification or delivery state.
FORBIDDEN = {'level', 'stage', 'mastery', 'verified', 'verification', 'confidence',
             'autoapply', 'applynow', 'delivered', 'online', 'progress', 'passed'}
MAX_ATTEMPTS = 5


def scan_forbidden(value, path='$', found=None):
    found = found if found is not None else []
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).lower()
            here = f'{path}.{key}'
            if lowered in FORBIDDEN:
                found.append(here)
            scan_forbidden(child, here, found)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            scan_forbidden(child, f'{path}[{index}]', found)
    return found


def sync_identity(request: Request, db=Depends(get_db)):
    """Bearer-only. Cookie sessions are deliberately not accepted on this channel."""
    scheme, _, token = request.headers.get('authorization', '').partition(' ')
    if scheme.lower() != 'bearer' or not token.startswith('ko_sync_'):
        raise HTTPException(401, {'code': 'missing_token', 'message': '缺少同步凭据（Authorization: Bearer ko_sync_...）'})
    row = db.scalar(select(SyncToken).where(SyncToken.token_hash == digest(token)))
    now = int(time.time())
    if not row or row.revoked_at is not None or row.expires_at <= now:
        raise HTTPException(401, {'code': 'invalid_token', 'message': '同步凭据无效、已过期或已撤销'})
    user = db.get(User, row.user_id)
    if not user:
        raise HTTPException(401, {'code': 'invalid_token', 'message': '同步凭据对应的账号不存在'})
    row.last_used_at = now
    db.commit()
    request.state.sync_token = row
    return user


def source_for(db, user_id, title, body):
    """Immutable source per digest. A retry of identical text never creates a second copy."""
    sha = digest(body)
    existing = db.scalar(select(Source).where(Source.user_id == user_id, Source.digest == sha))
    if existing:
        return existing, True
    source = Source(id=identifier('src_'), user_id=user_id, title=title[:160], body=body, digest=sha)
    try:
        with db.begin_nested():
            db.add(source)
    except IntegrityError:
        existing = db.scalar(select(Source).where(Source.user_id == user_id, Source.digest == sha))
        if not existing:
            raise
        return existing, True
    return source, False


def compose_body(package):
    """Keep every fragment verbatim. AI summaries are labelled in the stored text itself.

    返回 (body, summary_only, mixed)。summary_only 只在**整包都没有原文**时为真——
    混装包不能被打成「AI 摘要」，否则来源标注会歪曲用户实际提交的内容。
    """
    parts, kinds = [], []
    for fragment in package.fragments:
        kinds.append(fragment.kind)
        if fragment.kind == 'ai_summary':
            body = fragment.text.strip() or '；'.join(
                f'{item.title}：{item.summary[:80]}' for item in package.items)
            header = '### [AI 摘要 · 非原文] ' + fragment.title
            note = ('整理说明：' + fragment.note + '\n') if fragment.note else ''
            parts.append(f'{header}\n{note}{body}')
        else:
            parts.append('### [原文] ' + fragment.title + '\n' + fragment.text.strip())
    summary_only = bool(kinds) and all(kind == 'ai_summary' for kind in kinds)
    mixed = any(kind == 'ai_summary' for kind in kinds) and not summary_only
    return '\n\n'.join(parts)[:200000], summary_only, mixed


def build_extraction(package):
    titles = {item.key: item.title for item in package.items}
    return Extraction.model_validate({'nodes': [{
        'title': item.title, 'aliases': item.aliases, 'kind': item.kind, 'layer': item.layer,
        'summary': item.summary, 'concepts': item.concepts, 'tasks': item.tasks,
        'mistakes': item.mistakes,
        'prerequisites': [titles.get(req, req) for req in item.prerequisites],
    } for item in package.items]})


def build_details(package):
    return {normalize(item.title): {
        'understanding': item.understanding,
        'openQuestions': item.openQuestions,
        'recommended': item.recommended,
        'statement': item.project.statement if item.project else '',
    } for item in package.items}


def receipt(batch, submission, duplicate=False):
    plan = batch.plan or {}
    return {
        'submissionId': submission.submission_id,
        'batchId': batch.id,
        'status': batch.status,
        'duplicate': duplicate,
        'baseVersion': batch.base_version,
        'changes': plan.get('changes', []),
        'notice': plan.get('notice', ''),
        'attempts': submission.attempts,
    }


def commit_or_reconcile(db, user_id, submission_id, payload_digest):
    """提交时可能的唯一键冲突：两个进程同时处理同一编号。

    不能让唯一约束抛出未处理的 500。冲突说明"另一个请求已经在写"，此时：
    - 对方的行已经落库且内容相同 → 按幂等返回回执；
    - 内容不同或仍在处理中 → 返回可重试的 409，客户端沿用同一编号重试。
    """
    try:
        db.commit()
        return None
    except IntegrityError:
        db.rollback()
    except OperationalError as exc:
        # 行锁等待 / 死锁：同样是"另一个请求在写同一个编号"，不能变成 500。
        db.rollback()
        detail = str(getattr(exc, 'orig', exc)).lower()
        if 'deadlock' not in detail and 'lock wait' not in detail:
            raise
        raise HTTPException(409, {
            'code': 'submission_busy',
            'message': '同一提交编号正在被另一个请求写入（行锁等待）。稍后用同一编号重试即可。',
            'submissionId': submission_id,
            'retryable': True}) from None
    row = db.scalar(select(SyncSubmission).where(
        SyncSubmission.user_id == user_id, SyncSubmission.submission_id == submission_id))
    if row and row.digest == payload_digest and row.status in ('ready', 'applied'):
        batch = db.get(ImportBatch, row.batch_id)
        if batch:
            return receipt(batch, row, duplicate=True)
    raise HTTPException(409, {
        'code': 'submission_in_flight',
        'message': '同一提交编号正在被并发处理。稍后用同一编号重试即可，不会产生重复批次。',
        'submissionId': submission_id,
        'retryable': True}) from None


@router.post('/tokens')
def create_token(data: SyncTokenInput, request: Request, user=Depends(current_user), db=Depends(get_db)):
    raw = 'ko_sync_' + secrets.token_urlsafe(32)
    now = int(time.time())
    row = SyncToken(id=identifier('tok_'), user_id=user.id, label=data.label.strip(),
                    token_hash=digest(raw), prefix=raw[:16],
                    expires_at=now + data.expiresInDays * 86400)
    db.add(row)
    db.commit()
    return {'id': row.id, 'token': raw, 'prefix': row.prefix, 'label': row.label,
            'expiresAt': row.expires_at, 'origin': request.app.state.settings.origin}


@router.get('/tokens')
def list_tokens(user=Depends(current_user), db=Depends(get_db)):
    rows = db.scalars(select(SyncToken).where(SyncToken.user_id == user.id)
                      .order_by(SyncToken.created_at.desc())).all()
    now = int(time.time())
    return [{'id': row.id, 'label': row.label, 'prefix': row.prefix,
             'createdAt': row.created_at, 'lastUsedAt': row.last_used_at,
             'expiresAt': row.expires_at, 'revokedAt': row.revoked_at,
             'active': row.revoked_at is None and row.expires_at > now} for row in rows]


@router.post('/tokens/{token_id}/revoke')
def revoke_token(token_id: str, user=Depends(current_user), db=Depends(get_db)):
    row = db.scalar(select(SyncToken).where(SyncToken.id == token_id, SyncToken.user_id == user.id))
    if not row:
        raise HTTPException(404, '同步凭据不存在')
    if row.revoked_at is None:
        row.revoked_at = int(time.time())
        db.commit()
    return {'ok': True, 'id': row.id, 'revoked': True}


@router.get('/status')
def status(request: Request, user=Depends(sync_identity), db=Depends(get_db)):
    workspace = ensure_workspace(db, user.id)
    pending = db.scalars(select(SyncSubmission).where(
        SyncSubmission.user_id == user.id, SyncSubmission.status == 'ready')).all()
    token = request.state.sync_token
    db.commit()
    return {'user': user.username, 'currentVersion': workspace.current_version,
            'aiReady': request.app.state.settings.ai_ready, 'pending': len(pending),
            'token': {'label': token.label, 'expiresAt': token.expires_at}}


@router.post('/submissions')
async def submit(request: Request, user=Depends(sync_identity), db=Depends(get_db)):
    try:
        raw = await request.json()
    except Exception:
        raise HTTPException(422, {'code': 'invalid_json', 'message': '请求体不是合法 JSON'}) from None
    if not isinstance(raw, dict):
        raise HTTPException(422, {'code': 'invalid_package', 'message': '更新包必须是 JSON 对象'})

    bad = scan_forbidden(raw)
    if bad:
        raise HTTPException(422, {
            'code': 'authority_violation',
            'message': '更新包不得声明掌握等级、验证状态或上线状态；这些只能由用户在平台内单独确认。',
            'paths': bad[:10]})

    try:
        package = SyncPackage.model_validate(raw)
    except ValidationError as exc:
        problems = [{'path': '.'.join(str(p) for p in err['loc']), 'message': err['msg']}
                    for err in exc.errors()][:10]
        raise HTTPException(422, {'code': 'invalid_package', 'message': '更新包格式不符合协议 v1',
                                  'problems': problems}) from None

    payload_digest = digest(json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
    now = int(time.time())
    existing = db.scalar(select(SyncSubmission).where(
        SyncSubmission.user_id == user.id, SyncSubmission.submission_id == package.submissionId))

    # A successful submission is frozen: same id + same bytes is a no-op, same id + new
    # bytes is a client bug. A failed submission may be corrected and retried with the
    # same identifier, which is what "保留待上传包、沿用提交标识" requires.
    if existing and existing.status in ('ready', 'applied'):
        if existing.digest != payload_digest:
            raise HTTPException(409, {
                'code': 'submission_id_conflict',
                'message': '同一提交标识已成功提交过不同内容。修改后的内容请生成新的 submissionId。',
                'submissionId': existing.submission_id})
        batch = db.get(ImportBatch, existing.batch_id)
        if batch:
            return receipt(batch, existing, duplicate=True)
    if existing and existing.status == 'failed' and existing.attempts >= MAX_ATTEMPTS:
        raise HTTPException(429, {'code': 'too_many_attempts',
                                  'message': f'该提交标识已尝试 {existing.attempts} 次，请修正后使用新的 submissionId。'})

    ensure_workspace(db, user.id)
    snapshot = latest(db, user.id)
    if package.baseVersion is not None and package.baseVersion != snapshot['version']:
        raise HTTPException(409, {
            'code': 'stale_base_version',
            'message': f"路线已更新到 v{snapshot['version']}，提交基于 v{package.baseVersion}。请重新读取最新路线后重试。",
            'currentVersion': snapshot['version'], 'baseVersion': package.baseVersion,
            'submissionId': package.submissionId})

    body, summary_only, mixed = compose_body(package)
    # 一次提交 = 一份来源文档。标题必须描述这一整包，不能拿第一个片段的标题冒充，
    # 否则每个节点都会"引用"到同一段无关原文。逐条追溯留给 items[].sources[]（下一轮）。
    source_title = package.scope.strip()[:120] or package.fragments[0].title
    source, reused = source_for(db, user.id, source_title, body)

    batch = db.get(ImportBatch, existing.batch_id) if existing else None
    if batch is None:
        batch = ImportBatch(id=identifier('batch_'), user_id=user.id, source_id=source.id,
                            base_version=snapshot['version'], status='processing')
        db.add(batch)
    else:
        batch.source_id, batch.base_version, batch.status = source.id, snapshot['version'], 'processing'
        batch.error = None
    db.flush()

    try:
        plan = build_plan(snapshot, source, build_extraction(package),
                          details=build_details(package), channel='skill',
                          summary_only=summary_only, mixed=mixed)
    except ValueError as exc:
        message = str(exc)[:300]
        batch.status, batch.error, batch.plan = 'failed', message, None
        if existing:
            existing.status, existing.error, existing.attempts = 'failed', message, existing.attempts + 1
            existing.updated_at = now
            submission = existing
        else:
            submission = SyncSubmission(id=identifier('sub_'), user_id=user.id,
                                        submission_id=package.submissionId, digest=payload_digest,
                                        batch_id=batch.id, format_version=package.formatVersion,
                                        status='failed', error=message, attempts=1)
            db.add(submission)
        reconciled = commit_or_reconcile(db, user.id, package.submissionId, payload_digest)
        if reconciled is not None:
            return reconciled
        raise HTTPException(422, {
            'code': 'invalid_relations',
            'message': message,
            'submissionId': package.submissionId,
            'batchId': batch.id,
            'retryable': True}) from None

    plan['sync'] = {
        'submissionId': package.submissionId,
        'scope': package.scope,
        'sourceType': package.sourceType,
        'agent': package.agent.model_dump() if package.agent else None,
        'receivedAt': now,
        'summaryOnly': summary_only,
        'mixedFragments': mixed,
        'sourceReused': reused,
        'fragments': [{'title': f.title, 'kind': f.kind} for f in package.fragments],
        'items': [{'key': item.key, 'title': item.title,
                   'understanding': item.understanding, 'openQuestions': item.openQuestions,
                   'recommended': item.recommended,
                   'statement': item.project.statement if item.project else ''}
                  for item in package.items],
    }
    batch.plan, batch.status, batch.error = plan, 'ready', None

    if existing:
        existing.status, existing.error, existing.digest = 'ready', None, payload_digest
        existing.attempts += 1
        existing.updated_at = now
        submission = existing
    else:
        submission = SyncSubmission(id=identifier('sub_'), user_id=user.id,
                                    submission_id=package.submissionId, digest=payload_digest,
                                    batch_id=batch.id, format_version=package.formatVersion,
                                    status='ready', attempts=1)
        db.add(submission)
    reconciled = commit_or_reconcile(db, user.id, package.submissionId, payload_digest)
    if reconciled is not None:
        return reconciled
    result = receipt(batch, submission)
    result['reviewUrl'] = request.app.state.settings.origin + '/'
    return result


@router.get('/submissions/{submission_id}')
def submission_status(submission_id: str, user=Depends(sync_identity), db=Depends(get_db)):
    row = db.scalar(select(SyncSubmission).where(
        SyncSubmission.user_id == user.id, SyncSubmission.submission_id == submission_id))
    if not row:
        raise HTTPException(404, {'code': 'not_found', 'message': '提交记录不存在'})
    batch = db.get(ImportBatch, row.batch_id)
    plan = (batch.plan or {}) if batch else {}
    return {'submissionId': row.submission_id, 'status': row.status, 'batchId': row.batch_id,
            'error': row.error, 'attempts': row.attempts,
            'baseVersion': batch.base_version if batch else None,
            'changes': plan.get('changes', []),
            'notice': plan.get('notice', '')}

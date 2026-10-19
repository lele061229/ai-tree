import time
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from ..ai_adapter import AIUnavailable
from ..database import ImportBatch, Source, SyncSubmission, Version, get_db
from ..knowledge import build_plan, commit_plan, ensure_workspace, identifier, latest
from ..schemas import ApplyInput, SourceInput
from ..security import current_user, digest

router = APIRouter(prefix='/api')

def owned_source(db, user_id, source_id):
    source = db.scalar(select(Source).where(Source.id == source_id, Source.user_id == user_id))
    if not source:
        raise HTTPException(404, '资料不存在')
    return source

@router.post('/sources')
def create_source(data: SourceInput, user=Depends(current_user), db=Depends(get_db)):
    body = data.text.strip()
    if len(body) < 10:
        raise HTTPException(422, '资料内容过短')
    sha = digest(body)
    existing = db.scalar(select(Source).where(Source.user_id == user.id, Source.digest == sha))
    if existing:
        return {'id': existing.id, 'duplicate': True}
    ensure_workspace(db, user.id)
    source = Source(id=identifier('src_'), user_id=user.id, title=data.title.strip(), body=body, digest=sha)
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Source).where(Source.user_id == user.id, Source.digest == sha))
        if not existing:
            raise
        return {'id': existing.id, 'duplicate': True}
    return {'id': source.id, 'duplicate': False}

@router.post('/sources/{source_id}/analyze')
def analyze(source_id: str, request: Request, user=Depends(current_user), db=Depends(get_db)):
    source = owned_source(db, user.id, source_id)
    if not request.app.state.settings.ai_ready:
        raise HTTPException(503, '模型尚未配置。原始资料已保存，配置后可重试分析。')
    snap = latest(db, user.id)
    existing = db.scalar(select(ImportBatch).where(ImportBatch.user_id == user.id,
                         ImportBatch.source_id == source.id, ImportBatch.status == 'applied'))
    if existing:
        return {'id': existing.id, 'status': 'applied', 'notice': '这份资料已应用，未重复创建版本。'}
    batch = ImportBatch(id=identifier('batch_'), user_id=user.id, source_id=source.id,
                        base_version=snap['version'], status='processing')
    db.add(batch)
    db.commit()
    try:
        extraction = request.app.state.ai.extract(source, snap)
        batch.plan = build_plan(snap, source, extraction)
        batch.status = 'ready'
        db.commit()
        return {'id': batch.id, 'status': batch.status, 'changes': batch.plan['changes'], 'notice': batch.plan['notice']}
    except (AIUnavailable, ValueError) as exc:
        batch.status, batch.error = 'failed', str(exc)[:300]
        db.commit()
        raise HTTPException(422 if isinstance(exc, ValueError) else 502, batch.error) from None

@router.get('/imports')
def imports(user=Depends(current_user), db=Depends(get_db)):
    batches = db.scalars(select(ImportBatch).where(ImportBatch.user_id == user.id).order_by(ImportBatch.created_at.desc()).limit(30)).all()
    submissions = {row.batch_id: row for row in db.scalars(
        select(SyncSubmission).where(SyncSubmission.user_id == user.id)).all()}
    titles = {row.id: row.title for row in db.scalars(
        select(Source).where(Source.user_id == user.id)).all()}
    result = []
    for b in batches:
        plan = b.plan or {}
        sub = submissions.get(b.id)
        result.append({'id': b.id, 'status': b.status, 'sourceId': b.source_id, 'error': b.error,
                       'changes': plan.get('changes', []), 'baseVersion': b.base_version,
                       'sourceTitle': titles.get(b.source_id, ''),
                       'channel': 'skill' if sub else 'source',
                       'submissionId': sub.submission_id if sub else None,
                       'attempts': sub.attempts if sub else None,
                       'sync': plan.get('sync')})
    return result

@router.get('/summary')
def summary(user=Depends(current_user), db=Depends(get_db)):
    """只读汇总，给桌面卡片用。

    `/api/imports` 只返回最近 30 条，不能拿它数待审数量。这里直接用 COUNT，
    不改动既有接口，因此对老前端完全兼容。
    """
    snap = latest(db, user.id)
    counted = {}
    for status in ('ready', 'failed', 'applied', 'processing'):
        counted[status] = db.scalar(select(func.count()).select_from(ImportBatch).where(
            ImportBatch.user_id == user.id, ImportBatch.status == status)) or 0
    last = db.scalar(select(SyncSubmission).where(SyncSubmission.user_id == user.id)
                     .order_by(SyncSubmission.updated_at.desc()).limit(1))
    updated = db.scalar(select(func.max(Version.created_at)).where(Version.user_id == user.id))
    return {
        'version': snap['version'], 'nodes': len(snap['nodes']),
        'pending': counted['ready'], 'failed': counted['failed'],
        'applied': counted['applied'], 'processing': counted['processing'],
        'updatedAt': updated or 0,
        'lastSubmission': None if not last else {
            'submissionId': last.submission_id, 'status': last.status,
            'attempts': last.attempts, 'error': last.error, 'updatedAt': last.updated_at},
    }


@router.post('/imports/{batch_id}/apply')
def apply(batch_id: str, data: ApplyInput, user=Depends(current_user), db=Depends(get_db)):
    batch = db.scalar(select(ImportBatch).where(ImportBatch.id == batch_id, ImportBatch.user_id == user.id).with_for_update())
    if not batch:
        raise HTTPException(404, '导入批次不存在')
    if batch.status == 'applied':
        return {'ok': True, 'duplicate': True}
    if batch.status != 'ready' or not batch.plan:
        raise HTTPException(409, '导入分析尚未完成或未通过校验')
    if not data.acknowledge:
        raise HTTPException(422, '请先审阅并确认变更')
    try:
        number = commit_plan(db, user.id, batch)
        submission = db.scalar(select(SyncSubmission).where(
            SyncSubmission.user_id == user.id, SyncSubmission.batch_id == batch.id))
        if submission:
            submission.status, submission.updated_at = 'applied', int(time.time())
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(409, str(exc)) from None
    return {'ok': True, 'version': number, 'duplicate': False}

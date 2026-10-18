from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from ..database import Progress, Source, Version, get_db
from ..knowledge import ensure_workspace, latest
from ..schemas import PreferencesInput, TaskInput
from ..security import current_user

router = APIRouter(prefix='/api')

@router.get('/state')
def state(user=Depends(current_user), db=Depends(get_db)):
    workspace = ensure_workspace(db, user.id)
    versions = db.scalars(select(Version).where(Version.user_id == user.id).order_by(Version.number)).all()
    progress = db.scalars(select(Progress).where(Progress.user_id == user.id)).all()
    db.commit()
    prefs = workspace.preferences
    return {'schema': 2, 'mode': 'server', 'snapshots': [v.snapshot for v in versions],
            'tasks': {f'v{p.version}:{p.node_id}:{p.task_index}': p.done for p in progress}, 'answers': {},
            'target': prefs.get('target', ''), 'goalText': prefs.get('goal_text', '建立我的个人能力树'),
            'navigationCollapsed': prefs.get('navigation_collapsed', False), 'recents': prefs.get('recents', [])}

@router.patch('/preferences')
def preferences(data: PreferencesInput, user=Depends(current_user), db=Depends(get_db)):
    workspace = ensure_workspace(db, user.id)
    values = data.model_dump(exclude_none=True)
    snap = latest(db, user.id)
    projects = {n['id'] for n in snap['nodes'] if n['kind'] == 'project'}
    if values.get('target') and values['target'] not in projects:
        raise HTTPException(422, '目标项目不存在')
    if 'recents' in values:
        ids = {n['id'] for n in snap['nodes']}
        values['recents'] = [key for key in values['recents'] if key in ids]
    workspace.preferences = {**workspace.preferences, **values}
    db.commit()
    return {'ok': True}

@router.put('/progress')
def progress(data: TaskInput, user=Depends(current_user), db=Depends(get_db)):
    workspace = ensure_workspace(db, user.id)
    if data.version != workspace.current_version:
        raise HTTPException(409, '历史版本只读，请返回最新路线')
    node = next((n for n in latest(db, user.id)['nodes'] if n['id'] == data.node_id), None)
    if not node or data.index >= len(node['tasks']):
        raise HTTPException(404, '练习不存在')
    key = (user.id, data.version, data.node_id, data.index)
    item = db.get(Progress, key)
    if not item:
        item = Progress(user_id=user.id, version=data.version, node_id=data.node_id, task_index=data.index)
        db.add(item)
    item.done = data.done
    db.commit()
    return {'ok': True}

@router.get('/sources')
def sources(user=Depends(current_user), db=Depends(get_db)):
    items = db.scalars(select(Source).where(Source.user_id == user.id).order_by(Source.created_at.desc())).all()
    return [{'id': s.id, 'title': s.title, 'createdAt': s.created_at} for s in items]

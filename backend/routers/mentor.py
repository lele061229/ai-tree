from fastapi import APIRouter, Depends, HTTPException, Request
from ..ai_adapter import AIUnavailable
from ..database import get_db
from ..knowledge import latest, ensure_workspace
from ..schemas import MentorInput
from ..security import current_user

router = APIRouter(prefix='/api')

@router.post('/mentor')
def mentor(data: MentorInput, request: Request, user=Depends(current_user), db=Depends(get_db)):
    snap = latest(db, user.id)
    node = next((n for n in snap['nodes'] if n['id'] == data.node_id), None)
    if not node:
        raise HTTPException(404, '节点不存在')
    try:
        return request.app.state.ai.mentor(snap, node, data.question, ensure_workspace(db, user.id).preferences.get('goal_text', ''))
    except AIUnavailable as exc:
        raise HTTPException(503, str(exc)) from None

"""Authoritative graph alignment and version creation. Model output cannot set mastery or stage."""
import copy
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from sqlalchemy import delete, select
from .database import KnowledgeNode, KnowledgeEdge, Progress, Source, Version, Workspace

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def identifier(prefix):
    return prefix + uuid.uuid4().hex

def normalize(value):
    return re.sub(r'[^\w\u3400-\u9fff]', '', unicodedata.normalize('NFKC', value).casefold())

def initial_snapshot():
    return {'version': 1, 'title': '创建个人知识空间', 'time': now_iso(),
            'summary': '等待导入第一份资料', 'nodes': [], 'sources': [], 'applied': [], 'conflicts': []}

def ensure_workspace(db, user_id):
    workspace = db.get(Workspace, user_id)
    if not workspace:
        workspace = Workspace(user_id=user_id, current_version=1, preferences={})
        db.add(workspace)
        db.add(Version(user_id=user_id, number=1, snapshot=initial_snapshot()))
        db.flush()
    return workspace

def latest(db, user_id):
    w = ensure_workspace(db, user_id)
    return db.get(Version, (user_id, w.current_version)).snapshot

def source_payload(source, channel='import', summary_only=False, mixed=False):
    """Source records are immutable. `summary_only` states that no original text was supplied."""
    if summary_only:
        locator = 'AI 摘要（非原文，按授权范围整理）'
    elif mixed:
        locator = '用户授权内容（原文 + 智能体摘要，逐段标注）'
    else:
        locator = '用户授权导入的原始全文'
    return {'id': source.id, 'title': source.title,
            'type': '智能体同步' if channel == 'skill' else '导入资料',
            'date': datetime.fromtimestamp(source.created_at, timezone.utc).strftime('%Y-%m-%d'),
            'locator': locator,
            'text': source.body, 'fictional': False, 'derived': summary_only,
            'channel': 'skill' if channel == 'skill' else 'source'}

def merge_details(node, details, source):
    """Attach agent-supplied context. Never touches level, stage or verification state."""
    if not details:
        return
    for text in details.get('understanding') or []:
        item = {'text': text, 'source': source.id}
        if item not in node['notes']:
            node['notes'].append(item)
    for question in details.get('openQuestions') or []:
        bucket = node.setdefault('open', [])
        item = {'text': question, 'source': source.id}
        if item not in bucket:
            bucket.append(item)
    for text in details.get('recommended') or []:
        bucket = node.setdefault('recommendedNext', [])
        item = {'text': text, 'source': source.id}
        if item not in bucket:
            bucket.append(item)
    statement = (details.get('statement') or '').strip()
    if statement and node['kind'] == 'project':
        entry = ['用户陈述（未独立验证）', source.title, statement]
        if entry not in node['evidence']:
            node['evidence'].append(entry)
    node['channel'] = 'skill'

def validate_graph(nodes):
    by_id = {n['id']: n for n in nodes}
    if len(by_id) != len(nodes):
        raise ValueError('节点重复')
    active, seen = set(), set()
    def visit(key):
        if key in active:
            raise ValueError('模型给出的前置关系存在循环，请重新分析')
        if key in seen:
            return
        active.add(key)
        for prereq in by_id[key]['prereqs']:
            if prereq not in by_id:
                raise ValueError('前置能力缺少定义')
            visit(prereq)
        active.remove(key)
        seen.add(key)
    for key in by_id:
        visit(key)

def build_plan(snapshot, source, extraction, details=None, channel='import',
               summary_only=False, mixed=False):
    """One alignment pass for every channel (model analysis and agent sync alike).

    `details` is keyed by normalized title and carries extra context from a sync package.
    It can add notes, open questions, recommendations and a user statement — never mastery.
    """
    next_snapshot = copy.deepcopy(snapshot)
    nodes = next_snapshot['nodes']
    details = details or {}
    names = {}
    for node in nodes:
        for name in [node['title'], *node.get('aliases', [])]:
            names[normalize(name)] = node['id']
    aligned, changes, created = [], [], set()
    for item in extraction.nodes:
        candidates = {names[normalize(n)] for n in [item.title, *item.aliases] if normalize(n) in names}
        if len(candidates) > 1:
            raise ValueError('知识别名与多个已有节点冲突，请先人工核对')
        extra = details.get(normalize(item.title))
        if candidates:
            node = next(n for n in nodes if n['id'] == next(iter(candidates)))
            if (node['kind'] == 'project') != (item.kind == 'project'):
                raise ValueError('知识与项目的类型对齐冲突')
            node['notes'].append({'text': item.summary, 'source': source.id})
            if source.id not in node['refs']:
                node['refs'].append(source.id)
            merge_details(node, extra, source)
            changes.append({'type': '补充', 'title': node['title'], 'detail': item.summary, 'prerequisites': item.prerequisites})
        else:
            node = {'id': identifier('node_'), 'title': item.title, 'aliases': item.aliases,
                    'en': 'PROJECT' if item.kind == 'project' else 'KNOWLEDGE',
                    'kind': item.kind, 'layer': 4 if item.kind == 'project' else min(item.layer, 3),
                    'icon': 'box' if item.kind == 'project' else 'layers', 'level': 0 if item.kind == 'project' else 1,
                    'tag': '项目实践' if item.kind == 'project' else '导入知识',
                    'summary': item.summary, 'concepts': item.concepts, 'tasks': item.tasks,
                    'mistakes': item.mistakes, 'prereqs': [], 'refs': [source.id], 'notes': [],
                    'recommended': True, 'gap': False,
                    'evidence': [['原始资料中的陈述', source.title, '保留来源，尚未独立验证实现或掌握。']]}
            if item.kind == 'project':
                node['stage'] = '讨论'
            merge_details(node, extra, source)
            nodes.append(node)
            created.add(node['id'])
            changes.append({'type': '新增', 'title': node['title'], 'detail': item.summary, 'prerequisites': item.prerequisites})
        for name in [item.title, *item.aliases]:
            names[normalize(name)] = node['id']
        aligned.append((item, node))
    for item, node in aligned:
        for name in item.prerequisites:
            key = names.get(normalize(name))
            if not key:
                raise ValueError('前置能力「' + name[:80] + '」缺少节点定义')
            if key not in node['prereqs']:
                node['prereqs'].append(key)
    if len(nodes) > 200:
        raise ValueError('个人 V1 最多支持 200 个节点，请先整理现有知识')
    validate_graph(nodes)
    if source.id not in [s['id'] for s in next_snapshot['sources']]:
        next_snapshot['sources'].append(source_payload(source, channel, summary_only, mixed))
    return {'snapshot': next_snapshot, 'changes': changes,
            'notice': '仅新增讨论记录和关联。能力等级与已有项目阶段均不自动提升。'}

def commit_plan(db, user_id, batch):
    # Row lock serializes applies for one account; versions remain immutable.
    workspace = db.scalar(select(Workspace).where(Workspace.user_id == user_id).with_for_update())
    if batch.status == 'applied':
        return workspace.current_version
    if workspace.current_version != batch.base_version:
        raise ValueError('路线已被其他操作更新，请基于最新路线重新分析')
    snapshot = copy.deepcopy(batch.plan['snapshot'])
    snapshot['version'] = workspace.current_version + 1
    snapshot['time'] = now_iso()
    snapshot['title'] = '资料增量更新'
    snapshot['summary'] = f"本次 {len(batch.plan['changes'])} 项知识更新，保留原始来源"
    snapshot['applied'].append(batch.id)
    validate_graph(snapshot['nodes'])
    db.add(Version(user_id=user_id, number=snapshot['version'], snapshot=snapshot))
    db.execute(delete(KnowledgeEdge).where(KnowledgeEdge.user_id == user_id))
    db.execute(delete(KnowledgeNode).where(KnowledgeNode.user_id == user_id))
    db.flush()
    for node in snapshot['nodes']:
        db.add(KnowledgeNode(user_id=user_id, id=node['id'], canonical_name=node['title'],
                             kind=node['kind'], evidence_level=node['level'], payload=node))
        for parent in node['prereqs']:
            db.add(KnowledgeEdge(user_id=user_id, source_id=parent, target_id=node['id']))
    for task in db.scalars(select(Progress).where(Progress.user_id == user_id, Progress.version == workspace.current_version)).all():
        db.add(Progress(user_id=user_id, version=snapshot['version'], node_id=task.node_id, task_index=task.task_index, done=task.done))
    workspace.current_version = snapshot['version']
    batch.status = 'applied'
    return workspace.current_version

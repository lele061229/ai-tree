"""KO-002: agent sync channel — intake, review, idempotency, isolation, authority limits."""
import copy
import json
import pytest
from fastapi.testclient import TestClient
from backend.config import Settings
from backend.database import Source, User
from backend.knowledge import ensure_workspace, identifier
from backend.main import create_app
from backend.manage import migrate
from backend.security import passwords


class FakeAI:
    """Test-only. The sync channel must never depend on it."""
    def extract(self, source, snapshot):
        raise AssertionError('sync intake must not call the model adapter')

    def mentor(self, *args, **kwargs):
        raise AssertionError('sync intake must not call the model adapter')


def make_settings(tmp_path, ai=False):
    if ai:
        return Settings('sqlite:///' + str(tmp_path / 'test.db'), 'http://testserver', False,
                        'https://model.example/v1', 'test-only-key', 'test-only-model', True)
    return Settings('sqlite:///' + str(tmp_path / 'test.db'), 'http://testserver', False)


@pytest.fixture
def setup(tmp_path):
    settings = make_settings(tmp_path)
    app = create_app(settings, FakeAI())
    migrate(settings)
    with app.state.sessions() as db:
        for name in ['alice', 'bob']:
            user = User(id=identifier('user_'), username=name,
                        password_hash=passwords.hash('test-only-password'))
            db.add(user)
            db.flush()
            ensure_workspace(db, user.id)
        db.commit()
    with TestClient(app) as client:
        yield client, app
    app.state.engine.dispose()


def login(client, name='alice'):
    result = client.post('/api/login', json={'username': name, 'password': 'test-only-password'})
    assert result.status_code == 200, result.text
    client.headers['X-CSRF-Token'] = result.json()['csrf']
    return result.json()


def mint(client, label='workbuddy'):
    result = client.post('/api/sync/tokens', json={'label': label, 'expiresInDays': 30})
    assert result.status_code == 200, result.text
    return result.json()['token']


def bearer(token):
    return {'Authorization': 'Bearer ' + token}


def item(key, title, **over):
    base = {'key': key, 'title': title, 'kind': 'knowledge', 'layer': 2,
            'summary': '这是关于「' + title + '」的虚构整理说明。',
            'concepts': [['要点', '虚构要点说明']],
            'tasks': ['完成一个虚构练习'],
            'mistakes': [],
            'prerequisites': []}
    base.update(over)
    return base


def package(submission='sub_test_0001', items=None, **over):
    data = {
        'format': 'ko.learning-update',
        'formatVersion': 1,
        'submissionId': submission,
        'sourceType': 'agent_skill',
        'scope': '本轮整理范围：虚构的后端练习笔记，不含其他聊天记录',
        'agent': {'name': 'workbuddy', 'skill': 'knowledge-os-sync', 'skillVersion': '1.0.0'},
        'fragments': [{'title': '虚构练习笔记.md', 'kind': 'user_original',
                       'text': '# 虚构练习笔记\n\n我在虚构练习里学了依赖注入与事务边界，并记录了两条未解决问题。'}],
        'items': items if items is not None else [
            item('k1', '依赖注入', understanding=['依赖由外部传入，便于替换测试替身。'],
                 openQuestions=['构造函数注入和 setter 注入的取舍？'],
                 recommended=['读一遍框架的依赖解析顺序']),
            item('k2', '事务边界', prerequisites=['k1'], layer=3,
                 openQuestions=['跨仓储的操作该在哪一层提交？']),
        ],
    }
    data.update(over)
    return data


def submit(client, token, payload):
    return client.post('/api/sync/submissions', json=payload, headers=bearer(token))


def state(client):
    return client.get('/api/state').json()


def nodes(client):
    return state(client)['snapshots'][-1]['nodes']


def apply(client, batch_id):
    return client.post('/api/imports/' + batch_id + '/apply', json={'acknowledge': True})


def test_token_is_scoped_revocable_and_never_a_session(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    assert token.startswith('ko_sync_')

    status = client.get('/api/sync/status', headers=bearer(token))
    assert status.status_code == 200
    assert status.json()['user'] == 'alice'
    assert status.json()['currentVersion'] == 1
    assert status.json()['aiReady'] is False

    # A sync token must not open the workspace or apply a plan when used on its own.
    client.cookies.clear()
    assert client.get('/api/state', headers=bearer(token)).status_code == 401
    assert client.get('/api/sources', headers=bearer(token)).status_code == 401
    assert client.post('/api/imports/batch_x/apply', json={'acknowledge': True},
                       headers=bearer(token)).status_code == 401
    assert client.post('/api/sync/tokens', json={'label': 'x'},
                       headers=bearer(token)).status_code == 401

    login(client)
    listed = client.get('/api/sync/tokens').json()
    assert len(listed) == 1 and listed[0]['active'] is True
    assert 'token' not in listed[0]

    assert client.post('/api/sync/tokens/' + listed[0]['id'] + '/revoke').status_code == 200
    assert client.get('/api/sync/status', headers=bearer(token)).status_code == 401
    assert listed[0]['prefix'] not in json.dumps(client.get('/api/sync/status',
                                                            headers=bearer(token)).json())

    # Revoking is idempotent and scoped to the owner.
    assert client.post('/api/sync/tokens/' + listed[0]['id'] + '/revoke').status_code == 200
    client.post('/api/logout')
    login(client, 'bob')
    assert client.post('/api/sync/tokens/' + listed[0]['id'] + '/revoke').status_code == 404


def test_first_submission_creates_review_only_plan_then_applies(setup):
    client, _ = setup
    login(client)
    token = mint(client)

    result = submit(client, token, package())
    assert result.status_code == 200, result.text
    body = result.json()
    assert body['status'] == 'ready'
    assert body['duplicate'] is False
    assert body['baseVersion'] == 1
    assert [c['type'] for c in body['changes']] == ['新增', '新增']
    assert body['reviewUrl'].startswith('http')

    # Nothing is written into the tree before the owner confirms.
    assert len(state(client)['snapshots']) == 1
    assert nodes(client) == []

    listed = client.get('/api/imports').json()
    assert listed[0]['channel'] == 'skill'
    assert listed[0]['submissionId'] == 'sub_test_0001'
    assert listed[0]['sync']['scope'].startswith('本轮整理范围')
    assert listed[0]['sync']['items'][0]['openQuestions']

    applied = apply(client, body['batchId'])
    assert applied.status_code == 200, applied.text
    assert applied.json()['version'] == 2
    current = nodes(client)
    assert [n['title'] for n in current] == ['依赖注入', '事务边界']
    injection = current[0]
    assert injection['level'] == 1
    assert injection['open'][0]['text'].startswith('构造函数注入')
    assert injection['recommendedNext'][0]['text'].startswith('读一遍')
    assert injection['notes'][0]['text'].startswith('依赖由外部传入')
    assert state(client)['snapshots'][-1]['sources'][0]['channel'] == 'skill'
    assert client.get('/api/sync/submissions/sub_test_0001',
                      headers=bearer(token)).json()['status'] == 'applied'


def test_second_submission_supplements_and_keeps_history(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    first = submit(client, token, package()).json()
    assert apply(client, first['batchId']).json()['version'] == 2

    second = package('sub_test_0002', baseVersion=2, items=[
        item('k2', '事务边界', understanding=['把提交放在请求收尾，仓储层不自行提交。'],
             prerequisites=['依赖注入']),
        item('k3', 'Compose 编排', layer=3, prerequisites=['k2']),
    ], fragments=[{'title': '虚构练习笔记 2.md', 'kind': 'user_original',
                   'text': '第二次虚构练习：把提交移动到服务层，并补了一个 Compose 编排的练习。'}])
    result = submit(client, token, second)
    assert result.status_code == 200, result.text
    assert [c['type'] for c in result.json()['changes']] == ['补充', '新增']

    assert apply(client, result.json()['batchId']).json()['version'] == 3
    snapshots = state(client)['snapshots']
    assert [len(s['nodes']) for s in snapshots] == [0, 2, 3]
    assert [len(s['sources']) for s in snapshots] == [0, 1, 2]
    assert snapshots[1]['sources'][0]['id'] == snapshots[2]['sources'][0]['id']
    tx = [n for n in snapshots[1]['nodes'] if n['title'] == '事务边界'][0]
    assert tx['notes'] == [] and tx['level'] == 1
    merged = [n for n in snapshots[2]['nodes'] if n['title'] == '事务边界'][0]
    assert [note['text'] for note in merged['notes']] == [
        '这是关于「事务边界」的虚构整理说明。', '把提交放在请求收尾，仓储层不自行提交。']
    assert merged['level'] == 1  # supplement never raises mastery


def test_duplicate_submission_and_reapply_are_idempotent(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    first = submit(client, token, package()).json()
    second = submit(client, token, package()).json()
    assert second['duplicate'] is True
    assert second['batchId'] == first['batchId']
    assert len(client.get('/api/imports').json()) == 1

    assert apply(client, first['batchId']).json()['version'] == 2
    again = apply(client, first['batchId'])
    assert again.status_code == 200 and again.json()['duplicate'] is True
    assert len(state(client)['snapshots']) == 2
    assert len(nodes(client)) == 2

    # Same identifier with different content after success is refused, not silently merged.
    changed = package()
    changed['items'][0]['summary'] = '完全不同的内容'
    conflict = submit(client, token, changed)
    assert conflict.status_code == 409
    assert conflict.json()['detail']['code'] == 'submission_id_conflict'


def test_invalid_relations_are_rejected_and_retry_keeps_identifier(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    broken = package(items=[item('k1', '依赖注入', prerequisites=['从未定义的能力'])])
    result = submit(client, token, broken)
    assert result.status_code == 422, result.text
    detail = result.json()['detail']
    assert detail['code'] == 'invalid_relations'
    assert '缺少节点定义' in detail['message']
    assert detail['submissionId'] == 'sub_test_0001'

    assert len(state(client)['snapshots']) == 1 and nodes(client) == []
    failed = client.get('/api/imports').json()[0]
    assert failed['status'] == 'failed' and '缺少节点定义' in failed['error']

    # Fix the package, keep the identifier.
    fixed = package(items=[item('k1', '依赖注入')])
    retry = submit(client, token, fixed)
    assert retry.status_code == 200, retry.text
    assert retry.json()['duplicate'] is False
    assert retry.json()['attempts'] == 2
    assert apply(client, retry.json()['batchId']).status_code == 200
    assert len(nodes(client)) == 1


def test_stale_base_version_never_overwrites_latest(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    first = submit(client, token, package()).json()
    apply(client, first['batchId'])

    stale = package('sub_test_0009', baseVersion=1, items=[item('k9', '陈旧提交')])
    result = submit(client, token, stale)
    assert result.status_code == 409
    detail = result.json()['detail']
    assert detail['code'] == 'stale_base_version'
    assert detail['currentVersion'] == 2 and detail['baseVersion'] == 1

    assert len(state(client)['snapshots']) == 2
    assert '陈旧提交' not in [n['title'] for n in nodes(client)]


def test_agent_cannot_declare_mastery_or_delivery(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    for field, value in [('level', 4), ('stage', '已上线'), ('mastery', 4), ('verified', True)]:
        payload = package(items=[item('k1', '依赖注入', **{field: value})])
        result = submit(client, token, payload)
        assert result.status_code == 422, (field, result.text)
        assert result.json()['detail']['code'] == 'authority_violation'
        assert any(field in path for path in result.json()['detail']['paths'])
    assert len(state(client)['snapshots']) == 1 and nodes(client) == []


def test_malformed_packages_never_touch_the_tree(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    cases = []
    broken = package(); broken.pop('scope'); cases.append(broken)
    cases.append(package(**{'formatVersion': 2}))
    cases.append(package(items=[]))
    cases.append(package(items=[item('k1', '甲'), item('k1', '乙')]))
    cases.append(package(items=[dict(item('k1', '甲'), extra='nope')]))
    cases.append(package(fragments=[{'title': '空原文', 'kind': 'user_original', 'text': '短'}]))
    for payload in cases:
        result = submit(client, token, payload)
        assert result.status_code == 422, (payload, result.text)
        assert result.json()['detail']['code'] in ('invalid_package', 'authority_violation')
    assert len(state(client)['snapshots']) == 1 and nodes(client) == []


def test_two_users_cannot_read_or_write_each_other(setup):
    client, _ = setup
    login(client)
    alice = mint(client)
    alice_batch = submit(client, alice, package()).json()
    apply(client, alice_batch['batchId'])

    client.post('/api/logout')
    login(client, 'bob')
    bob = mint(client)
    assert client.get('/api/imports').json() == []
    assert nodes(client) == []
    assert client.get('/api/sync/submissions/sub_test_0001', headers=bearer(bob)).status_code == 404

    # Bob cannot apply Alice's batch, and Alice's tree is unchanged by Bob's submission.
    assert apply(client, alice_batch['batchId']).status_code == 404
    bob_sub = submit(client, bob, package('sub_bob_0001', items=[item('k1', 'Bob 的知识')]))
    assert bob_sub.status_code == 200, bob_sub.text
    apply(client, bob_sub.json()['batchId'])
    assert [n['title'] for n in nodes(client)] == ['Bob 的知识']

    client.post('/api/logout')
    login(client, 'alice')
    assert [n['title'] for n in nodes(client)] == ['依赖注入', '事务边界']


def test_task_ticks_and_user_statement_do_not_raise_level_or_stage(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    project = package('sub_proj_0001', items=[
        item('p1', '虚构课程项目', kind='project', layer=4,
             project={'title': '虚构课程项目', 'statement': '我已经把这个项目上线了，完全掌握。'})])
    result = submit(client, token, project)
    assert result.status_code == 200, result.text
    apply(client, result.json()['batchId'])

    node = nodes(client)[0]
    assert node['kind'] == 'project'
    assert node['stage'] == '讨论'
    assert node['level'] == 0
    assert node['evidence'][-1][0] == '用户陈述（未独立验证）'

    checked = client.put('/api/progress', json={'version': 2, 'node_id': node['id'],
                                                'index': 0, 'done': True})
    assert checked.status_code == 200
    refreshed = nodes(client)[0]
    assert refreshed['stage'] == '讨论' and refreshed['level'] == 0
    assert state(client)['tasks']['v2:' + node['id'] + ':0'] is True


def test_sync_works_while_ai_analysis_stays_unavailable(setup):
    client, app = setup
    login(client)
    token = mint(client)
    assert client.get('/api/runtime').json()['aiReady'] is False

    source = client.post('/api/sources', json={
        'title': '虚构原始资料', 'text': '这是一段用于验证未配置模型行为的虚构资料。'}).json()
    assert client.post('/api/sources/' + source['id'] + '/analyze').status_code == 503

    result = submit(client, token, package())
    assert result.status_code == 200
    assert apply(client, result.json()['batchId']).status_code == 200
    assert len(nodes(client)) == 2


def test_ai_summary_fragment_is_labelled_and_source_reused(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    payload = package('sub_sum_0001', fragments=[{
        'title': '本轮对话摘要', 'kind': 'ai_summary', 'text': '',
        'note': '原文未随包提交，仅保留整理摘要'}])
    result = submit(client, token, payload)
    assert result.status_code == 200, result.text
    source = state(client)['snapshots'][-1]['sources']
    assert source == []  # still unreviewed

    apply(client, result.json()['batchId'])
    record = state(client)['snapshots'][-1]['sources'][0]
    assert record['derived'] is True
    assert record['locator'].startswith('AI 摘要')
    assert record['text'].startswith('### [AI 摘要 · 非原文]')
    assert record['text'].count('依赖注入') >= 1


def test_mixed_fragments_are_not_labelled_as_summary_only(setup):
    """混装包（原文 + 摘要）不能被打成「只提交了 AI 摘要」，否则来源标注会说谎。"""
    client, _ = setup
    login(client)
    token = mint(client)
    payload = package('sub_mixed_0001', fragments=[
        {'title': '对话原文', 'kind': 'user_original',
         'text': '这段是用户原话，用来验证混装包的来源标注是否正确。'},
        {'title': '智能体整理', 'kind': 'ai_summary', 'text': '',
         'note': '原文已随包提交'}])
    result = submit(client, token, payload)
    assert result.status_code == 200, result.text
    sync = next(row for row in client.get('/api/imports').json() if row['id'] == result.json()['batchId'])['sync']
    assert sync['summaryOnly'] is False, sync
    assert sync['mixedFragments'] is True, sync

    assert apply(client, result.json()['batchId']).status_code == 200
    record = state(client)['snapshots'][-1]['sources'][0]
    assert record['derived'] is False
    assert record['locator'] == '用户授权内容（原文 + 智能体摘要，逐段标注）', record['locator']
    assert record['text'].startswith('### [原文]')
    assert '### [AI 摘要 · 非原文]' in record['text']


def test_apply_still_requires_csrf_from_the_owner(setup):
    client, _ = setup
    login(client)
    token = mint(client)
    batch = submit(client, token, package()).json()['batchId']
    saved = client.headers.pop('X-CSRF-Token')
    assert client.post('/api/imports/' + batch + '/apply',
                       json={'acknowledge': True}).status_code == 403
    client.headers['X-CSRF-Token'] = saved
    assert apply(client, batch).status_code == 200


def test_sync_tables_are_in_the_migration_not_just_the_models(setup):
    _, app = setup
    from sqlalchemy import inspect
    schema = inspect(app.state.engine)
    assert {'sync_tokens', 'sync_submissions'} <= set(schema.get_table_names())
    assert {'token_hash', 'revoked_at', 'expires_at'} <= {
        c['name'] for c in schema.get_columns('sync_tokens')}
    assert {'submission_id', 'digest', 'batch_id', 'attempts'} <= {
        c['name'] for c in schema.get_columns('sync_submissions')}


def test_too_many_items_is_rejected_at_the_package_layer(setup):
    """KO-003 复核：包上限必须与图校验的 20 条一致，且报 invalid_package。

    之前 21–40 条能通过包校验，最后在图校验里报成含义模糊的 invalid_relations。
    """
    client, _ = setup
    login(client)
    token = mint(client)
    many = [item('k%d' % i, '虚构节点 %02d' % i) for i in range(21)]
    result = submit(client, token, package('sub_too_many', items=many))
    assert result.status_code == 422, result.text
    assert result.json()['detail']['code'] == 'invalid_package'
    paths = [p['path'] for p in result.json()['detail'].get('problems', [])]
    assert any('items' in p for p in paths)


def test_source_is_named_after_the_whole_submission(setup):
    """KO-003 复核：一次提交只有一份来源文档，标题不能拿第一个片段冒充。"""
    client, _ = setup
    login(client)
    token = mint(client)
    body = package('sub_source_title')
    assert submit(client, token, body).status_code == 200
    sources = None
    with client.app.state.sessions() as db:
        sources = db.query(Source).all()
    assert len(sources) == 1
    assert sources[0].title == body['scope'][:120]
    assert sources[0].title != body['fragments'][0]['title']

import copy
import json
from pathlib import Path
import pytest
import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable
from sqlalchemy.dialects import mysql
from backend.ai_adapter import AIAdapter, AIUnavailable
from backend.config import Settings
from backend.database import Base, Source, User, Version
from backend.knowledge import build_plan, ensure_workspace, identifier, initial_snapshot
from backend.main import create_app
from backend.manage import migrate
from backend.schemas import Extraction
from backend.security import passwords

def extraction(title='HTTP', prerequisites=None):
    return Extraction.model_validate({'nodes': [{'title': title, 'layer': 1, 'summary': '理解请求与响应，并保留来源。',
            'concepts': [['请求', '客户端发送请求，服务端返回响应。']], 'tasks': ['解释一次请求'],
            'mistakes': [['只看页面', '也要核对响应状态']], 'prerequisites': prerequisites or []}]})

class FakeAI:
    """Test-only deterministic adapter. Never imported by runtime application code."""
    def extract(self, source, snapshot):
        return extraction(source.title)
    def mentor(self, snapshot, node, question, goal):
        return {'answer': '结合来源解释请求与响应。', 'sources': [{'id': node['refs'][0], 'title': '原文'}]}

@pytest.fixture
def setup(tmp_path):
    settings = Settings('sqlite:///' + str(tmp_path/'test.db'), 'http://testserver', False,
                        'https://model.example/v1', 'test-only-key', 'test-only-model', True)
    app = create_app(settings, FakeAI())
    migrate(settings)
    with app.state.sessions() as db:
        for name in ['alice','bob']:
            u = User(id=identifier('user_'), username=name, password_hash=passwords.hash('test-only-password'))
            db.add(u); db.flush(); ensure_workspace(db,u.id)
        db.commit()
    with TestClient(app) as client:
        yield client, app
    app.state.engine.dispose()

def login(client, name='alice'):
    result=client.post('/api/login',json={'username':name,'password':'test-only-password'})
    assert result.status_code==200
    client.headers['X-CSRF-Token']=result.json()['csrf']

def add_and_analyze(client,title='HTTP',text='这是一份关于 HTTP 请求与响应的真实格式测试资料。'):
    s=client.post('/api/sources',json={'title':title,'text':text});assert s.status_code==200
    result=client.post('/api/sources/'+s.json()['id']+'/analyze');assert result.status_code==200,result.text
    return s.json()['id'],result.json()['id']

def apply(client,batch):
    result=client.post('/api/imports/'+batch+'/apply',json={'acknowledge':True})
    assert result.status_code==200,result.text
    return result

def test_auth_csrf_origin_and_logout(setup):
    client,_=setup
    assert client.get('/api/state').status_code==401
    login(client)
    csrf=client.headers.pop('X-CSRF-Token')
    assert client.patch('/api/preferences',json={'goal_text':'学习'}).status_code==403
    client.headers['X-CSRF-Token']=csrf
    assert client.patch('/api/preferences',headers={'Origin':'https://other.example'},json={'goal_text':'学习'}).status_code==403
    assert client.post('/api/logout').status_code==200
    assert client.get('/api/state').status_code==401

def test_import_apply_progress_history_and_idempotency(setup):
    client,_=setup;login(client)
    source,batch=add_and_analyze(client)
    before=client.get('/api/state').json();assert len(before['snapshots'])==1
    assert client.post('/api/imports/'+batch+'/apply',json={'acknowledge':False}).status_code==422
    apply(client,batch)
    state=client.get('/api/state').json();assert len(state['snapshots'])==2
    assert state['snapshots'][0]['nodes']==[]
    node=state['snapshots'][-1]['nodes'][0];assert node['level']==1
    assert client.put('/api/progress',json={'version':2,'node_id':node['id'],'index':0,'done':True}).status_code==200
    state=client.get('/api/state').json();assert state['tasks'][f"v2:{node['id']}:0"] is True
    assert state['snapshots'][-1]['nodes'][0]['level']==1
    assert apply(client,batch).json()['duplicate'] is True
    assert len(client.get('/api/state').json()['snapshots'])==2
    duplicate=client.post('/api/sources',json={'title':'重复资料','text':'这是一份关于 HTTP 请求与响应的真实格式测试资料。'}).json()
    assert duplicate['duplicate'] and duplicate['id']==source

def test_isolation_and_read_only_history(setup):
    client,_=setup;login(client);source,batch=add_and_analyze(client);apply(client,batch)
    node=client.get('/api/state').json()['snapshots'][-1]['nodes'][0]
    assert client.put('/api/progress',json={'version':1,'node_id':node['id'],'index':0,'done':True}).status_code==409
    client.post('/api/logout');login(client,'bob')
    assert client.get('/api/state').json()['snapshots'][-1]['nodes']==[]
    assert client.post('/api/sources/'+source+'/analyze').status_code==404
    assert client.post('/api/imports/'+batch+'/apply',json={'acknowledge':True}).status_code==404
    assert client.post('/api/mentor',json={'node_id':node['id'],'question':'解释一下'}).status_code==404

def test_stale_preview_does_not_overwrite_new_version(setup):
    client,_=setup;login(client)
    _,first=add_and_analyze(client,'HTTP','第一份关于 HTTP 的资料，使用独立正文进行测试。')
    _,second=add_and_analyze(client,'Python','第二份关于 Python 的资料，使用独立正文进行测试。')
    apply(client,first)
    assert client.post('/api/imports/'+second+'/apply',json={'acknowledge':True}).status_code==409
    assert len(client.get('/api/state').json()['snapshots'])==2

def test_missing_model_preserves_original_without_fake_results(setup):
    client,app=setup;login(client)
    app.state.settings=Settings(app.state.settings.database_url,'http://testserver',False)
    source=client.post('/api/sources',json={'title':'原始记录','text':'即使模型没有配置，这一段原始学习记录也应该被保存。'}).json()['id']
    assert client.post('/api/sources/'+source+'/analyze').status_code==503
    assert len(client.get('/api/state').json()['snapshots'])==1
    with app.state.sessions() as db:
        assert db.get(Source,source).body.startswith('即使')

def test_alias_alignment_preserves_levels_stages_and_old_snapshot():
    source=Source(id='src_test',user_id='u',title='原文',body='原文资料',digest='x',created_at=1)
    initial=initial_snapshot();initial['nodes']=[{'id':'node_old','title':'HTTP','aliases':['HTTP 协议'],
        'kind':'knowledge','level':3,'layer':1,'prereqs':[],'refs':[],'notes':[]}]
    original=copy.deepcopy(initial)
    plan=build_plan(initial,source,extraction('HTTP 协议'))
    assert initial==original
    assert len(plan['snapshot']['nodes'])==1
    assert plan['snapshot']['nodes'][0]['level']==3
    project=extraction().model_dump();project['nodes'][0].update(title='我的项目',kind='project',layer=4)
    assert build_plan(initial,source,Extraction.model_validate(project))['snapshot']['nodes'][-1]['stage']=='讨论'

def test_cycles_and_unresolved_prerequisites_rejected():
    source=Source(id='s',user_id='u',title='t',body='body',digest='x',created_at=1)
    with pytest.raises(ValueError,match='循环'):
        build_plan(initial_snapshot(),source,extraction('HTTP',['HTTP']))
    with pytest.raises(ValueError,match='缺少节点'):
        build_plan(initial_snapshot(),source,extraction('HTTP',['Unknown']))

def test_provider_adapter_is_real_http_with_validated_json():
    settings=Settings('sqlite://','http://testserver',False,'https://model.example/v1','test-key','test-model',True)
    def handler(request):
        assert request.headers['authorization']=='Bearer test-key'
        body=json.loads(request.content);assert body['response_format']=={'type':'json_object'}
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(extraction().model_dump(),ensure_ascii=False)}}]})
    ai=AIAdapter(settings,httpx.MockTransport(handler))
    assert ai.extract(Source(body='输入的资料'),initial_snapshot()).nodes[0].title=='HTTP'
    invalid=AIAdapter(settings,httpx.MockTransport(lambda r:httpx.Response(200,json={'choices':[{'message':{'content':'{"nodes":[],"level":4}'}}]})))
    with pytest.raises(AIUnavailable): invalid.extract(Source(body='资料'),initial_snapshot())

def test_runtime_login_and_static_frontend_available(setup):
    client,_=setup
    assert client.get('/api/runtime').json()['mode']=='server'
    assert client.get('/api/health').status_code==200
    assert '登录' in client.get('/login').text
    assert 'type="module"' in client.get('/').text

def test_preferences_and_task_data_survive_new_client(setup):
    client,app=setup;login(client)
    assert client.patch('/api/preferences',json={'goal_text':'独立完成后端项目','navigation_collapsed':True}).status_code==200
    with TestClient(app) as other:
        login(other)
        s=other.get('/api/state').json();assert s['goalText']=='独立完成后端项目' and s['navigationCollapsed'] is True

def test_migration_schema_matches_models_and_compiles_for_mysql(setup):
    _,app=setup
    schema=inspect(app.state.engine)
    for name,table in Base.metadata.tables.items():
        assert {c['name'] for c in schema.get_columns(name)}==set(table.columns.keys())
        assert 'CREATE TABLE' in str(CreateTable(table).compile(dialect=mysql.dialect()))

def test_state_survives_application_restart(setup):
    client,app=setup;login(client)
    _,batch=add_and_analyze(client);apply(client,batch)
    restarted=create_app(app.state.settings,FakeAI())
    with TestClient(restarted) as new_client:
        login(new_client)
        assert len(new_client.get('/api/state').json()['snapshots'])==2
    restarted.state.engine.dispose()

def test_private_files_are_not_statically_served(setup):
    client,_=setup
    for path in ['/.env','/backend/config.py','/compose.yaml','/.secrets/admin_password']:
        assert client.get(path).status_code==404

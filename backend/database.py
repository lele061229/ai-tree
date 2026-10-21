import time
from fastapi import Request
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from sqlalchemy import JSON, Integer, String, Text, UniqueConstraint, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = 'users'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))

class SessionRecord(Base):
    __tablename__ = 'sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    csrf: Mapped[str] = mapped_column(String(64))
    expires: Mapped[int] = mapped_column(Integer, index=True)

class LoginBucket(Base):
    __tablename__ = 'login_buckets'
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)
    reset_at: Mapped[int] = mapped_column(Integer)

class Workspace(Base):
    __tablename__ = 'workspaces'
    user_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)

class Version(Base):
    __tablename__ = 'route_versions'
    user_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    number: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

class Source(Base):
    __tablename__ = 'source_documents'
    __table_args__ = (UniqueConstraint('user_id', 'digest', name='uq_source_owner_digest'),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text().with_variant(MEDIUMTEXT(), 'mysql'))
    digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

class KnowledgeNode(Base):
    __tablename__ = 'knowledge_nodes'
    user_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    canonical_name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(20))
    evidence_level: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)

class KnowledgeEdge(Base):
    __tablename__ = 'knowledge_edges'
    user_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    source_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    target_id: Mapped[str] = mapped_column(String(80), primary_key=True)

class ImportBatch(Base):
    __tablename__ = 'import_batches'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    source_id: Mapped[str] = mapped_column(String(40))
    base_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20))
    plan: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

class SyncToken(Base):
    """Scoped, revocable credential for one user's agent-side submission channel.

    Only the SHA-256 digest of the bearer token is stored. Scope is fixed to submission
    intake: a token can never read the workspace, apply a plan, or act as a session.
    """
    __tablename__ = 'sync_tokens'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    label: Mapped[str] = mapped_column(String(80))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    last_used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[int] = mapped_column(Integer)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

class SyncSubmission(Base):
    """Idempotency and audit record for one agent-submitted learning package."""
    __tablename__ = 'sync_submissions'
    __table_args__ = (UniqueConstraint('user_id', 'submission_id', name='uq_sync_user_submission'),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    submission_id: Mapped[str] = mapped_column(String(80))
    digest: Mapped[str] = mapped_column(String(64))
    batch_id: Mapped[str] = mapped_column(String(40))
    format_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20))
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    updated_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

class Progress(Base):
    __tablename__ = 'learning_progress'
    user_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    node_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    task_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    done: Mapped[bool] = mapped_column(default=False)

def _is_memory_sqlite(url):
    return url == 'sqlite://' or ':memory:' in url or 'mode=memory' in url

def make_database(url):
    options = {'pool_pre_ping': True}
    if url.startswith('sqlite'):
        if _is_memory_sqlite(url):
            # 内存库（测试用）：所有线程必须共享同一个连接才有数据。
            options.update(connect_args={'check_same_thread': False}, poolclass=StaticPool)
        else:
            # 文件库（桌面版本地数据）：StaticPool 的单连接在多线程并发写时会
            # 触发 sqlite3 "bad parameter or other API misuse"。改用连接池里的
            # 独立连接 + WAL，并发写由 busy_timeout 排队串行化。
            options.update(connect_args={'check_same_thread': False, 'timeout': 30})
    engine = create_engine(url, **options)
    if url.startswith('sqlite') and not _is_memory_sqlite(url):
        @event.listens_for(engine, 'connect')
        def _sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute('PRAGMA journal_mode=WAL')
            cursor.execute('PRAGMA busy_timeout=30000')
            cursor.execute('PRAGMA synchronous=NORMAL')
            cursor.close()
    return engine, sessionmaker(engine, expire_on_commit=False)

def get_db(request: Request):
    with request.app.state.sessions() as db:
        yield db

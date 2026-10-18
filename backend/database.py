import time
from fastapi import Request
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from sqlalchemy import JSON, Integer, String, Text, UniqueConstraint, create_engine
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

class Progress(Base):
    __tablename__ = 'learning_progress'
    user_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    node_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    task_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    done: Mapped[bool] = mapped_column(default=False)

def make_database(url):
    options = {'pool_pre_ping': True}
    if url.startswith('sqlite'):
        options.update(connect_args={'check_same_thread': False}, poolclass=StaticPool)
    engine = create_engine(url, **options)
    return engine, sessionmaker(engine, expire_on_commit=False)

def get_db(request: Request):
    with request.app.state.sessions() as db:
        yield db

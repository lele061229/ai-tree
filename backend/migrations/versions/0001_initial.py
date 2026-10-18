"""Initial immutable-source, graph and route-history schema."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import MEDIUMTEXT

revision = '0001_initial'
down_revision = None

def upgrade():
    # This revision is intentionally self-contained; future model changes do not alter this migration.
    op.create_table('users', sa.Column('id', sa.String(40), primary_key=True), sa.Column('username', sa.String(80), unique=True, nullable=False), sa.Column('password_hash', sa.String(255), nullable=False))
    op.create_table('sessions', sa.Column('token_hash', sa.String(64), primary_key=True), sa.Column('user_id', sa.String(40), nullable=False, index=True), sa.Column('csrf', sa.String(64), nullable=False), sa.Column('expires', sa.Integer, nullable=False, index=True))
    op.create_table('login_buckets', sa.Column('key', sa.String(64), primary_key=True), sa.Column('count', sa.Integer, nullable=False), sa.Column('reset_at', sa.Integer, nullable=False))
    op.create_table('workspaces', sa.Column('user_id', sa.String(40), primary_key=True), sa.Column('current_version', sa.Integer, nullable=False), sa.Column('preferences', sa.JSON, nullable=False))
    op.create_table('route_versions', sa.Column('user_id', sa.String(40), primary_key=True), sa.Column('number', sa.Integer, primary_key=True), sa.Column('snapshot', sa.JSON, nullable=False), sa.Column('created_at', sa.Integer, nullable=False))
    op.create_table('source_documents', sa.Column('id', sa.String(40), primary_key=True), sa.Column('user_id', sa.String(40), nullable=False, index=True), sa.Column('title', sa.String(160), nullable=False), sa.Column('body', sa.Text().with_variant(MEDIUMTEXT(), 'mysql'), nullable=False), sa.Column('digest', sa.String(64), nullable=False), sa.Column('created_at', sa.Integer, nullable=False), sa.UniqueConstraint('user_id','digest',name='uq_source_owner_digest'))
    op.create_table('knowledge_nodes', sa.Column('user_id', sa.String(40), primary_key=True), sa.Column('id', sa.String(80), primary_key=True), sa.Column('canonical_name', sa.String(160), nullable=False), sa.Column('kind', sa.String(20), nullable=False), sa.Column('evidence_level', sa.Integer, nullable=False), sa.Column('payload', sa.JSON, nullable=False))
    op.create_table('knowledge_edges', sa.Column('user_id', sa.String(40), primary_key=True), sa.Column('source_id', sa.String(80), primary_key=True), sa.Column('target_id', sa.String(80), primary_key=True))
    op.create_table('import_batches', sa.Column('id', sa.String(40), primary_key=True), sa.Column('user_id', sa.String(40), nullable=False, index=True), sa.Column('source_id', sa.String(40), nullable=False), sa.Column('base_version', sa.Integer, nullable=False), sa.Column('status', sa.String(20), nullable=False), sa.Column('plan', sa.JSON), sa.Column('error', sa.String(300)), sa.Column('created_at', sa.Integer, nullable=False))
    op.create_table('learning_progress', sa.Column('user_id', sa.String(40), primary_key=True), sa.Column('version', sa.Integer, primary_key=True), sa.Column('node_id', sa.String(80), primary_key=True), sa.Column('task_index', sa.Integer, primary_key=True), sa.Column('done', sa.Boolean, nullable=False))

def downgrade():
    raise RuntimeError('Initial production schema downgrade is disabled; restore a tested backup instead.')

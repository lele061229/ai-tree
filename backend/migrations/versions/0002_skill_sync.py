"""Scoped agent-sync credentials and idempotent submission records."""
from alembic import op
import sqlalchemy as sa

revision = '0002_skill_sync'
down_revision = '0001_initial'

def upgrade():
    op.create_table(
        'sync_tokens',
        sa.Column('id', sa.String(40), primary_key=True),
        sa.Column('user_id', sa.String(40), nullable=False),
        sa.Column('label', sa.String(80), nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False, unique=True),
        sa.Column('prefix', sa.String(20), nullable=False),
        sa.Column('created_at', sa.Integer, nullable=False),
        sa.Column('last_used_at', sa.Integer),
        sa.Column('expires_at', sa.Integer, nullable=False),
        sa.Column('revoked_at', sa.Integer),
    )
    op.create_index('ix_sync_tokens_user_id', 'sync_tokens', ['user_id'])
    op.create_table(
        'sync_submissions',
        sa.Column('id', sa.String(40), primary_key=True),
        sa.Column('user_id', sa.String(40), nullable=False),
        sa.Column('submission_id', sa.String(80), nullable=False),
        sa.Column('digest', sa.String(64), nullable=False),
        sa.Column('batch_id', sa.String(40), nullable=False),
        sa.Column('format_version', sa.Integer, nullable=False),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('error', sa.String(300)),
        sa.Column('attempts', sa.Integer, nullable=False),
        sa.Column('created_at', sa.Integer, nullable=False),
        sa.Column('updated_at', sa.Integer, nullable=False),
        sa.UniqueConstraint('user_id', 'submission_id', name='uq_sync_user_submission'),
    )
    op.create_index('ix_sync_submissions_user_id', 'sync_submissions', ['user_id'])

def downgrade():
    raise RuntimeError('Schema downgrade is disabled; restore a tested backup instead.')

from alembic import context
from backend.config import Settings
from backend.database import Base, make_database

settings = context.config.attributes.get('settings') or Settings.from_env()
engine, _ = make_database(settings.database_url)
with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()
engine.dispose()

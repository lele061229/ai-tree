FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY backend/requirements.lock /app/backend/requirements.lock
RUN pip install --no-cache-dir -r /app/backend/requirements.lock && useradd --uid 10001 --create-home appuser
COPY backend /app/backend
COPY dist /app/dist
COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
USER 10001
EXPOSE 8000
CMD ["sh", "/app/deploy/entrypoint.sh"]

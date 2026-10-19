FROM python:3.12-slim
# 镜像要能反查"这是哪一份代码构建的"：tag 只有版本号，commit 放 OCI label。
# 构建时传 --build-arg APP_COMMIT=<full sha>，用 docker inspect 读回（见 INSTALL-UPGRADE.md §2）。
ARG APP_VERSION=0.3.1
ARG APP_COMMIT=unknown
LABEL org.opencontainers.image.title="AI Tree" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}"
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

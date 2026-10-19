from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from .config import ROOT, Settings
from .database import make_database
from .ai_adapter import AIAdapter
from .routers import auth, workspace, imports, mentor, sync

def create_app(settings=None, ai=None):
    settings = settings or Settings.from_env()
    app = FastAPI(title='AI Knowledge OS', version='0.3.1', docs_url=None, redoc_url=None, openapi_url=None)
    engine, sessions = make_database(settings.database_url)
    app.state.engine, app.state.sessions, app.state.settings = engine, sessions, settings
    app.state.ai = ai or AIAdapter(settings)

    @app.middleware('http')
    async def headers(request: Request, call_next):
        try:
            length = int(request.headers.get('content-length', '0'))
        except ValueError:
            return JSONResponse({'detail': '无效的请求长度'}, status_code=400)
        if length > 400000:
            return JSONResponse({'detail': '请求内容过大'}, status_code=413)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        if request.url.path.startswith('/api/') or request.url.path == '/login':
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/api/runtime')
    def runtime():
        return {'mode': 'server', 'aiReady': settings.ai_ready}

    @app.get('/api/health')
    def health():
        try:
            with engine.connect() as c:
                c.execute(text('SELECT 1'))
            return {'status': 'ok'}
        except Exception:
            return JSONResponse({'status': 'unavailable'}, status_code=503)

    @app.get('/login')
    def login_page():
        return FileResponse(ROOT / 'dist' / 'login.html')

    for router in (auth.router, workspace.router, imports.router, mentor.router, sync.router):
        app.include_router(router)
    app.mount('/', StaticFiles(directory=ROOT / 'dist', html=True), name='frontend')
    return app

# Factory mode is used by tests and CLI. Uvicorn uses --factory backend.main:create_app.

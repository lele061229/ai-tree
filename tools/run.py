import os
import subprocess
import sys

PROXY = os.environ.get('KO_PROXY', 'http://127.0.0.1:6789')
out_path, cwd, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]
env = dict(os.environ)
for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    env[k] = PROXY
env['GIT_TERMINAL_PROMPT'] = '0'
p = subprocess.run(cmd, cwd=cwd, capture_output=True, env=env)
open(out_path, 'w', encoding='utf-8').write(
    f'CMD: {cmd}\nEXIT: {p.returncode}\n--- STDOUT ---\n{p.stdout.decode("utf-8", "replace")}'
    f'\n--- STDERR ---\n{p.stderr.decode("utf-8", "replace")}\n')
sys.exit(p.returncode)

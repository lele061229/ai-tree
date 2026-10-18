"""Package the committed source and complete local Git history, never local secrets/data."""
import argparse
import hashlib
import json
import io
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def add_bytes(archive, name, payload):
    if isinstance(archive, zipfile.ZipFile):
        archive.writestr(name, payload)
    else:
        item = tarfile.TarInfo(name)
        item.size, item.mode = len(payload), 0o644
        archive.addfile(item, io.BytesIO(payload))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    if git('status','--porcelain').strip():
        raise SystemExit('Working tree must be committed before packaging')
    commit=git('rev-parse','HEAD').decode().strip()
    destination=args.output.resolve()
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        archive=Path(directory)/'source.zip'
        archive.write_bytes(git('archive','--format=zip','HEAD'))
        bundle=Path(directory)/'knowledge-os-history.bundle'
        subprocess.run(['git','bundle','create',str(bundle),'--all'],cwd=ROOT,check=True,capture_output=True)
        output_archive = (tarfile.open(destination, 'w:gz') if destination.name.endswith('.tar.gz')
                          else zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED))
        with zipfile.ZipFile(archive) as source, output_archive as out:
            checksums={}
            for item in source.infolist():
                if item.is_dir():continue
                if item.filename.startswith(('.secrets/','.env','backups/')):
                    raise SystemExit('Unexpected sensitive path in tracked source')
                payload=source.read(item.filename)
                add_bytes(out,'knowledge-os/'+item.filename,payload)
                checksums[item.filename]=hashlib.sha256(payload).hexdigest()
            add_bytes(out,'knowledge-os-history.bundle',bundle.read_bytes())
            add_bytes(out,'DEPLOYMENT_MANIFEST.json',json.dumps({'commit':commit,'files':checksums,'git_bundle_sha256':hashlib.sha256(bundle.read_bytes()).hexdigest()},indent=2).encode())
            add_bytes(out,'START_HERE.txt','完整源码位于 knowledge-os/。先阅读 docs/SELF_HOSTING.md。\n完整 Git 历史在 knowledge-os-history.bundle，可执行 git clone knowledge-os-history.bundle source-with-history 恢复仓库。\n部署包不包含密钥、账号密码或用户数据库。部署前需核对目标服务器。\n'.encode())
    print(json.dumps({'path':str(destination),'commit':commit,'bytes':destination.stat().st_size}))

if __name__=='__main__':main()
